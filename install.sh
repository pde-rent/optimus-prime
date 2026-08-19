#!/bin/sh

set -eu

# Keep these sentinels split so release publishing only rewrites the configured
# values below; local or unpublished copies still need unreplaced values to compare.
optimus_unconfigured_base_url="__OPTIMUS_DOWNLOAD_BASE""_URL__"
optimus_unconfigured_default_release_channel="__OPTIMUS_DEFAULT_RELEASE_""CHANNEL__"
optimus_base_url="${OPTIMUS_DOWNLOAD_BASE_URL:-__OPTIMUS_DOWNLOAD_BASE_URL__}"
optimus_base_url="${optimus_base_url%/}"
optimus_default_release_channel="__OPTIMUS_DEFAULT_RELEASE_CHANNEL__"
if [ "$optimus_default_release_channel" = "$optimus_unconfigured_default_release_channel" ]; then
	optimus_default_release_channel=stable
fi
optimus_release_channel="${OPTIMUS_RELEASE_CHANNEL:-$optimus_default_release_channel}"
optimus_package="${OPTIMUS_PACKAGE:-optimus}"
optimus_cmd="${OPTIMUS_CMD:-optimus}"
optimus_esc=$(printf '\033')
optimus_original_path="${PATH:-}"
optimus_reset="${optimus_esc}[0m"
optimus_bold="${optimus_esc}[1m"
optimus_italic="${optimus_esc}[3m"
optimus_hide_cursor="${optimus_esc}[?25l"
optimus_show_cursor="${optimus_esc}[?25h"
optimus_home_cursor="${optimus_esc}[H"
optimus_clear_screen="${optimus_esc}[2J${optimus_esc}[H"
optimus_clear_line="${optimus_esc}[K"
optimus_sync_start="${optimus_esc}[?2026h"
optimus_sync_end="${optimus_esc}[?2026l"
optimus_color_text="${optimus_esc}[38;2;244;244;245m"
optimus_color_muted="${optimus_esc}[38;2;161;161;170m"
optimus_color_dim="${optimus_esc}[38;2;113;113;122m"
optimus_color_primary="${optimus_esc}[38;2;127;91;213m"
optimus_color_scan="${optimus_esc}[38;2;14;165;233m"
optimus_color_warning="${optimus_esc}[38;2;245;158;11m"
readonly optimus_unconfigured_base_url optimus_unconfigured_default_release_channel optimus_base_url optimus_default_release_channel optimus_release_channel optimus_package optimus_cmd optimus_esc optimus_original_path
readonly optimus_reset optimus_bold optimus_italic optimus_hide_cursor optimus_show_cursor optimus_home_cursor optimus_clear_screen optimus_clear_line
readonly optimus_sync_start optimus_sync_end
readonly optimus_color_text optimus_color_muted optimus_color_dim optimus_color_primary optimus_color_scan optimus_color_warning

optimus_screen_enabled=0
optimus_screen_frame=0
optimus_screen_cols=80
optimus_screen_rows=24
optimus_screen_drawn=0
optimus_screen_last_cols=0
optimus_screen_last_rows=0
optimus_screen_layout_ready=0
optimus_screen_layout_show_logo=0
optimus_screen_layout_lab_width=0
optimus_screen_render_lab_width=0
optimus_screen_compact=0
optimus_download_dir=
optimus_screen_title=
optimus_screen_status=
optimus_screen_detail=
optimus_screen_question=
optimus_animation_frame=0

main() {
	if [ "$optimus_base_url" = "$optimus_unconfigured_base_url" ]; then
		printf 'error: installer download URL is not configured.\n' >&2
		printf 'Set OPTIMUS_DOWNLOAD_BASE_URL or use the installer published by the release workflow.\n' >&2
		exit 1
	fi

	optimus_install_traps
	optimus_init_screen
	if [ "$optimus_screen_enabled" = 1 ]; then
		optimus_screen "Installing Optimus Prime" "" "" ""
	else
		printf '\n\033[1m  Installing Optimus Prime\033[0m\n\033[2m  bun global install\033[0m\n\n'
	fi

	start_preflight_checks

	if finish_preflight_checks; then
		check_status=0
	else
		check_status=$?
	fi

	if [ "$check_status" -ne 0 ]; then
		if ! install_bun_interactive; then
			exit "$check_status"
		fi

		start_preflight_checks
		if finish_preflight_checks; then
			check_status=0
		else
			check_status=$?
		fi

		if [ "$check_status" -ne 0 ]; then
			exit "$check_status"
		fi
	fi

	version="$(resolve_optimus_version "$@")"
	tarball_name="$optimus_package-$version.tgz"
	tarball_url="$optimus_base_url/releases/v$version/$tarball_name"

	confirm_install "$version" "$tarball_url"

	download_dir=$(create_temp_dir)
	optimus_download_dir="$download_dir"
	tarball_path="$download_dir/$tarball_name"

	download_optimus_package "$version" "$tarball_url" "$tarball_path"
	install_optimus_package "$tarball_path"
	rm -rf "$download_dir"
	optimus_download_dir=

	if [ "${OPTIMUS_BUN_INSTALLED_STANDALONE:-0}" = 1 ]; then
		optimus_screen "Optimus Prime installed" "" "Checking your shell PATH." ""
		configure_bun_path
	elif command -v "$optimus_cmd" >/dev/null 2>&1; then
		if [ "$optimus_screen_enabled" = 1 ]; then
			optimus_screen "Optimus Prime installed" "" "Run it with: $optimus_cmd" ""
		else
			printf '\nOptimus Prime was installed successfully.\n'
			printf '\nRun it with: %s\n' "$optimus_cmd"
		fi
	else
		if [ "$optimus_screen_enabled" = 1 ]; then
			optimus_screen "Optimus Prime installed" "" "PATH update needed for $optimus_cmd." ""
			optimus_restore_terminal
		else
			printf '\nOptimus Prime was installed successfully.\n'
		fi
		cat <<EOF
The $optimus_cmd command was installed, but it is not on your PATH yet.
Check Bun's global bin directory with:

  bun pm bin -g

Then add that directory to your shell PATH.
EOF
	fi
}

create_temp_dir() {
	if command -v mktemp >/dev/null 2>&1; then
		if tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/optimus-install.XXXXXX" 2>/dev/null); then
			printf '%s' "$tmp_dir"
			return
		fi
	fi

	printf 'error: mktemp is required to create a secure temporary directory.\n' >&2
	exit 1
}

optimus_install_traps() {
	trap 'optimus_cleanup' EXIT
	trap 'optimus_signal_cleanup 130' INT
	trap 'optimus_signal_cleanup 143' TERM
}

optimus_cleanup() {
	status=$?
	if [ -n "${optimus_download_dir:-}" ] && [ -d "$optimus_download_dir" ]; then
		rm -rf "$optimus_download_dir"
	fi
	optimus_restore_terminal
	return "$status"
}

optimus_signal_cleanup() {
	optimus_restore_terminal
	exit "$1"
}

optimus_restore_terminal() {
	if [ "${optimus_screen_enabled:-0}" = 1 ]; then
		if ( : <>/dev/tty ) 2>/dev/null; then
			printf '%s%s' "$optimus_reset" "$optimus_show_cursor" >/dev/tty
		else
			printf '%s%s' "$optimus_reset" "$optimus_show_cursor" >&2
		fi
	fi
}

optimus_init_screen() {
	if [ "${OPTIMUS_INSTALLER_PLAIN:-0}" = 1 ]; then
		return
	fi
	if [ ! -t 1 ]; then
		return
	fi
	if [ "${TERM:-}" = dumb ]; then
		return
	fi
	optimus_screen_enabled=1
}

optimus_read_terminal_size() {
	optimus_screen_cols=80
	optimus_screen_rows=24

	if size=$(stty size 2>/dev/null </dev/tty); then
		set -- $size
		if [ "${1:-}" ] && [ "${2:-}" ]; then
			case "$1" in *[!0-9]*|"") ;; *) optimus_screen_rows="$1" ;; esac
			case "$2" in *[!0-9]*|"") ;; *) optimus_screen_cols="$2" ;; esac
		fi
	fi

	if [ "$optimus_screen_cols" -lt 1 ]; then
		optimus_screen_cols=80
	fi
	if [ "$optimus_screen_rows" -lt 1 ]; then
		optimus_screen_rows=24
	fi
}

optimus_screen() {
	if [ "$optimus_screen_enabled" != 1 ]; then
		return
	fi

	optimus_screen_title="${2:-$1}"
	if [ -z "$optimus_screen_title" ]; then
		optimus_screen_title="$1"
	fi
	optimus_screen_status=
	optimus_screen_detail="${3:-}"
	optimus_screen_question="${4:-}"
	optimus_screen_frame=$((optimus_screen_frame + 1))
	optimus_read_terminal_size
	optimus_init_screen_layout
	optimus_refresh_screen_layout_mode

	if [ "$optimus_screen_drawn" = 0 ] ||
		[ "$optimus_screen_cols" -ne "$optimus_screen_last_cols" ] ||
		[ "$optimus_screen_rows" -ne "$optimus_screen_last_rows" ]; then
		optimus_screen_prefix="${optimus_reset}${optimus_clear_screen}${optimus_hide_cursor}"
		optimus_screen_drawn=1
		optimus_screen_last_cols="$optimus_screen_cols"
		optimus_screen_last_rows="$optimus_screen_rows"
	else
		optimus_screen_prefix="${optimus_reset}${optimus_home_cursor}${optimus_hide_cursor}"
	fi
	optimus_screen_frame_text=$(optimus_render_screen)

	if ( : <>/dev/tty ) 2>/dev/null; then
		printf '%s%s%s%s' "$optimus_sync_start" "$optimus_screen_prefix" "$optimus_screen_frame_text" "$optimus_sync_end" >/dev/tty
	else
		printf '%s%s%s%s' "$optimus_sync_start" "$optimus_screen_prefix" "$optimus_screen_frame_text" "$optimus_sync_end" >&2
	fi
}

optimus_init_screen_layout() {
	if [ "$optimus_screen_layout_ready" = 1 ]; then
		return
	fi

	optimus_screen_layout_ready=1
	optimus_screen_layout_show_logo=0
	optimus_screen_layout_lab_width=0
	optimus_screen_render_lab_width=0
	if optimus_terminal_size_supports_logo; then
		optimus_screen_layout_show_logo=1
		optimus_screen_layout_lab_width=$(optimus_lab_width_for_cols "$optimus_screen_cols")
	fi
}

optimus_refresh_screen_layout_mode() {
	optimus_screen_compact=0
	optimus_screen_render_lab_width=0
	if [ "$optimus_screen_layout_show_logo" != 1 ]; then
		return
	fi
	if [ "$optimus_screen_rows" -lt 17 ]; then
		optimus_screen_compact=1
		return
	fi

	max_safe_width=$((optimus_screen_cols - 1))
	if [ "$max_safe_width" -lt 32 ]; then
		optimus_screen_compact=1
		return
	fi

	optimus_screen_render_lab_width="$optimus_screen_layout_lab_width"
	if [ "$optimus_screen_render_lab_width" -gt "$max_safe_width" ]; then
		optimus_screen_render_lab_width="$max_safe_width"
	fi
}

optimus_terminal_size_supports_logo() {
	[ "$optimus_screen_rows" -ge 22 ] && [ "$optimus_screen_cols" -ge 42 ]
}

optimus_lab_width_for_cols() {
	cols="$1"
	width=$((cols - 6))
	if [ "$width" -gt 78 ]; then
		width=78
	fi
	if [ "$width" -lt 42 ]; then
		width=42
	fi
	max_safe_width=$((cols - 1))
	if [ "$max_safe_width" -lt 1 ]; then
		max_safe_width=1
	fi
	if [ "$width" -gt "$max_safe_width" ]; then
		width="$max_safe_width"
	fi
	if [ "$width" -lt 32 ]; then
		width=32
	fi
	printf '%s' "$width"
}

optimus_render_screen() {
	content_height=$(optimus_content_height)
	top=$(((optimus_screen_rows - content_height) / 2))
	if [ "$top" -lt 0 ]; then
		top=0
	fi

	y=0
	while [ "$y" -lt "$optimus_screen_rows" ]; do
		content_index=$((y - top))
		optimus_content_line "$content_index"
		if [ "${optimus_content_is_set:-0}" = 1 ]; then
			optimus_print_centered_line "$optimus_content_text" "$optimus_content_width" "$optimus_content_style"
		else
			optimus_print_centered_line "" 0 ""
		fi
		y=$((y + 1))
	done
}

optimus_content_height() {
	height=2
	if optimus_show_logo; then
		height=$((height + 15))
	fi
	printf '%s' "$height"
}

optimus_show_logo() {
	[ "$optimus_screen_layout_show_logo" = 1 ] && [ "$optimus_screen_compact" != 1 ] && [ "$optimus_screen_render_lab_width" -ge 32 ]
}

optimus_content_line() {
	index="$1"
	optimus_content_is_set=0
	optimus_content_text=
	optimus_content_width=0
	optimus_content_style=

	if optimus_show_logo; then
		case "$index" in
			0|1|2|3|4|5|6|7|8|9|10|11|12|13) optimus_set_lab_line "$index" ;;
			14) optimus_set_blank_line ;;
		esac
		if [ "$optimus_content_is_set" = 1 ]; then
			return
		fi
		index=$((index - 15))
	fi

	if [ "$index" -lt 0 ]; then
		return
	fi

	if [ "$index" -eq 0 ]; then
		if [ -n "$optimus_screen_question" ]; then
			optimus_set_text_line "$(optimus_screen_primary_text)" "$optimus_bold$optimus_color_text"
		else
			optimus_set_title_line "$optimus_screen_title"
		fi
		return
	fi

	if [ "$index" -eq 1 ]; then
		if [ -n "$optimus_screen_question" ]; then
			optimus_set_text_line "Press Enter to continue; type n to cancel." "$optimus_color_muted"
		elif [ -n "$optimus_screen_detail" ]; then
			optimus_set_text_line "$optimus_screen_detail" "$optimus_color_muted"
		else
			optimus_set_blank_line
		fi
		return
	fi
}

optimus_screen_primary_text() {
	if [ -z "$optimus_screen_question" ]; then
		printf '%s' "$optimus_screen_title"
		return
	fi

	case "$optimus_screen_question" in
		*'[Y/n]'*) printf '%s [Y/n] >' "$optimus_screen_title" ;;
		*) printf '%s %s' "$optimus_screen_title" "$optimus_screen_question" ;;
	esac
}

optimus_set_lab_line() {
	lab_row="$1"
	optimus_lab_width="$optimus_screen_render_lab_width"

	logo_line=$(optimus_logo_line "$lab_row")
	if [ -n "$logo_line" ]; then
		logo_start=$(((optimus_lab_width - 32) / 2))
		logo_end=$((logo_start + 32))
		left=$(optimus_lab_background_range "$lab_row" 0 "$logo_start")
		right=$(optimus_lab_background_range "$lab_row" "$logo_end" "$optimus_lab_width")
		trace="${left}${optimus_color_text}${logo_line}${optimus_reset}${right}"
	else
		trace=$(optimus_lab_background_range "$lab_row" 0 "$optimus_lab_width")
	fi

	optimus_content_is_set=1
	optimus_content_text="$trace"
	optimus_content_width="$optimus_lab_width"
	optimus_content_style=
}

optimus_logo_line() {
	case "$1" in
		2) printf '                          ▄▄███▀' ;;
		3) printf '    ▄▄▄▄▄              ▄█████▀' ;;
		4) printf '    ██████▄         ▄██████▀' ;;
		5) printf '   ▄███▀███▄     ▄███▀▄██▀' ;;
		6) printf '   ███ ▄████▄▄▄████▀▄▄██' ;;
		7) printf '  ▀██  ▀█████████▀▀▀▀▀▀' ;;
		8) printf '  ▄██   ██████▀▀ ▄███' ;;
		9) printf ' █████    ▀█▄▄▄█████▀' ;;
		10) printf '███████▄  ████████▀' ;;
		11) printf '▀███▀▀    █████▀' ;;
	esac
}

optimus_lab_background_range() {
	lab_row="$1"
	range_start="$2"
	range_end="$3"
	active_style=
	line=
	x="$range_start"
	while [ "$x" -lt "$range_end" ]; do
		optimus_lab_cell "$x" "$lab_row"
		if [ "$optimus_lab_cell_style" != "$active_style" ]; then
			if [ -n "$active_style" ]; then
				line="${line}${optimus_reset}"
			fi
			if [ -n "$optimus_lab_cell_style" ]; then
				line="${line}${optimus_lab_cell_style}"
			fi
			active_style="$optimus_lab_cell_style"
		fi
		line="${line}${optimus_lab_cell_char}"
		x=$((x + 1))
	done
	if [ -n "$active_style" ]; then
		line="${line}${optimus_reset}"
	fi
	printf '%s' "$line"
}

optimus_lab_cell() {
	x="$1"
	y="$2"
	width="$optimus_lab_width"
	height=14
	frame="$optimus_screen_frame"
	optimus_lab_cell_char=" "
	optimus_lab_cell_style=

	hash=$(((x * 37 + y * 53 + frame * 11 + x * y * 3) % 101))
	if [ "$hash" -lt 3 ]; then
		optimus_lab_cell_char="·"
		optimus_lab_cell_style="$optimus_color_dim"
	fi

	center_x=$((width * 36 / 100))
	center_y=$((height * 54 / 100))
	dx=$((x - center_x))
	dy=$((y - center_y))
	if [ "$dx" -lt 0 ]; then
		dx=$((-dx))
	fi
	if [ "$dy" -lt 0 ]; then
		dy=$((-dy))
	fi
	contour=$((dx + dy * 4 + x / 6 - frame))
	if [ "$x" -lt $((width * 82 / 100)) ] && [ $(((contour % 24 + 24) % 24)) -eq 12 ]; then
		if [ $(((x + y) % 5)) -eq 0 ]; then
			optimus_lab_cell_char="╌"
		else
			optimus_lab_cell_char="·"
		fi
		optimus_lab_cell_style="$optimus_color_dim"
	fi

	horizon_y=$((height * 58 / 100))
	if [ "$y" -eq "$horizon_y" ] && [ $((x % 2)) -eq 0 ] && [ $(((x + frame) % 13)) -lt 2 ]; then
		optimus_lab_cell_char="─"
		if [ "$x" -gt $((width * 60 / 100)) ]; then
			optimus_lab_cell_style="$optimus_color_primary"
		else
			optimus_lab_cell_style="$optimus_color_dim"
		fi
	fi

	scan_start=$((width / 2))
	if [ "$x" -ge "$scan_start" ]; then
		scan_offset=$((x - scan_start))
		if [ $((scan_offset % 5)) -eq 0 ]; then
			scan_index=$((scan_offset / 5))
			scan_top=$((1 + (scan_index + frame / 3) % 3))
			scan_bottom=$((height - 2 - (scan_index * 2 + frame / 4) % 3))
			if [ "$y" -ge "$scan_top" ] && [ "$y" -le "$scan_bottom" ] && [ $(((y + scan_index + frame) % 6)) -ne 0 ]; then
				if [ $(((scan_index + y) % 4)) -eq 0 ]; then
					optimus_lab_cell_char="┃"
				else
					optimus_lab_cell_char="╎"
				fi
				optimus_lab_cell_style="$optimus_color_scan"
			fi
		fi
	fi

	trace_index=0
	while [ "$trace_index" -lt 3 ]; do
		case "$trace_index" in
			0) base=$((height * 30 / 100)) ;;
			1) base=$((height * 49 / 100)) ;;
			*) base=$((height * 72 / 100)) ;;
		esac
		wave=$(((x * 2 + frame + trace_index * 7) % 16))
		if [ "$wave" -gt 7 ]; then
			wave=$((15 - wave))
		fi
		trace_y=$((base + (wave - 3) / 2))
		if [ "$y" -eq "$trace_y" ]; then
			if [ $(((x + frame + trace_index * 13) % 41)) -eq 0 ]; then
				optimus_lab_cell_char="◆"
				optimus_lab_cell_style="$optimus_color_warning"
			elif [ $(((x + frame) % 12)) -eq 0 ]; then
				optimus_lab_cell_char="•"
				optimus_lab_cell_style="$optimus_color_primary"
			else
				optimus_lab_cell_char="·"
				optimus_lab_cell_style="$optimus_color_primary"
			fi
		fi
		trace_index=$((trace_index + 1))
	done
}

optimus_set_blank_line() {
	optimus_content_is_set=1
	optimus_content_text=
	optimus_content_width=0
	optimus_content_style=
}

optimus_set_text_line() {
	max_width=$((optimus_screen_cols - 4))
	if [ "$max_width" -lt 1 ]; then
		max_width=1
	fi
	optimus_content_text=$(optimus_fit_ascii "$1" "$max_width")
	optimus_content_width=${#optimus_content_text}
	optimus_content_style="$2"
	optimus_content_is_set=1
}

optimus_set_title_line() {
	max_width=$((optimus_screen_cols - 4))
	if [ "$max_width" -lt 1 ]; then
		max_width=1
	fi
	optimus_content_text=$(optimus_fit_ascii "$1" "$max_width")
	optimus_content_width=${#optimus_content_text}
	case "$optimus_content_text" in
		*"Optimus Prime"*)
			optimus_content_text=$(optimus_style_optimus_title "$optimus_content_text")
			optimus_content_style=
			;;
		*)
			optimus_content_style="$optimus_bold$optimus_color_primary"
			;;
	esac
	optimus_content_is_set=1
}

optimus_style_optimus_title() {
	text="$1"
	styled=
	while :; do
		case "$text" in
			*"Optimus Prime"*)
				before=${text%%Optimus Prime*}
				rest=${text#*Optimus Prime}
				styled="${styled}${optimus_bold}${optimus_color_primary}${before}"
				styled="${styled}${optimus_bold}${optimus_color_primary}PRIME Agent${optimus_reset}"
				text="$rest"
				;;
			*)
				styled="${styled}${optimus_bold}${optimus_color_primary}${text}${optimus_reset}"
				printf '%s' "$styled"
				return
				;;
		esac
	done
}

optimus_fit_ascii() {
	text="$1"
	max_width="$2"
	if [ "${#text}" -le "$max_width" ]; then
		printf '%s' "$text"
		return
	fi
	if [ "$max_width" -le 3 ]; then
		printf '%s' "$text" | cut -c 1-"$max_width"
		return
	fi
	cut_width=$((max_width - 3))
	printf '%s...' "$(printf '%s' "$text" | cut -c 1-"$cut_width")"
}

optimus_print_centered_line() {
	text="$1"
	width="$2"
	style="$3"
	left=$(((optimus_screen_cols - width) / 2))
	if [ "$left" -lt 0 ]; then
		left=0
	fi
	if [ -n "$style" ]; then
		printf '%*s%s%s%s%s\n' "$left" "" "$style" "$text" "$optimus_reset" "$optimus_clear_line"
	else
		printf '%*s%s%s\n' "$left" "" "$text" "$optimus_clear_line"
	fi
}

optimus_place_prompt_cursor() {
	max_width=$((optimus_screen_cols - 4))
	if [ "$max_width" -lt 1 ]; then
		max_width=1
	fi
	prompt_text=$(optimus_fit_ascii "$(optimus_screen_primary_text)" "$max_width")
	prompt_width=${#prompt_text}
	content_height=$(optimus_content_height)
	top=$(((optimus_screen_rows - content_height) / 2))
	if [ "$top" -lt 0 ]; then
		top=0
	fi
	prompt_index=0
	if optimus_show_logo; then
		prompt_index=$((prompt_index + 15))
	fi
	row=$((top + prompt_index + 1))
	col=$(((optimus_screen_cols - prompt_width) / 2 + prompt_width + 2))
	if [ "$col" -lt 1 ]; then
		col=1
	fi
	if [ "$col" -gt "$optimus_screen_cols" ]; then
		col="$optimus_screen_cols"
	fi
	if ( : <>/dev/tty ) 2>/dev/null; then
		printf '%s%s%s[%s;%sH' "$optimus_reset" "$optimus_show_cursor" "$optimus_esc" "$row" "$col" >/dev/tty
	else
		printf '%s%s%s[%s;%sH' "$optimus_reset" "$optimus_show_cursor" "$optimus_esc" "$row" "$col" >&2
	fi
}

optimus_pulse() {
	case $((optimus_screen_frame % 4)) in
		0) printf '.' ;;
		1) printf '..' ;;
		2) printf '...' ;;
		*) printf '' ;;
	esac
}

optimus_animation_detail_count() {
	details="$1"
	case "$details" in
		*'
'*) printf '%s\n' "$details" | wc -l | tr -d ' ' ;;
		*) printf '1' ;;
	esac
}

optimus_animation_current_frame() {
	frame="${optimus_animation_frame:-1}"
	case "$frame" in
		""|*[!0-9]*) frame=1 ;;
	esac
	if [ "$frame" -lt 1 ]; then
		frame=1
	fi
	printf '%s' "$frame"
}

optimus_animation_step_index() {
	details="$1"
	detail_count=$(optimus_animation_detail_count "$details")
	frame=$(optimus_animation_current_frame)
	detail_index=$(((frame - 1) / 24 + 1))
	if [ "$detail_index" -gt "$detail_count" ]; then
		detail_index="$detail_count"
	fi
	printf '%s' "$detail_index"
}

optimus_static_progress_title() {
	case "$1" in
		*...) printf '%s' "$1" ;;
		*) printf '%s...' "$1" ;;
	esac
}

optimus_animation_status() {
	status="$1"
	details="$2"
	status_mode="$3"
	case "$status_mode" in
		static) optimus_static_progress_title "$status" ;;
		*) printf '%s%s' "$status" "$(optimus_pulse)" ;;
	esac
}

optimus_animation_detail() {
	details="$1"
	case "$details" in
		*'
'*)
			detail_index=$(optimus_animation_step_index "$details")
			printf '%s\n' "$details" | sed -n "${detail_index}p"
			;;
		*) printf '%s' "$details" ;;
	esac
}

optimus_run_quiet_with_animation() {
	title="$1"
	status="$2"
	detail="$3"
	shift 3

	optimus_run_quiet_with_animation_command "$title" "$status" "$detail" pulse "$@"
}

optimus_run_quiet_with_animation_steps() {
	title="$1"
	status="$2"
	details="$3"
	shift 3

	optimus_run_quiet_with_animation_command "$title" "$status" "$details" static "$@"
}

optimus_run_quiet_with_animation_command() {
	title="$1"
	status="$2"
	details="$3"
	status_mode="$4"
	shift 4

	if [ "$optimus_screen_enabled" != 1 ]; then
		printf '%s\n' "$status" >&2
		"$@"
		return
	fi

	output_dir=$(create_temp_dir)
	output_file="$output_dir/output"
	"$@" >"$output_file" 2>&1 &
	command_pid=$!
	optimus_animation_frame=0

	while kill -0 "$command_pid" 2>/dev/null; do
		optimus_animation_frame=$((optimus_animation_frame + 1))
		status_display=$(optimus_animation_status "$status" "$details" "$status_mode")
		optimus_screen "$title" "$status_display" "$(optimus_animation_detail "$details")" ""
		sleep 0.18
	done

	if wait "$command_pid"; then
		command_status=0
	else
		command_status=$?
	fi

	if [ "$command_status" -ne 0 ] && [ -s "$output_file" ]; then
		optimus_restore_terminal
		printf '\n' >&2
		cat "$output_file" >&2
	fi
	rm -rf "$output_dir"
	return "$command_status"
}

optimus_prompt_yes_no() {
	question="$1"
	detail="$2"
	input_prompt="$3"

	if ( : <>/dev/tty ) 2>/dev/null; then
		prompt_input=tty
		exec 3<>/dev/tty
	elif [ -t 0 ]; then
		prompt_input=stdin
	else
		return 2
	fi

	if [ "$optimus_screen_enabled" = 1 ]; then
		optimus_screen "$question" "" "$detail" "$input_prompt"
		optimus_place_prompt_cursor "$input_prompt"
	else
		printf '%s\n' "$detail"
		if [ "$prompt_input" = tty ]; then
			printf '%s ' "$input_prompt" >&3
		else
			printf '%s ' "$input_prompt" >&2
		fi
	fi

	if [ "$prompt_input" = tty ]; then
		if ! IFS= read -r answer <&3; then
			answer=
		fi
		exec 3>&-
	else
		if ! IFS= read -r answer; then
			answer=
		fi
	fi

	case "$answer" in
		n|N|no|NO)
			return 1
			;;
	esac
	return 0
}

start_preflight_checks() {
	preflight_dir=$(create_temp_dir)
	preflight_file="$preflight_dir/preflight"
	run_preflight_checks >"$preflight_file" &
	preflight_pid=$!
}

finish_preflight_checks() {
	if [ "$optimus_screen_enabled" = 1 ]; then
		while kill -0 "$preflight_pid" 2>/dev/null; do
			optimus_screen "Checking Bun$(optimus_pulse)" "" "" ""
			sleep 0.18
		done
	fi

	if wait "$preflight_pid"; then
		preflight_status=0
	else
		preflight_status=$?
	fi

	if [ "$optimus_screen_enabled" = 1 ]; then
		if [ "$preflight_status" -ne 0 ]; then
			preflight_summary=$(sed -n '1p' "$preflight_file")
			optimus_screen "Bun 1.3.0 or newer is required" "" "$preflight_summary" ""
			sleep 0.4
		elif [ -s "$preflight_file" ]; then
			preflight_summary="Existing $optimus_cmd command found on PATH."
			optimus_screen "Environment ready" "" "$preflight_summary" ""
			sleep 0.4
		fi
	else
		cat "$preflight_file"
	fi
	rm -rf "$preflight_dir"
	return "$preflight_status"
}

run_preflight_checks() {
	status=0
	yellow="${optimus_esc}[33m"
	reset="${optimus_esc}[0m"

	if command -v bun >/dev/null 2>&1; then
		bun_version=$(bun --version 2>/dev/null)
		if ! bun_version_string_is_new_enough "$bun_version"; then
			printf 'error: Optimus Prime requires Bun 1.3.0 or newer. Found %s.\n' "${bun_version:-unknown}"
			status=1
		fi
	else
		printf 'error: Bun 1.3.0 or newer is required to install Optimus Prime.\n'
		status=1
	fi

	if [ "$status" -ne 0 ]; then
		printf '\n'
	fi

	if optimus_path=$(command -v "$optimus_cmd" 2>/dev/null); then
		printf '%sExisting %s found at: %s%s\n' "$yellow" "$optimus_cmd" "$optimus_path" "$reset"
		printf '\n'
	fi

	return "$status"
}

resolve_optimus_version() {
	if [ "${1:-}" ]; then
		case "$1" in
			stable|beta) release_channel="$1" ;;
			*)
				normalize_version "$1"
				return
				;;
		esac
	else
		release_channel="$optimus_release_channel"
	fi

	if [ "${OPTIMUS_VERSION:-}" ]; then
		normalize_version "$OPTIMUS_VERSION"
		return
	fi

	if ! command -v curl >/dev/null 2>&1; then
		printf 'error: curl is required to resolve the latest Optimus Prime version.\n' >&2
		exit 1
	fi

	case "$release_channel" in
		stable|beta) ;;
		*)
			printf 'error: invalid Optimus Prime release channel: %s\n' "$release_channel" >&2
			exit 1
			;;
	esac

	channel_dir=$(create_temp_dir)
	channel_path="$channel_dir/$release_channel"
	if ! optimus_run_quiet_with_animation \
		"Resolving latest release" \
		"Resolving latest release" \
		"Checking the $release_channel release channel." \
		curl -fsSL "$optimus_base_url/$release_channel" -o "$channel_path"; then
		rm -rf "$channel_dir"
		printf 'error: could not resolve latest Optimus Prime version from %s/%s\n' "$optimus_base_url" "$release_channel" >&2
		exit 1
	fi
	channel_version="$(tr -d '[:space:]' <"$channel_path")"
	rm -rf "$channel_dir"
	if [ -z "$channel_version" ]; then
		printf 'error: could not resolve latest Optimus Prime version from %s/%s\n' "$optimus_base_url" "$release_channel" >&2
		exit 1
	fi
	normalize_version "$channel_version"
}

normalize_version() {
	version="${1#v}"
	case "$version" in
		"")
			printf 'error: empty Optimus Prime version.\n' >&2
			exit 1
			;;
		*[!0-9A-Za-z.-]*)
			printf 'error: invalid Optimus Prime version: %s\n' "$1" >&2
			exit 1
			;;
	esac
	printf '%s' "$version"
}

install_bun_interactive() {
	method=$(detect_bun_install_method)
	case "$method" in
		homebrew) label="Homebrew" ;;
		official) label="the official Bun installer" ;;
		*)
			method=official
			label="the official Bun installer"
			;;
	esac

	if optimus_prompt_yes_no \
		"Install Bun with $label?" \
		"Required before Optimus Prime can be installed." \
		"Install? [Y/n]"; then
		install_bun "$method" "$label"
		return
	else
		prompt_status=$?
	fi
	if [ "$prompt_status" -eq 2 ]; then
		printf 'No terminal detected; install Bun 1.3.0 or newer, then run this installer again.\n'
	else
		printf '\nInstall Bun 1.3.0 or newer, then run this installer again.\n'
	fi
	return 1
}

detect_bun_install_method() {
	case "$(uname -s)" in
		Darwin)
			if command -v brew >/dev/null 2>&1; then
				printf 'homebrew'
			else
				printf 'official'
			fi
			;;
		*)
			printf 'official'
			;;
	esac
}

bun_version_string_is_new_enough() {
	version="${1#v}"
	case "$version" in
		[0-9]*) ;;
		*) return 1 ;;
	esac
	version="${version%%[!0-9.]*}"
	version_ifs=${IFS- }
	IFS=.
	set -- $version
	IFS=$version_ifs
	major="${1:-}"
	minor="${2:-0}"
	patch="${3:-0}"
	case "$major" in ''|*[!0-9]*) return 1 ;; esac
	case "$minor" in ''|*[!0-9]*) minor=0 ;; esac
	case "$patch" in ''|*[!0-9]*) patch=0 ;; esac

	[ "$major" -gt 1 ] && return 0
	[ "$major" -lt 1 ] && return 1
	[ "$minor" -gt 3 ] && return 0
	[ "$minor" -lt 3 ] && return 1
	[ "$patch" -ge 0 ] && return 0
	return 1
}

install_bun() {
	method="$1"
	label="$2"

	if [ "$optimus_screen_enabled" != 1 ]; then
		printf '\nInstalling Bun with %s...\n\n' "$label"
		run_bun_install_method "$method"
	else
		prepare_sudo_for_bun_install "$method"
		bun_install_details="Using $label.
Resolving the Bun release.
Downloading the Bun runtime.
Linking the bun command.
Preparing Optimus Prime setup."
		optimus_run_quiet_with_animation_steps \
			"Installing Bun" \
			"Installing Bun" \
			"$bun_install_details" \
			run_bun_install_method "$method"
	fi

	if [ "$method" = official ]; then
		load_bun_install
		OPTIMUS_BUN_INSTALLED_STANDALONE=1
	fi
	hash -r
	if [ "$optimus_screen_enabled" = 1 ]; then
		optimus_screen "Bun installed" "" "Continuing Optimus Prime setup." ""
	else
		printf '\nBun is installed.\n\n'
	fi
}

bun_install_needs_sudo() {
	if [ "${EUID:-$(id -u)}" -eq 0 ]; then
		return 1
	fi

	case "$1" in
		official)
			[ "$(uname -s)" = Linux ] || return 1
			command -v unzip >/dev/null 2>&1 && return 1
			command -v apt-get >/dev/null 2>&1 || command -v apk >/dev/null 2>&1
			;;
		*)
			return 1
			;;
	esac
}

prepare_sudo_for_bun_install() {
	method="$1"
	if ! bun_install_needs_sudo "$method"; then
		return 0
	fi

	optimus_screen "Preparing Bun install" "" "This may ask for your sudo password." ""
	optimus_restore_terminal
	printf '\n'
	sudo -v
}

run_bun_install_method() {
	case "$1" in
		homebrew) install_bun_with_homebrew ;;
		official) install_bun_official ;;
	esac
}

install_bun_with_homebrew() {
	if brew list oven-sh/bun/bun >/dev/null 2>&1; then
		brew upgrade oven-sh/bun/bun
	else
		brew install oven-sh/bun/bun
	fi
}

install_bun_official() {
	if ! command -v curl >/dev/null 2>&1; then
		printf 'curl is required to install Bun. Install curl and run this installer again.\n'
		return 1
	fi
	if ! command -v bash >/dev/null 2>&1; then
		printf 'bash is required by the official Bun installer. Install bash and run this installer again.\n'
		return 1
	fi
	ensure_bun_install_tools || return 1

	bun_base_dir=$(bun_install_base_dir)
	printf 'Downloading Bun to %s\n' "$bun_base_dir"
	BUN_INSTALL="$bun_base_dir" curl -fsSL https://bun.sh/install | BUN_INSTALL="$bun_base_dir" bash
	printf 'Bun installed at %s\n' "$bun_base_dir"
}

ensure_bun_install_tools() {
	if [ "$(uname -s)" != Linux ]; then
		return 0
	fi
	if command -v unzip >/dev/null 2>&1; then
		return 0
	fi

	printf 'Installing unzip for the Bun archive extraction\n'
	print_sudo_note
	if command -v apt-get >/dev/null 2>&1; then
		run_with_sudo apt-get update
		run_with_sudo apt-get install -y unzip
	elif command -v apk >/dev/null 2>&1; then
		run_with_sudo apk add --update-cache unzip
	else
		printf 'unzip is required to install Bun. Install unzip and run this installer again.\n'
		return 1
	fi
}

load_bun_install() {
	OPTIMUS_BUN_BIN="$(bun_install_base_dir)/bin"
	PATH="$OPTIMUS_BUN_BIN:$PATH"
	export OPTIMUS_BUN_BIN PATH
}

bun_install_base_dir() {
	if [ -n "${BUN_INSTALL:-}" ]; then
		printf '%s' "${BUN_INSTALL%/}"
	else
		printf '%s/.bun' "$HOME"
	fi
}

print_sudo_note() {
	if [ "${EUID:-$(id -u)}" -ne 0 ]; then
		printf 'This may ask for your sudo password.\n\n'
	fi
}

run_with_sudo() {
	if [ "${EUID:-$(id -u)}" -eq 0 ]; then
		"$@"
	else
		sudo "$@"
	fi
}

configure_bun_path() {
	if original_optimus_path=$(resolve_optimus_with_original_path); then
		case "$original_optimus_path" in
			"$OPTIMUS_BUN_BIN/"*)
				if [ "$optimus_screen_enabled" = 1 ]; then
					optimus_screen "Optimus Prime installed" "" "Run it with: $optimus_cmd" ""
				else
					printf '\nRun it with: %s\n' "$optimus_cmd"
				fi
				return 0
				;;
		esac
		if [ "$optimus_screen_enabled" = 1 ]; then
			optimus_screen "Optimus Prime installed" "" "PATH update needed for $optimus_cmd." ""
		else
			printf '%s was installed, but your shell is not using that install yet.\n' "$optimus_cmd"
			printf 'Your shell currently resolves %s to: %s\n' "$optimus_cmd" "$original_optimus_path"
		fi
	else
		if [ "$optimus_screen_enabled" = 1 ]; then
			optimus_screen "Optimus Prime installed" "" "PATH update needed for $optimus_cmd." ""
		else
			printf '%s was installed, but your shell is not using that install yet.\n' "$optimus_cmd"
		fi
	fi

	profile=$(detect_shell_profile) || {
		if [ "$optimus_screen_enabled" = 1 ]; then
			optimus_restore_terminal
			printf '\n'
		fi
		print_bun_path_manual_instructions
		return 0
	}

	if shell_profile_has_bun_path "$profile"; then
		if [ "$optimus_screen_enabled" = 1 ]; then
			optimus_screen "Optimus Prime installed" "" "Run: $(optimus_source_profile_command "$profile")" ""
		else
			printf '%s already contains %s.\n' "$profile" "$OPTIMUS_BUN_BIN"
			printf 'Restart your shell or run: %s\n' "$(optimus_source_profile_command "$profile")"
		fi
		return 0
	fi

	prompt_add_bun_path "$profile"
}

resolve_optimus_with_original_path() {
	saved_path=$PATH
	PATH=$optimus_original_path
	if command -v "$optimus_cmd" 2>/dev/null; then
		status=0
	else
		status=$?
	fi
	PATH=$saved_path
	return "$status"
}

detect_shell_profile() {
	if [ -n "${OPTIMUS_SHELL_PROFILE:-}" ]; then
		printf '%s' "$OPTIMUS_SHELL_PROFILE"
		return 0
	fi
	if [ -z "${HOME:-}" ]; then
		return 1
	fi

	shell_name="${SHELL:-}"
	shell_name="${shell_name##*/}"
	case "$shell_name" in
		zsh)
			printf '%s/.zshrc' "${ZDOTDIR:-$HOME}"
			;;
		bash)
			printf '%s/.bashrc' "$HOME"
			;;
		*)
			if [ -f "$HOME/.zshrc" ]; then
				printf '%s/.zshrc' "$HOME"
			elif [ -f "$HOME/.bashrc" ]; then
				printf '%s/.bashrc' "$HOME"
			else
				printf '%s/.profile' "$HOME"
			fi
			;;
	esac
}

shell_profile_has_bun_path() {
	profile="$1"
	[ -f "$profile" ] && grep -F "$OPTIMUS_BUN_BIN" "$profile" >/dev/null 2>&1
}

prompt_add_bun_path() {
	profile="$1"
	path_line=$(bun_path_line)

	if ! optimus_prompt_yes_no \
		"Add Bun to your PATH?" \
		"Updates $profile so future shells can run $optimus_cmd." \
		"Update PATH? [Y/n]"; then
		if [ "$optimus_screen_enabled" = 1 ]; then
			optimus_restore_terminal
			printf '\n'
		fi
		print_bun_path_manual_instructions
		return 0
	fi

	mkdir -p "$(dirname "$profile")"
	{
		printf '\n# Optimus Prime Bun install\n'
		printf '%s\n' "$path_line"
	} >>"$profile"
	if [ "$optimus_screen_enabled" = 1 ]; then
		optimus_screen "Optimus Prime installed" "" "Run: $(optimus_source_profile_command "$profile")" ""
	else
		printf 'Added %s to %s.\n' "$OPTIMUS_BUN_BIN" "$profile"
		printf 'Restart your shell or run: %s\n' "$(optimus_source_profile_command "$profile")"
	fi
}

print_bun_path_manual_instructions() {
	printf 'Add this to your shell profile to use %s from new shells:\n\n' "$optimus_cmd"
	printf '  %s\n' "$(bun_path_line)"
	printf '\nThen restart your shell and run: %s\n' "$optimus_cmd"
}

bun_path_line() {
	printf 'export PATH="%s:$PATH"' "$OPTIMUS_BUN_BIN"
}

optimus_shell_quote() {
	quoted=$(printf '%s' "$1" | sed "s/'/'\\\\''/g")
	printf "'%s'" "$quoted"
}

optimus_source_profile_command() {
	printf '. %s && %s' "$(optimus_shell_quote "$1")" "$optimus_cmd"
}

download_optimus_package() {
	version="$1"
	tarball_url="$2"
	tarball_path="$3"
	download_dir=$(dirname "$tarball_path")
	tarball_name=$(basename "$tarball_path")
	checksums_url="$optimus_base_url/releases/v$version/SHA256SUMS"
	checksums_path="$download_dir/SHA256SUMS"

	if ! command -v curl >/dev/null 2>&1; then
		printf 'error: curl is required to download Optimus Prime.\n' >&2
		exit 1
	fi

	optimus_run_quiet_with_animation \
		"Downloading checksums" \
		"Downloading release checksums" \
		"Optimus Prime v$version" \
		curl -fsSL "$checksums_url" -o "$checksums_path"

	optimus_run_quiet_with_animation \
		"Downloading Optimus Prime" \
		"Downloading Optimus Prime v$version" \
		"Fetching the verified package." \
		curl -fsSL "$tarball_url" -o "$tarball_path"

	verify_optimus_package_checksum "$checksums_path" "$tarball_path"
}

verify_optimus_package_checksum() {
	checksums_path="$1"
	tarball_path="$2"
	checksum_dir=$(dirname "$tarball_path")
	tarball_name=$(basename "$tarball_path")
	selected_checksums_path="$checksum_dir/SHA256SUMS.selected"

	if ! awk -v file="$tarball_name" '$2 == file { print; found = 1; exit } END { if (!found) exit 1 }' \
		"$checksums_path" >"$selected_checksums_path"; then
		printf 'error: checksum for %s was not found in %s\n' "$tarball_name" "$checksums_path" >&2
		exit 1
	fi

	if command -v sha256sum >/dev/null 2>&1; then
		optimus_run_quiet_with_animation \
			"Verifying download" \
			"Verifying Optimus Prime download" \
			"Checking SHA-256." \
			optimus_run_checksum_check "$checksum_dir" "$(basename "$selected_checksums_path")" sha256sum
	elif command -v shasum >/dev/null 2>&1; then
		optimus_run_quiet_with_animation \
			"Verifying download" \
			"Verifying Optimus Prime download" \
			"Checking SHA-256." \
			optimus_run_checksum_check "$checksum_dir" "$(basename "$selected_checksums_path")" shasum
	else
		printf 'error: sha256sum or shasum is required to verify the Optimus Prime download.\n' >&2
		exit 1
	fi
}

optimus_run_checksum_check() {
	checksum_dir="$1"
	selected_checksums_name="$2"
	checker="$3"
	case "$checker" in
		sha256sum)
			(cd "$checksum_dir" && sha256sum -c "$selected_checksums_name")
			;;
		shasum)
			(cd "$checksum_dir" && shasum -a 256 -c "$selected_checksums_name")
			;;
	esac
}

confirm_install() {
	version="$1"
	tarball_url="$2"

	if optimus_prompt_yes_no \
		"Install Optimus Prime v$version globally with Bun?" \
		"Downloads the verified release and runs bun install -g." \
		"Install? [Y/n]"; then
		return 0
	else
		prompt_status=$?
	fi

	if [ "$prompt_status" -eq 2 ]; then
		printf 'This will download, verify, and install:\n\n  %s\n\n' "$tarball_url"
		printf 'No terminal detected; continuing without confirmation.\n'
		return 0
	fi

	if [ "$optimus_screen_enabled" = 1 ]; then
		optimus_screen "Installation cancelled" "" "No changes were made." ""
		exit 0
	fi
	printf '\nInstallation cancelled.\n'
	exit 0
}

install_optimus_package() {
	tarball_path="$1"
	bun_install_details="Preparing global install.
Linking command binaries.
Installing runtime packages.
Preloading search tools.
Finalizing bun install."
	optimus_run_quiet_with_animation_steps \
		"Installing Optimus Prime" \
		"Installing Optimus Prime" \
		"$bun_install_details" \
		env OPTIMUS_BOOTSTRAP_TOOLS_ON_INSTALL=1 bun install -g "$tarball_path"
}

main "$@"
