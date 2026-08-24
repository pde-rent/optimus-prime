#!/usr/bin/env bash
# Start a standalone Optimus Prime instance built from the current working tree.
#
# The instance owns a dedicated agent state directory and daemon socket under
# a temp directory (overridable with OPTIMUS_DEV_INSTANCE_DIR). It only ever
# signals the PID recorded in .dev-instance/daemon.pid or processes listening
# on its own socket, so ~/.optimus defaults and the default daemon are untouched.
set -euo pipefail

# If this script runs inside an Optimus-managed process, its environment carries
# OPTIMUS_INTERNAL_DAEMON_WORKER* markers that would make the spawned instance
# boot as a worker instead of a standalone supervisor. Strip them.
for v in $(compgen -e | grep '^OPTIMUS_INTERNAL_' || true); do
	unset "$v"
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO_ROOT/packages/coding-agent/src/cli.ts"
STATE_DIR="${OPTIMUS_DEV_INSTANCE_DIR:-${TMPDIR:-/tmp}/optimus-dev-instance-$(id -u 2>/dev/null || echo user)}"
AGENT_DIR="$STATE_DIR/agent"
SOCKET="$STATE_DIR/daemon.sock"
LOG="$STATE_DIR/daemon.log"
PID_FILE="$STATE_DIR/daemon.pid"

usage() {
	cat <<'EOF'
Usage: scripts/dev-instance.sh <command>

  start     Replace any previous dev instance and start a new one
  stop      Shut the dev instance down (state is kept)
  status    Show whether it is running and how to address it
  cli [--]  Run this tree's CLI against the dev instance
  destroy   Stop the dev instance and delete all of its state

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

cmd_start() {
	mkdir -p "$AGENT_DIR"
	if alive || [ -n "$(recorded_pid)" ]; then
		echo "Replacing previous dev instance on $SOCKET"
		stop_instance
	fi
	OPTIMUS_CODING_AGENT_DIR="$AGENT_DIR" nohup bun "$CLI" --mode daemon --daemon-socket "$SOCKET" >>"$LOG" 2>&1 &
	local pid=$!
	disown || true
	printf '%s
' "$pid" >"$PID_FILE"

	local i
	for i in $(seq 1 120); do
		alive && break
		if ! kill -0 "$pid" 2>/dev/null; then
			echo "Error: dev instance exited during startup; log tail:" >&2
			tail -20 "$LOG" >&2
			exit 1
		fi
		sleep 0.25
	done
	if ! alive; then
		echo "Error: dev instance not reachable after timeout; log tail:" >&2
		tail -20 "$LOG" >&2
		exit 1
	fi
	cmd_status
	echo
	echo "Stop it:"
	echo "  $REPO_ROOT/scripts/dev-instance.sh stop"
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
	*)
		usage
		exit 1
		;;
esac
