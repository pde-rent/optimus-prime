/**
 * Code shared between daemon-mode.ts and daemon-supervisor.ts.
 */

import type { SessionSummary } from "./daemon-session-list.js";

export const DAEMON_COMMAND_TYPES: ReadonlySet<string> = new Set([
	"ack_result",
	"list",
	"list_saved_sessions",
	"create",
	"attach",
	"reattach",
	"detach",
	"complete_owned_session",
	"promote_owned_session",
	"kill",
	"rename",
	"prompt",
	"cancel_prompt_admission",
	"prompt_and_wait",
	"steer",
	"follow_up",
	"restore_next_turn",
	"restore_actions",
	"append_custom_message",
	"resume_queue",
	"send_message",
	"agent_messages_status",
	"agent_messages_pause",
	"agent_messages_resume",
	"agent_messages_clear",
	"abort",
	"start_side_question",
	"abort_side_question",
	"execute_bash",
	"execute_bash_and_wait",
	"abort_bash",
	"cancel_rlm_child",
	"delete_rlm_subagent",
	"wait_for_idle",
	"wait_for_headless_completion",
	"get_session_header",
	"get_state",
	"get_connection_state",
	"get_messages",
	"get_session_stats",
	"get_context_tree",
	"get_commands",
	"get_resource_snapshot",
	"get_model_catalog",
	"get_available_models",
	"get_queue",
	"mutate_queued_message",
	"clear_queue",
	"abort_and_clear_queue",
	"cron_list",
	"heartbeats_list",
	"heartbeat_manage",
	"cron_add",
	"cron_cancel",
	"heartbeat_get",
	"heartbeat_set",
	"heartbeat_update",
	"set_model",
	"cycle_model",
	"set_scoped_models",
	"set_thinking_level",
	"set_service_tier",
	"cycle_thinking_level",
	"set_transport",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_auto_compaction",
	"set_auto_retry",
	"compact",
	"refine",
	"abort_compaction",
	"abort_branch_summary",
	"abort_retry",
	"reload",
	"new_session",
	"switch_session",
	"fork",
	"navigate_tree",
	"import_jsonl",
	"export_html",
	"export_jsonl",
	"set_session_name",
	"get_rlm_max_depth_status",
	"set_rlm_max_depth",
	"rename_saved_session",
	"delete_saved_session",
	"get_session_context",
	"get_session_tree",
	"get_user_messages_for_forking",
	"get_last_assistant_text",
	"get_system_prompt",
	"get_tool_definition",
	"set_session_entry_label",
	"extension_ui_response",
	"prepare_update_restart",
	"retry_worker",
	"restart",
	"shutdown",
]);

export function promptAdmissionKey(activeSessionId: string, admissionId: string): string {
	return `${activeSessionId}\0${admissionId}`;
}

export function isSessionSummary(value: unknown): value is SessionSummary {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Partial<SessionSummary>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.sessionId === "string" &&
		typeof candidate.cwd === "string" &&
		typeof candidate.lifecycle === "string" &&
		typeof candidate.activity === "string" &&
		typeof candidate.isSessionActive === "boolean" &&
		typeof candidate.isStreaming === "boolean" &&
		typeof candidate.isCompacting === "boolean" &&
		typeof candidate.attachedClients === "number" &&
		typeof candidate.messageCount === "number" &&
		(candidate.unfinishedActionCount === undefined || typeof candidate.unfinishedActionCount === "number") &&
		typeof candidate.sessionActions === "object" &&
		candidate.sessionActions !== null &&
		typeof candidate.sessionActions.queuedCount === "number" &&
		Array.isArray(candidate.sessionActions.steering) &&
		Array.isArray(candidate.sessionActions.followUps)
	);
}
