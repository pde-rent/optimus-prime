/**
 * Vitest-compatibility preload for `bun test`.
 *
 * `bun:test` already exports `vi` with the Jest/Vitest core (fn, spyOn, mock,
 * fake timers). This installs the handful of Vitest helpers Bun does not ship
 * natively so the migrated suites keep their original semantics:
 *
 *   waitFor / waitUntil, stubEnv / unstubAllEnvs, stubGlobal / unstubAllGlobals,
 *   hoisted, mocked, setSystemTime, the async timer helpers, importActual,
 *   `it.runIf` / `describe.runIf`, `expect.fail`, `toHaveBeenCalledBefore`.
 *
 * Loaded for every package through its `bunfig.toml` `[test] preload`, so the
 * ambient declarations in types/bun-test.d.ts always hold at runtime.
 */
import {
	afterEach,
	describe,
	expect,
	it,
	setDefaultTimeout,
	setSystemTime,
	test,
	vi,
} from "bun:test";

// The vitest.config.ts files this replaces all set testTimeout: 30_000.
setDefaultTimeout(30_000);

// Bun's fake timers patch the timer implementation itself, so a captured
// `setTimeout` reference is faked too. `setImmediate` is never faked, which
// makes it the only way to yield to the real event loop mid-test.
const realSetTimeout = globalThis.setTimeout;
const realSetImmediate = globalThis.setImmediate;

// biome-ignore lint/suspicious/noExplicitAny: patching Bun's runtime objects.
const viAny = vi as any;

/** Lets pending promise callbacks and real I/O run between timer advances. */
function flushMicrotasks(): Promise<void> {
	return new Promise<void>((resolve) => realSetImmediate(resolve));
}

// --- async fake-timer helpers ------------------------------------------------
// Vitest advances @sinonjs/fake-timers one due timer at a time, awaiting between
// each so a timer callback's promise continuation can schedule further timers
// inside the same window. Bun's advanceTimersByTime is synchronous, so slice the
// window and flush between slices: the total advance is identical and
// continuations still get to schedule follow-up timers within the window.
const ADVANCE_SLICES = 16;

async function advanceTimersByTimeAsync(ms: number): Promise<void> {
	await flushMicrotasks();
	// Bun's advanceTimersByTime(0) still pushes the fake clock forward by 1ms, so
	// a zero-length advance must only flush.
	if (ms <= 0) {
		await flushMicrotasks();
		return;
	}
	const slices = Math.min(ADVANCE_SLICES, Math.max(1, Math.floor(ms)));
	let advanced = 0;
	for (let i = 1; i <= slices; i++) {
		const target = Math.round((ms * i) / slices);
		if (target > advanced) vi.advanceTimersByTime(target - advanced);
		advanced = target;
		await flushMicrotasks();
	}
	if (ms > advanced) vi.advanceTimersByTime(ms - advanced);
}

async function advanceTimersToNextTimerAsync(): Promise<void> {
	await flushMicrotasks();
	vi.advanceTimersToNextTimer();
	await flushMicrotasks();
}

async function runAllTimersAsync(): Promise<void> {
	await flushMicrotasks();
	// Re-run: a flushed continuation may have queued more timers.
	for (let i = 0; i < ADVANCE_SLICES && vi.getTimerCount() > 0; i++) {
		vi.runAllTimers();
		await flushMicrotasks();
	}
}

async function runOnlyPendingTimersAsync(): Promise<void> {
	await flushMicrotasks();
	vi.runOnlyPendingTimers();
	await flushMicrotasks();
}

// --- waitFor -----------------------------------------------------------------

interface WaitForOptions {
	timeout?: number;
	interval?: number;
}

async function waitFor<T>(
	callback: () => T | Promise<T>,
	options: number | WaitForOptions = {},
): Promise<T> {
	const { timeout = 1000, interval = 50 } =
		typeof options === "number" ? { timeout: options } : options;
	const deadline = Date.now() + timeout;
	let lastError: unknown;
	for (;;) {
		try {
			return await callback();
		} catch (error) {
			lastError = error;
		}
		if (Date.now() >= deadline) break;
		if (vi.isFakeTimers()) {
			// Matches Vitest: a faked clock is nudged so timer-driven work settles.
			// Real sleeping is impossible here — Bun fakes setTimeout wholesale.
			vi.advanceTimersByTime(interval);
			await flushMicrotasks();
		} else {
			await new Promise<void>((resolve) => realSetTimeout(resolve, interval));
		}
	}
	throw lastError ?? new Error(`vi.waitFor timed out after ${timeout}ms`);
}

// --- env / global stubs ------------------------------------------------------

const envStubs = new Map<string, string | undefined>();
const globalStubs = new Map<string, { present: boolean; value: unknown }>();

function stubEnv(name: string, value: string | undefined): void {
	if (!envStubs.has(name)) envStubs.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function unstubAllEnvs(): void {
	for (const [name, original] of envStubs) {
		if (original === undefined) delete process.env[name];
		else process.env[name] = original;
	}
	envStubs.clear();
}

function stubGlobal(name: string, value: unknown): void {
	if (!globalStubs.has(name)) {
		globalStubs.set(name, {
			present: name in globalThis,
			value: (globalThis as Record<string, unknown>)[name],
		});
	}
	Object.defineProperty(globalThis, name, {
		value,
		writable: true,
		configurable: true,
		enumerable: true,
	});
}

function unstubAllGlobals(): void {
	for (const [name, original] of globalStubs) {
		if (original.present) {
			Object.defineProperty(globalThis, name, {
				value: original.value,
				writable: true,
				configurable: true,
				enumerable: true,
			});
		} else {
			delete (globalThis as Record<string, unknown>)[name];
		}
	}
	globalStubs.clear();
}

// process.env and globalThis outlive a single test file inside a `bun test`
// worker, so stubs are always unwound. Tests that call unstubAll* themselves are
// unaffected — the maps are empty by then.
afterEach(() => {
	unstubAllEnvs();
	unstubAllGlobals();
});

// --- install -----------------------------------------------------------------

Object.assign(viAny, {
	setSystemTime,
	advanceTimersByTimeAsync,
	advanceTimersToNextTimerAsync,
	runAllTimersAsync,
	runOnlyPendingTimersAsync,
	waitFor,
	waitUntil: waitFor,
	stubEnv,
	unstubAllEnvs,
	stubGlobal,
	unstubAllGlobals,
	// Vitest hoists vi.hoisted() above imports; Bun hoists vi.mock() factories
	// instead, and those factories only run lazily, so plain evaluation order in
	// the test file is already correct.
	hoisted: <T>(factory: () => T): T => factory(),
	mocked: <T>(value: T): T => value,
	importActual: <T>(specifier: string): Promise<T> => import(specifier) as Promise<T>,
	// ponytail: Bun has no module-registry reset. The one caller re-imports a
	// vi.mock()'d module, which Bun re-evaluates from the mock factory anyway.
	resetModules: () => {},
});

// --- expect extras -----------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: patching Bun's runtime objects.
const expectAny = expect as any;

expectAny.fail = (message = "expect.fail()"): never => {
	throw new Error(message);
};

/**
 * `expect.poll(fn).toMatchObject(...)` — re-evaluates `fn` until the matcher
 * passes or the timeout elapses. Returns a proxy so every matcher name works.
 */
expectAny.poll = (
	// biome-ignore lint/suspicious/noExplicitAny: mirrors Vitest's untyped poll target.
	callback: () => any,
	options: { timeout?: number; interval?: number } = {},
) =>
	new Proxy(
		{},
		{
			get(_target, matcher: string) {
				if (matcher === "not") return expectAny.poll(callback, { ...options, not: true });
				// biome-ignore lint/suspicious/noExplicitAny: matcher arguments are arbitrary.
				return (...args: any[]) =>
					waitFor(
						async () => {
							const value = await callback();
							// biome-ignore lint/suspicious/noExplicitAny: dynamic matcher dispatch.
							const target = (options as any).not ? expect(value).not : expect(value);
							// biome-ignore lint/suspicious/noExplicitAny: dynamic matcher dispatch.
							(target as any)[matcher](...args);
						},
						options,
					);
			},
		},
	);

expect.extend({
	// biome-ignore lint/suspicious/noExplicitAny: matcher receives arbitrary mocks.
	toHaveBeenCalledBefore(received: any, other: any) {
		const first = (calls: number[]) => (calls.length > 0 ? Math.min(...calls) : Number.NaN);
		const receivedFirst = first(received?.mock?.invocationCallOrder ?? []);
		const otherFirst = first(other?.mock?.invocationCallOrder ?? []);
		if (Number.isNaN(receivedFirst)) {
			return { pass: false, message: () => "expected mock to have been called" };
		}
		if (Number.isNaN(otherFirst)) {
			return { pass: false, message: () => "expected the other mock to have been called" };
		}
		return {
			pass: receivedFirst < otherFirst,
			message: () =>
				`expected mock (call #${receivedFirst}) to have been called before the other mock (call #${otherFirst})`,
			// biome-ignore lint/suspicious/noExplicitAny: expect.extend's matcher map is untyped here.
		} as any;
	},
	// biome-ignore lint/suspicious/noExplicitAny: expect.extend's matcher map is untyped here.
} as any);

// --- it.runIf / describe.runIf / .sequential --------------------------------
// biome-ignore lint/suspicious/noExplicitAny: patching Bun's runtime objects.
for (const fn of [it, test, describe] as any[]) {
	// Bun spells Vitest's runIf as `if`.
	if (typeof fn?.if === "function" && typeof fn.runIf !== "function") fn.runIf = fn.if.bind(fn);
	// Bun runs test files sequentially unless --concurrent is passed, so Vitest's
	// explicit `.sequential` opt-in is already the default behaviour.
	if (fn && typeof fn.sequential !== "function") fn.sequential = fn;
}
