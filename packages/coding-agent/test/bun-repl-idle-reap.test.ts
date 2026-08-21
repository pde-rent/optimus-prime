import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunReplProvisioner, type IdleReapClock, IdleReapScheduler } from "../src/core/bun-repl/provisioner.js";

function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Deterministic clock: time only moves via advance(), timers fire in due-time order. */
function fakeClock() {
	let now = 0;
	let nextId = 1;
	const timers = new Map<number, { fn: () => void; at: number }>();
	const clock: IdleReapClock = {
		now: () => now,
		setTimeout(fn, ms) {
			const id = nextId++;
			timers.set(id, { fn, at: now + ms });
			return id;
		},
		clearTimeout(handle) {
			timers.delete(handle as number);
		},
	};
	return {
		clock,
		get now() {
			return now;
		},
		pendingCount(): number {
			return timers.size;
		},
		advance(ms: number): void {
			const target = now + ms;
			for (;;) {
				const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				now = due[1].at;
				timers.delete(due[0]);
				due[1].fn();
			}
			now = target;
		},
	};
}

describe("IdleReapScheduler", () => {
	it("arms a single timer for the time remaining since the last touch", () => {
		const fake = fakeClock();
		let expired = 0;
		const scheduler = new IdleReapScheduler({ timeoutMs: 1000, clock: fake.clock, onExpire: () => expired++ });

		scheduler.arm();
		expect(fake.pendingCount()).toBe(1);

		fake.advance(400);
		scheduler.touch(); // activity resumes at t=400
		expect(fake.pendingCount()).toBe(0);

		scheduler.arm(); // re-armed at t=400: must fire 1000ms later, not 600ms later
		fake.advance(999);
		expect(expired).toBe(0);
		fake.advance(1);
		expect(expired).toBe(1);
	});

	it("touch cancels a pending reap", () => {
		const fake = fakeClock();
		let expired = 0;
		const scheduler = new IdleReapScheduler({ timeoutMs: 500, clock: fake.clock, onExpire: () => expired++ });

		scheduler.arm();
		fake.advance(499);
		scheduler.touch();
		fake.advance(10_000);
		expect(expired).toBe(0);
	});

	it("arm is idempotent while a timer is already pending", () => {
		const fake = fakeClock();
		let expired = 0;
		const scheduler = new IdleReapScheduler({ timeoutMs: 100, clock: fake.clock, onExpire: () => expired++ });

		scheduler.arm();
		scheduler.arm();
		expect(fake.pendingCount()).toBe(1);
		fake.advance(100);
		expect(expired).toBe(1);
	});

	it("never arms when the timeout is disabled", () => {
		const fake = fakeClock();
		let expired = 0;
		const scheduler = new IdleReapScheduler({ timeoutMs: 0, clock: fake.clock, onExpire: () => expired++ });

		scheduler.arm();
		expect(fake.pendingCount()).toBe(0);
		fake.advance(60_000);
		expect(expired).toBe(0);
	});
});

describe("BunReplProvisioner idle reaping", () => {
	let tempDir = "";

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "optimus-repl-idle-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	function makeProvisioner(idleTimeoutMs: number): BunReplProvisioner {
		return new BunReplProvisioner({
			cwd: tempDir,
			bunPath: "bun",
			snapshotDir: join(tempDir, "snapshots"),
			idleTimeoutMs,
		});
	}

	it("reaps an idle kernel and transparently restores its state on the next use", async () => {
		const provisioner = makeProvisioner(150);
		try {
			const first = await provisioner.ensure();
			await first.execute("globalThis.kept = 42");
			expect(provisioner.hasRunningKernel).toBe(true);

			await sleep(700);
			expect(provisioner.hasRunningKernel).toBe(false);

			const second = await provisioner.ensure();
			const r = await second.execute("kept");
			expect(r.status).toBe("ok");
			expect(r.result).toBe(JSON.stringify(42));
			expect(provisioner.lastRestore?.restoredNames).toContain("kept");
		} finally {
			await provisioner.dispose();
		}
	}, 20_000);

	it("does not reap while a cell is running, even if it outlasts the timeout", async () => {
		const provisioner = makeProvisioner(120);
		try {
			const manager = await provisioner.ensure();
			await manager.execute("1 + 1"); // settles, arming the reap timer

			const slow = await manager.execute("await new Promise((resolve) => setTimeout(resolve, 500))", {
				timeout: 30_000,
			});
			expect(slow.status).toBe("ok");
			// The cell outlived the idle timeout several times over; a reap mid-cell would have
			// killed the child and flagged the restart.
			expect(provisioner.hasRunningKernel).toBe(true);
			expect(slow.kernelRestarted).toBeFalsy();
		} finally {
			await provisioner.dispose();
		}
	}, 20_000);

	it("never reaps when the provisioner has no snapshot dir", async () => {
		const provisioner = new BunReplProvisioner({ cwd: tempDir, bunPath: "bun", idleTimeoutMs: 100 });
		try {
			await provisioner.ensure();
			await sleep(400);
			expect(provisioner.hasRunningKernel).toBe(true);
		} finally {
			await provisioner.dispose();
		}
	}, 20_000);

	it("reaping requires a live kernel: dispose() with nothing started is a no-op", async () => {
		const provisioner = makeProvisioner(150);
		await sleep(400);
		expect(provisioner.hasRunningKernel).toBe(false);
		await expect(provisioner.dispose()).resolves.toBeUndefined();
	}, 20_000);
});
