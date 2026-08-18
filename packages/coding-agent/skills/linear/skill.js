/**
 * Linear integration: tools auto-discovered from Linear's official MCP server.
 *
 * Usage in the REPL:
 *
 *     const issues = await linear.list_issues({ team: "Engineering" });
 */

import { createMcpSkill } from "./mcp-client.js";

export default function createSkill(ctx) {
	return createMcpSkill({ server: "linear", url: "https://mcp.linear.app/mcp" }, ctx);
}
