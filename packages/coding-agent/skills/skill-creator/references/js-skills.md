# JS-Backed Skills

A JS-backed skill is a regular markdown skill that also ships a `skill.js` module. Optimus Prime preloads that module into the persistent JavaScript REPL and binds its API to a global, so the agent can call it directly instead of shelling out.

## Detection Contract

Both of these must hold or the skill stays a markdown-only skill:

- `SKILL.md` exists as usual.
- `skill.js` exists at the skill root — its presence is what marks the skill as JS-backed. (`skill.mjs` and `skill.ts` are also accepted, in that order of preference.)

The binding name is the skill name with hyphens converted to underscores, and it must be a valid JavaScript identifier. For a skill named `word-count`, the REPL exposes `word_count`.

## Minimal Template

```
word-count/
├── SKILL.md
└── skill.js
```

**`SKILL.md`**

```markdown
---
name: word-count
description: Count word frequencies in text and return the most common words. Use when the user asks for word counts or frequency analysis of a text snippet.
---

# Word Count

Call directly from the REPL:

    await word_count.run("some text to analyze", 3)
```

**`skill.js`**

```js
/**
 * Count words in text and return the most common ones.
 */
export default function createSkill(ctx) {
	return {
		/**
		 * @param {string} text Text to analyze.
		 * @param {number} [top] How many of the most frequent words to return.
		 * @returns {Promise<string>} One `word: count` line per result.
		 */
		async run(text, top = 5) {
			const counts = new Map();
			for (const word of text.toLowerCase().split(/\s+/).filter(Boolean)) {
				counts.set(word, (counts.get(word) ?? 0) + 1);
			}
			return [...counts.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, top)
				.map(([word, count]) => `${word}: ${count}`)
				.join("\n");
		},
	};
}
```

## The Factory Contract

`skill.js` is an ESM module. The REPL imports it and calls its factory to build the API:

- `export default function createSkill(ctx)` — preferred. A named `export function createSkill(ctx)` works too and takes precedence over the default export.
- The factory may be async; the REPL awaits it.
- Whatever the factory returns is bound to the skill's global. Return an object of methods, or return a function (optionally with methods attached) to make the binding itself callable: `await edit(path, old, next)`.
- A module with no factory is bound as its own namespace — fine for a skill that only exports plain functions.
- A skill that throws while loading is skipped with a warning on stderr; it never stops the REPL from booting.

## The Skill Context

The factory receives one argument:

| Field | Type | Purpose |
|---|---|---|
| `hostRequest(type, payload)` | `(string, object) => Promise<any>` | Call a host handler (`goal.get`, `compact.run`, `agent_message.send`, `mcp.config`, …). This is how a skill reaches session state that lives in the host. |
| `display(payload)` | `({ mimeType, data }) => void` | Emit a display payload to the TUI. Image MIME types become context attachments; `application/vnd.optimus-prime.diff+json` renders an inline diff. |
| `cwd` | `string` | The REPL's working directory at call time. |
| `env` | `object` | The REPL child's environment. |

Write real JSDoc on every returned method: it is the skill's API documentation, and the agent reads it alongside `SKILL.md`.

## Dependencies

- Prefer the Bun and web standard library: `Bun.file`, `Bun.write`, `Bun.Glob`, `Bun.spawn`, `fetch`, `crypto`, `Buffer`, `TextEncoder`.
- Node builtins are available via `node:*` imports.
- Do not add npm dependencies for a bundled skill. A project-local skill may import from its own project, but the skill file is loaded by absolute path, so keep relative imports inside the skill directory.
- Editing `skill.js` takes effect on the next REPL start; there is no install step.

A JS skill runs inside the agent's REPL, so it can reach the host bridge for recursive sub-agents — useful for skills that delegate open-ended work.

## Verifying a JS Skill

1. Check the contract: skill name maps to a valid identifier and `skill.js` sits at the skill root.
2. Load it standalone, without the REPL:

   ```bash
   bun -e 'const f = (await import("./skill.js")).default; const api = await f({ hostRequest: async () => ({}), display() {}, cwd: process.cwd(), env: process.env }); console.log(await api.run("a b a", 1));'
   ```

3. In a fresh agent session, confirm the binding exists (`Object.keys(word_count)`) and `await word_count.run(...)` works.
