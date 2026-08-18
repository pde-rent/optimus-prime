/**
 * Ambient types for Bun's `bun:test` runner.
 *
 * Bun builtins ship no ambient types in this repo's TypeScript setup (same
 * situation as `bun:ffi` in packages/tui/src/terminal.ts), and pulling in
 * `@types/bun` would add a dependency. This file declares exactly the surface
 * the test suites use.
 *
 * The `vi` object additionally carries the Vitest-compatibility helpers that
 * `scripts/test-preload.ts` installs at runtime (`waitFor`, `stubEnv`,
 * `stubGlobal`, `hoisted`, `mocked`, the async timer helpers, ...). Those are
 * declared here because the preload is the sole authority that provides them:
 * every `bun test` run in this repo loads it via `bunfig.toml`.
 */
declare module "bun:test" {
	type AnyFn = (...args: never[]) => unknown;

	interface MockResultReturn<R> {
		type: "return";
		value: R;
	}
	interface MockResultThrow {
		type: "throw";
		// biome-ignore lint/suspicious/noExplicitAny: matches Vitest, so reading
		// `results[i].value` off the union stays usable without narrowing.
		value: any;
	}
	interface MockResultIncomplete {
		type: "incomplete";
		value: undefined;
	}
	type MockResult<R> = MockResultReturn<R> | MockResultThrow | MockResultIncomplete;

	interface MockContext<A extends unknown[], R> {
		calls: A[];
		results: MockResult<R>[];
		instances: unknown[];
		contexts: unknown[];
		invocationCallOrder: number[];
		lastCall?: A;
	}

	// biome-ignore lint/suspicious/noExplicitAny: mock factories accept arbitrary signatures.
	export interface Mock<T extends (...args: any[]) => any = (...args: any[]) => any> {
		(...args: Parameters<T>): ReturnType<T>;
		readonly mock: MockContext<Parameters<T>, ReturnType<T>>;
		getMockName(): string;
		mockName(name: string): this;
		mockClear(): this;
		mockReset(): this;
		mockRestore(): void;
		getMockImplementation(): T | undefined;
		// Parameters<T>/ReturnType<T> normalise overloaded methods to their last
		// signature, matching how Vitest types mockImplementation.
		mockImplementation(fn: (...args: Parameters<T>) => ReturnType<T>): this;
		mockImplementationOnce(fn: (...args: Parameters<T>) => ReturnType<T>): this;
		mockReturnValue(value: ReturnType<T>): this;
		mockReturnValueOnce(value: ReturnType<T>): this;
		mockReturnThis(): this;
		mockResolvedValue(value: Awaited<ReturnType<T>>): this;
		mockResolvedValueOnce(value: Awaited<ReturnType<T>>): this;
		mockRejectedValue(value: unknown): this;
		mockRejectedValueOnce(value: unknown): this;
	}

	/** Vitest's `MockInstance` alias, kept so spy annotations read the same. */
	// biome-ignore lint/suspicious/noExplicitAny: matches Mock's default parameter.
	export type MockInstance<T extends (...args: any[]) => any = (...args: any[]) => any> = Mock<T>;

	// --- matchers ----------------------------------------------------------

	interface Matchers<T = unknown> {
		toBe(expected: unknown): void;
		toEqual(expected: unknown): void;
		toStrictEqual(expected: unknown): void;
		toMatchObject(expected: unknown): void;
		toMatch(expected: string | RegExp): void;
		toContain(expected: unknown): void;
		toContainEqual(expected: unknown): void;
		toHaveLength(expected: number): void;
		toHaveProperty(path: string | readonly (string | number)[], value?: unknown): void;
		toBeDefined(): void;
		toBeUndefined(): void;
		toBeNull(): void;
		toBeNaN(): void;
		toBeTruthy(): void;
		toBeFalsy(): void;
		toBeInstanceOf(expected: unknown): void;
		toBeGreaterThan(expected: number | bigint): void;
		toBeGreaterThanOrEqual(expected: number | bigint): void;
		toBeLessThan(expected: number | bigint): void;
		toBeLessThanOrEqual(expected: number | bigint): void;
		toBeCloseTo(expected: number, precision?: number): void;
		toThrow(expected?: string | RegExp | Error | (new (...args: never[]) => Error)): void;
		toThrowError(expected?: string | RegExp | Error | (new (...args: never[]) => Error)): void;
		toMatchInlineSnapshot(snapshot?: string): void;
		toMatchSnapshot(hint?: string): void;
		toHaveBeenCalled(): void;
		toHaveBeenCalledOnce(): void;
		toHaveBeenCalledTimes(times: number): void;
		toHaveBeenCalledWith(...args: unknown[]): void;
		toHaveBeenLastCalledWith(...args: unknown[]): void;
		toHaveBeenNthCalledWith(nth: number, ...args: unknown[]): void;
		/** Installed by scripts/test-preload.ts via `expect.extend`. */
		toHaveBeenCalledBefore(other: unknown): void;
		toHaveReturned(): void;
		toHaveReturnedTimes(times: number): void;
		toHaveReturnedWith(value: unknown): void;
		toBeOneOf(expected: readonly unknown[]): void;
		readonly not: Matchers<T>;
	}

	interface AsyncMatchers<T = unknown> extends Matchers<T> {
		toBe(expected: unknown): Promise<void>;
		toEqual(expected: unknown): Promise<void>;
		toStrictEqual(expected: unknown): Promise<void>;
		toMatchObject(expected: unknown): Promise<void>;
		toThrow(expected?: string | RegExp | Error | (new (...args: never[]) => Error)): Promise<void>;
		toThrowError(
			expected?: string | RegExp | Error | (new (...args: never[]) => Error),
		): Promise<void>;
		readonly not: AsyncMatchers<T>;
	}

	interface Expectation<T> extends Matchers<T> {
		readonly resolves: AsyncMatchers<Awaited<T>>;
		readonly rejects: AsyncMatchers<unknown>;
	}

	interface CustomMatcherResult {
		pass: boolean;
		message: () => string;
	}

	interface ExpectStatic {
		<T>(actual: T, customMessage?: string): Expectation<T>;
		// biome-ignore lint/suspicious/noExplicitAny: asymmetric matchers are untyped by design.
		any(constructor: unknown): any;
		// biome-ignore lint/suspicious/noExplicitAny: asymmetric matchers are untyped by design.
		anything(): any;
		// biome-ignore lint/suspicious/noExplicitAny: asymmetric matchers are untyped by design.
		arrayContaining(expected: readonly unknown[]): any;
		// biome-ignore lint/suspicious/noExplicitAny: asymmetric matchers are untyped by design.
		objectContaining(expected: Record<string, unknown>): any;
		// biome-ignore lint/suspicious/noExplicitAny: asymmetric matchers are untyped by design.
		stringContaining(expected: string): any;
		// biome-ignore lint/suspicious/noExplicitAny: asymmetric matchers are untyped by design.
		stringMatching(expected: string | RegExp): any;
		// biome-ignore lint/suspicious/noExplicitAny: asymmetric matchers are untyped by design.
		closeTo(expected: number, precision?: number): any;
		// biome-ignore lint/suspicious/noExplicitAny: asymmetric matchers are untyped by design.
		not: any;
		assertions(count: number): void;
		hasAssertions(): void;
		unreachable(message?: string): never;
		/** Installed by scripts/test-preload.ts. */
		fail(message?: string): never;
		/** Installed by scripts/test-preload.ts. */
		poll<T>(
			callback: () => T | Promise<T>,
			options?: { timeout?: number; interval?: number },
		): AsyncMatchers<Awaited<T>>;
		extend(matchers: Record<string, (...args: never[]) => CustomMatcherResult>): void;
		addSnapshotSerializer(serializer: unknown): void;
	}

	export const expect: ExpectStatic;

	// --- test declaration --------------------------------------------------

	interface TestOptions {
		timeout?: number;
		retry?: number;
		repeats?: number;
	}
	type TestBody = (() => void | Promise<unknown>) | ((done: (err?: unknown) => void) => void);

	interface EachFn {
		// The `| [any]` member makes TypeScript infer array literals as tuples, so
		// `it.each([[1, "a"], [2, "b"]])` types the callback as (number, string).
		// biome-ignore lint/suspicious/noExplicitAny: required for tuple inference.
		<T extends any[] | [any]>(
			table: readonly T[],
		): (name: string, fn: (...args: T) => void | Promise<unknown>, timeout?: number) => void;
		// biome-ignore lint/suspicious/noExplicitAny: `as const` tables are readonly tuples.
		<T extends readonly any[]>(
			table: readonly T[],
		): (name: string, fn: (...args: [...T]) => void | Promise<unknown>, timeout?: number) => void;
		<T>(
			table: readonly T[],
		): (name: string, fn: (arg: T) => void | Promise<unknown>, timeout?: number) => void;
	}

	interface TestFn {
		(name: string, fn: TestBody, timeout?: number): void;
		(name: string, options: TestOptions, fn: TestBody): void;
		only: TestFn;
		skip: TestFn;
		todo: (name: string, fn?: TestBody, timeout?: number) => void;
		failing: TestFn;
		each: EachFn;
		if: (condition: boolean) => TestFn;
		skipIf: (condition: boolean) => TestFn;
		todoIf: (condition: boolean) => TestFn;
		/** Installed by scripts/test-preload.ts (Vitest spelling of `if`). */
		runIf: (condition: boolean) => TestFn;
		concurrent: TestFn;
		/** Bun runs tests sequentially by default; kept for source compatibility. */
		sequential: TestFn;
	}

	interface DescribeFn {
		(name: string, fn: () => void): void;
		(name: string, options: TestOptions, fn: () => void): void;
		only: DescribeFn;
		skip: DescribeFn;
		todo: (name: string, fn?: () => void) => void;
		failing: DescribeFn;
		each: EachFn;
		if: (condition: boolean) => DescribeFn;
		skipIf: (condition: boolean) => DescribeFn;
		todoIf: (condition: boolean) => DescribeFn;
		/** Installed by scripts/test-preload.ts (Vitest spelling of `if`). */
		runIf: (condition: boolean) => DescribeFn;
		/** Bun runs tests sequentially by default; kept for source compatibility. */
		sequential: DescribeFn;
		concurrent: DescribeFn;
	}

	export const test: TestFn;
	export const it: TestFn;
	export const describe: DescribeFn;

	type HookBody = (() => void | Promise<unknown>) | ((done: (err?: unknown) => void) => void);
	export function beforeAll(fn: HookBody, timeout?: number): void;
	export function beforeEach(fn: HookBody, timeout?: number): void;
	export function afterAll(fn: HookBody, timeout?: number): void;
	export function afterEach(fn: HookBody, timeout?: number): void;
	export function setDefaultTimeout(ms: number): void;
	export function setSystemTime(time?: Date | number): void;

	// --- mocking -----------------------------------------------------------

	interface MockModuleFn {
		(specifier: string, factory: () => unknown | Promise<unknown>): void | Promise<void>;
	}
	interface MockFn {
		// biome-ignore lint/suspicious/noExplicitAny: mock factories accept arbitrary signatures.
		<T extends (...args: any[]) => any>(fn?: T): Mock<T>;
		module: MockModuleFn;
		restore(): void;
		clearAllMocks(): void;
	}
	export const mock: MockFn;

	// biome-ignore lint/suspicious/noExplicitAny: fallback for non-function members.
	type AsFn<V> = V extends (...args: any[]) => any ? V : (...args: any[]) => any;
	export function spyOn<T extends object, K extends keyof T>(obj: T, method: K): Mock<AsFn<T[K]>>;
	export function spyOn<T extends object, K extends keyof T>(
		obj: T,
		method: K,
		accessType: "get",
	): Mock<() => T[K]>;
	export function spyOn<T extends object, K extends keyof T>(
		obj: T,
		method: K,
		accessType: "set",
	): Mock<(value: T[K]) => void>;

	interface FakeTimerOptions {
		now?: number | Date;
		toFake?: readonly string[];
		shouldAdvanceTime?: boolean;
		advanceTimeDelta?: number;
	}

	interface WaitForOptions {
		timeout?: number;
		interval?: number;
	}

	/**
	 * Bun's Vitest-compatible façade, extended by scripts/test-preload.ts with
	 * the helpers Bun does not ship natively.
	 */
	interface Vi {
		// biome-ignore lint/suspicious/noExplicitAny: mock factories accept arbitrary signatures.
		fn<T extends (...args: any[]) => any>(fn?: T): Mock<T>;
		spyOn<T extends object, K extends keyof T>(obj: T, method: K): Mock<AsFn<T[K]>>;
		spyOn<T extends object, K extends keyof T>(obj: T, method: K, accessType: "get"): Mock<() => T[K]>;
		spyOn<T extends object, K extends keyof T>(
			obj: T,
			method: K,
			accessType: "set",
		): Mock<(value: T[K]) => void>;
		mock(specifier: string, factory: () => unknown | Promise<unknown>): void | Promise<void>;

		clearAllMocks(): void;
		resetAllMocks(): void;
		restoreAllMocks(): void;

		useFakeTimers(options?: FakeTimerOptions): void;
		useRealTimers(): void;
		isFakeTimers(): boolean;
		advanceTimersByTime(ms: number): void;
		advanceTimersToNextTimer(): void;
		runAllTimers(): void;
		runOnlyPendingTimers(): void;
		clearAllTimers(): void;
		getTimerCount(): number;

		// --- installed by scripts/test-preload.ts ---
		setSystemTime(time?: Date | number): void;
		advanceTimersByTimeAsync(ms: number): Promise<void>;
		advanceTimersToNextTimerAsync(): Promise<void>;
		runAllTimersAsync(): Promise<void>;
		runOnlyPendingTimersAsync(): Promise<void>;
		waitFor<T>(callback: () => T | Promise<T>, options?: number | WaitForOptions): Promise<T>;
		waitUntil<T>(callback: () => T | Promise<T>, options?: number | WaitForOptions): Promise<T>;
		stubEnv(name: string, value: string | undefined): void;
		unstubAllEnvs(): void;
		stubGlobal(name: string, value: unknown): void;
		unstubAllGlobals(): void;
		hoisted<T>(factory: () => T): T;
		// biome-ignore lint/suspicious/noExplicitAny: mirrors Vitest's MockedFunction.
		mocked<T>(value: T): T extends (...args: any[]) => any ? Mock<T> & T : T;
		importActual<T = Record<string, unknown>>(specifier: string): Promise<T>;
		resetModules(): void;
	}

	export const vi: Vi;
	export const jest: Vi;
}
