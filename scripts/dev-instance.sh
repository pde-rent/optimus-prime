#!/usr/bin/env bash
# Start a standalone Optimus Prime instance built from the current working tree.
#
# The instance owns a dedicated agent state directory and daemon socket under
# a temp directory (overridable with OPTIMUS_DEV_INSTANCE_DIR). Stop commands
# only ever signal processes owned by this user that positively identify
# themselves on the command line as an optimus daemon bound to a known optimus
# socket, so ~/.optimus defaults and unrelated processes are untouched.
set -euo pipefail

# If this script runs inside an Optimus-managed process, its environment carries
# OPTIMUS_INTERNAL_DAEMON_WORKER* markers that would make the spawned instance
# boot as a worker instead of a standalone supervisor. Strip them.
for v in $(compgen -e | grep '^OPTIMUS_INTERNAL_' || true); do
	unset "$v"
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO_ROOT/packages/coding-agent/src/cli.ts"
DEFAULT_TMP="${TMPDIR:-/tmp}"; DEFAULT_TMP="${DEFAULT_TMP%/}"
STATE_DIR="${OPTIMUS_DEV_INSTANCE_DIR:-$DEFAULT_TMP/optimus-dev-instance-$(id -u 2>/dev/null || echo user)}"
AGENT_DIR="$STATE_DIR/agent"
SOCKET="$STATE_DIR/daemon.sock"
LOG="$STATE_DIR/daemon.log"
PID_FILE="$STATE_DIR/daemon.pid"
MAIN_SOCKET="$DEFAULT_TMP/optimus-$(id -u 2>/dev/null || echo user)/daemon.sock"

usage() {
	cat <<'EOF'
Usage: scripts/dev-instance.sh <command>

  start             Replace any previous dev instance and start a new detached one
  start --attached  Run the daemon in the foreground of this shell; it dies
                    with the shell (signals forwarded, parent-exit watched)
  stop              Shut the dev instance down (state is kept)
  status            Show whether it is running and how to address it
  cli [--]          Run this tree's CLI against the dev instance
  destroy           Stop the dev instance and delete all of its state
  kill-all          Gracefully stop every dev instance this user owns and,
                    if running, the main daemon

Environment: OPTIMUS_DEV_INSTANCE_DIR overrides the state directory.
EOF
}

# Public commands that route to the internal daemon client; they accept
# --daemon-socket after the subcommand token.
DAEMON_CLIENT_SUBCOMMANDS="list|stop|rename|send|schedule"

recorded_pid() {
	local pid
	pid="$(cat "$PID_FILE" 2>/dev/null || true)"
	[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && printf '%s' "$pid"
}

alive() {
	[ -S "$SOCKET" ] || return 1
	OPTIMUS_CODING_AGENT_DIR="$AGENT_DIR" bun "$CLI" list --daemon-socket "$SOCKET" >/dev/null 2>&1
}

# --- kill-all machinery ------------------------------------------------------
#
# Identification rules: a pid may only be signalled when
#   1. it is owned by this user, and
#   2. its own command line says "--mode daemon --daemon-socket <this socket>".
# The socket itself must belong to this user. SIGTERM only, never SIGKILL.

socket_owned_by_current_user() {
	local uid
	uid="$(stat -f '%u' "$1" 2>/dev/null || stat -c '%u' "$1" 2>/dev/null)" || return 1
	[ "$uid" = "$(id -u 2>/dev/null)" ]
}

daemon_pid_for_socket() {
	local sock="$1" pid="$2" uid cmd
	case "$pid" in
		'' | *[!0-9]*) return 1 ;;
	esac
	uid="$(ps -o uid= -p "$pid" 2>/dev/null | tr -d ' ')" || return 1
	{ [ -n "$uid" ] && [ "$uid" = "$(id -u 2>/dev/null)" ]; } || return 1
	cmd="$(ps -o command= -p "$pid" 2>/dev/null)" || return 1
	case "$cmd" in
		*--mode\ daemon*) ;;
		*) return 1 ;;
	esac
	case "$cmd" in
		*"--daemon-socket $sock" | *"--daemon-socket $sock "*) ;;
		*) return 1 ;;
	esac
	printf '%s\n' "$pid"
}

# Every pid currently claiming a socket: the recorded pid (revalidated against
# its command line) plus a process-table sweep, deduplicated.
daemon_pids_for_socket() {
	local sock="$1" pidfile="${2:-}" found="" pid cand
	pid="$(cat "$pidfile" 2>/dev/null || true)"
	if [ -n "$pid" ] && cand="$(daemon_pid_for_socket "$sock" "$pid")"; then
		found="$cand"
	fi
	while read -r pid _rest; do
		[ -n "$pid" ] || continue
		cand="$(daemon_pid_for_socket "$sock" "$pid")" || continue
		printf '%s\n' "$found" | grep -qx "$cand" || found="${found:+$found
}$cand"
	done <<EOF
$(ps -eo uid=,pid=,command= 2>/dev/null | awk -v uid="$(id -u 2>/dev/null)" -v s="--daemon-socket $sock" '$1 == uid && index($0, s) && /--mode daemon/ {print $2}')
EOF
	[ -n "$found" ] && printf '%s\n' "$found"
	return 0
}

stop_daemons_at_socket() {
	local label="$1" sock="$2" pidfile="${3:-}" pid pids first_pids i
	if ! socket_owned_by_current_user "$sock"; then
		if [ -e "$sock" ]; then
			echo "$label: socket not owned by this user, skipped ($sock)" >&2
			return 1
		fi
		echo "$label: not running ($sock)"
		return 0
	fi
	first_pids="$(daemon_pids_for_socket "$sock" "$pidfile")"
	if [ -z "$first_pids" ]; then
		if [ -e "$sock" ]; then
			echo "$label: stale socket with no running daemon ($sock)"
			[ -n "$pidfile" ] && rm -f "$pidfile"
		else
			echo "$label: not running ($sock)"
		fi
		return 0
	fi
	for pid in $first_pids; do
		kill -TERM "$pid" 2>/dev/null || true
	done
	for i in $(seq 1 100); do
		[ -z "$(daemon_pids_for_socket "$sock" "$pidfile")" ] && break
		sleep 0.1
	done
	pids="$(daemon_pids_for_socket "$sock" "$pidfile")"
	if [ -n "$pids" ]; then
		echo "$label: daemon did not exit after SIGTERM (pid(s) $(echo $pids | tr '\n' ' '))" >&2
		return 1
	fi
	[ -n "$pidfile" ] && rm -f "$pidfile"
	echo "$label: stopped daemon on $sock (pid(s) $(echo $first_pids | tr '\n' ' '))"
}

cmd_kill_all() {
	local rc=0 dir main_sock seen=" "
	local dirs=()
	[ -d "$STATE_DIR" ] && dirs+=("$STATE_DIR")
	for dir in "$DEFAULT_TMP"/optimus-dev-instance-*; do
		[ -d "$dir" ] || continue
		case "$seen" in
			*" $dir "*) continue ;;
		esac
		seen="$seen$dir "
		dirs+=("$dir")
	done
	# Also catch running instances whose state dir was named freely via
	# OPTIMUS_DEV_INSTANCE_DIR: find them by their claimed socket path.
	while read -r sock; do
		[ -n "$sock" ] || continue
		case "$sock" in
			*optimus-dev-instance-*) ;;
			*) continue ;;
		esac
		dir="$(dirname "$sock")"
		[ -d "$dir" ] || continue
		case "$seen" in
			*" $dir "*) continue ;;
		esac
		seen="$seen$dir "
		dirs+=("$dir")
	done <<EOF
$(ps -eo uid=,command= 2>/dev/null | awk -v uid="$(id -u 2>/dev/null)" '$1 == uid && /--mode daemon/ {for (i = 2; i <= NF; i++) if ($i == "--daemon-socket") print $(i + 1)}')
EOF
	for dir in ${dirs[@]+"${dirs[@]}"}; do
		[ -e "$dir/daemon.sock" ] || continue
		stop_daemons_at_socket "dev instance $dir" "$dir/daemon.sock" "$dir/daemon.pid" || rc=1
	done
	main_sock="$MAIN_SOCKET"
	if [ -e "$main_sock" ]; then
		stop_daemons_at_socket "main daemon" "$main_sock" "" || rc=1
	else
		echo "main daemon: not running ($main_sock)"
	fi
	return $rc
}

stop_instance() {
	local pid listener i
	if pid="$(recorded_pid)"; then
		kill -TERM "$pid" 2>/dev/null || true
	elif [ -S "$SOCKET" ] && listener="$(lsof -t "$SOCKET" 2>/dev/null | head -1)" && [ -n "$listener" ]; then
		kill -TERM "$listener" 2>/dev/null || true
	fi
	for i in $(seq 1 100); do
		alive || break
		sleep 0.1
	done
	if alive; then
		echo "Error: dev instance did not stop cleanly" >&2
		exit 1
	fi
	rm -f "$PID_FILE"
}

await_ready_or_fail() {
	local i
	for i in $(seq 1 120); do
		alive && return 0
		if ! kill -0 "$1" 2>/dev/null; then
			echo "Error: dev instance exited during startup; log tail:" >&2
			tail -20 "$LOG" >&2
			rm -f "$PID_FILE"
			exit 1
		fi
		sleep 0.25
	done
	echo "Error: dev instance not reachable after timeout; log tail:" >&2
	tail -20 "$LOG" >&2
	rm -f "$PID_FILE"
	exit 1
}

launch_detached() {
	OPTIMUS_CODING_AGENT_DIR="$AGENT_DIR" nohup bun "$CLI" --mode daemon --daemon-socket "$SOCKET" >>"$LOG" 2>&1 &
	local pid=$!
	disown || true
	printf '%s\n' "$pid" >"$PID_FILE"

	await_ready_or_fail "$pid"
	cmd_status
	echo
	echo "Stop it:"
	echo "  $REPO_ROOT/scripts/dev-instance.sh stop"
}

run_attached() {
	local pid orig_ppid now_ppid
	orig_ppid="$(ps -o ppid= -p $$ | tr -d ' ')"

	OPTIMUS_CODING_AGENT_DIR="$AGENT_DIR" bun "$CLI" --mode daemon --daemon-socket "$SOCKET" >>"$LOG" 2>&1 &
	pid=$!
	printf '%s\n' "$pid" >"$PID_FILE"

	_forward_signal_to_daemon() {
		kill -TERM "$pid" 2>/dev/null || true
	}
	trap _forward_signal_to_daemon INT TERM HUP

	await_ready_or_fail "$pid"
	echo "Dev instance running attached on $SOCKET (pid $pid, log $LOG)."
	echo "It stops when this shell exits, or press Ctrl-C to stop it now."

	# Stay in the foreground. Exit once the daemon exits, this script receives
	# INT/TERM/HUP (forwarded above), or the parent shell is gone (detected via
	# reparenting), so the daemon never outlives the caller.
	while kill -0 "$pid" 2>/dev/null; do
		now_ppid="$(ps -o ppid= -p $$ 2>/dev/null | tr -d ' ')"
		if [ -z "$now_ppid" ] || [ "$now_ppid" != "$orig_ppid" ]; then
			echo "Parent shell gone; stopping dev instance" >&2
			break
		fi
		sleep 0.5
	done
	trap - INT TERM HUP
	if kill -0 "$pid" 2>/dev/null; then
		kill -TERM "$pid" 2>/dev/null || true
	fi
	wait "$pid" 2>/dev/null || true
	rm -f "$PID_FILE"
	echo "Dev instance stopped ($SOCKET)"
}

cmd_start() {
	local attached=0
	if [ "${1:-}" = "--attached" ]; then
		attached=1
		shift
	fi
	if [ $# -gt 0 ]; then
		echo "Error: unknown argument for start: $1" >&2
		usage >&2
		exit 1
	fi
	mkdir -p "$AGENT_DIR"
	if alive || [ -n "$(recorded_pid)" ]; then
		echo "Replacing previous dev instance on $SOCKET"
		stop_instance
	fi
	if [ "$attached" -eq 1 ]; then
		run_attached
	else
		launch_detached
	fi
}

cmd_status() {
	if ! alive; then
		echo "Dev instance not running ($SOCKET)"
		return 1
	fi
	echo "Dev instance running."
	echo "  Agent dir: $AGENT_DIR"
	echo "  Socket:    $SOCKET"
	echo "  Log:       $LOG"
	echo
	echo "Address it (all of these use the isolated state):"
	echo "  $REPO_ROOT/scripts/dev-instance.sh cli list"
	echo "  $REPO_ROOT/scripts/dev-instance.sh cli --print -p 'hello'"
	echo "  $REPO_ROOT/scripts/dev-instance.sh cli   # interactive TUI against this instance"
}

run_cli() {
	shift
	[ "${1:-}" = "--" ] && shift
	local first="${1:-}"
	case "$first" in
		"")
			usage >&2
			exit 1
			;;
		list|stop|rename|send|schedule)
			set -- "$1" --daemon-socket "$SOCKET" "${@:2}"
			;;
		*)
			set -- --daemon-socket "$SOCKET" "$@"
			;;
	esac
	OPTIMUS_CODING_AGENT_DIR="$AGENT_DIR" exec bun "$CLI" "$@"
}

case "${1:-}" in
	start)
		shift
		cmd_start "$@"
		;;
	stop)
		stop_instance
		echo "Dev instance stopped ($SOCKET)"
		;;
	status)
		cmd_status
		;;
	cli)
		run_cli "$@"
		;;
	destroy)
		stop_instance || true
		rm -rf "$STATE_DIR"
		echo "Removed $STATE_DIR"
		;;
	kill-all)
		cmd_kill_all
		;;
	*)
		usage
		exit 1
		;;
esac
