/**
 * Notion integration: tools auto-discovered from Notion's official MCP server.
 *
 * Usage in the REPL:
 *
 *     const results = await notion.call_tool("notion-search", { query: "roadmap" });
 */

import { createMcpSkill } from "./mcp-client.js";

export default function createSkill(ctx) {
	return createMcpSkill({ server: "notion", url: "https://mcp.notion.com/mcp" }, ctx);
}
