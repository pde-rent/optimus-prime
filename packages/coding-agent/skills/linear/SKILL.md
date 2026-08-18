---
name: linear
description: Read and write Linear issues, projects, cycles, comments, and more via Linear's official MCP server. Tools are auto-discovered from the server at runtime.
---

# Linear

Talk to Linear through its official hosted MCP server from the JavaScript REPL.

## Setup

Connect via `/login` → **Services** tab → **Linear** (OAuth in the browser).
`/mcp login linear` does the same. Once connected, this skill is enabled
automatically. If a call throws `NotEnabled`, the user isn't logged in — walk
them through `/login`; don't ask them to set environment variables.

## Usage

The tool set is defined by the server, not by this skill, so **discover before
you call** — don't assume tool names or argument names:

```javascript
// 1. Discover available tools (names + JSON Schemas)
for (const tool of await linear.list_tools()) {
  console.log(tool.name, "-", tool.description);
}

// 2. Inspect a specific tool's arguments
const tools = await linear.list_tools();
console.log(JSON.stringify(tools.find((t) => t.name === "list_issues").inputSchema, null, 2));

// 3. Call it; the argument object must match the tool's input schema
const result = await linear.list_issues({ team: "Engineering" });
console.log(result);
```

Notes:
- Every tool call is async — always `await`.
- Results are already-parsed JavaScript (an object for structured output,
  otherwise a string). No need to `JSON.parse` them.
- For tools whose names aren't valid identifiers, use the escape hatch:
  `await linear.call_tool("tool-name", { arg: "value" })`.
- Run `list_tools()` before assuming a tool exists — the server is the source of
  truth for tool names and arguments.
