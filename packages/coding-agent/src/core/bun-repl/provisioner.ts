import { type BunReplHostRequestHandler, BunReplManager, type BunReplManagerOptions } from "./index.js";
import { snapshotExists } from "./state-snapshot.js";

export interface BunReplProvisionerOptions {
	cwd?: string;
	env?: Record<string, string>;
	hostHandlers?: Record<string, BunReplHostRequestHandler>;
	snapshotDir?: string;
	bunPath?: string;
	readyGate?: Promise<void>;
	onRestore?: (restoredNames: string[]) => void;
}

export class BunReplProvisioner {
	private managerPromise?: Promise<BunReplManager>;
	private startedManager?: BunReplManager;
	private _lastRestore?: { restoredNames: string[] };
	private readonly disposeController = new AbortController();

	constructor(private readonly options: BunReplProvisionerOptions) {}

	get manager(): BunReplManager | undefined {
		return this.startedManager;
	}

	get lastRestore(): { restoredNames: string[] } | undefined {
		return this._lastRestore;
	}

	prewarm(): void {
		void this.ensure().catch(() => {});
	}

	get hasRunningKernel(): boolean {
		return this.startedManager?.isRunning ?? false;
	}

	async listNamespaceNames(_signal?: AbortSignal): Promise<string[] | null> {
		const m = this.startedManager ?? (await this.managerPromise?.catch(() => undefined));
		return (await m?.listNamespaceNames()) ?? null;
	}

	async dispose(): Promise<void> {
		this.disposeController.abort();
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (!pending) return;
		try {
			const m = await pending;
			await m.dispose();
		} catch {
			// failed startup already cleaned up
		}
	}

	async kill(): Promise<void> {
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (!pending) return;
		try {
			const m = await pending;
			await m.kill();
		} catch {
			// failed startup already cleaned up
		}
	}

	async ensure(signal?: AbortSignal): Promise<BunReplManager> {
		if (signal?.aborted) {
			throw new Error("Aborted");
		}

		if (!this.managerPromise) {
			const startup = this.startRepl(signal);
			this.managerPromise = startup;
			startup.then(
				(m) => {
					if (this.managerPromise === startup) {
						this.startedManager = m;
					}
				},
				() => {
					if (this.managerPromise === startup) {
						this.managerPromise = undefined;
					}
				},
			);
		}

		return this.managerPromise;
	}

	private async startRepl(signal?: AbortSignal): Promise<BunReplManager> {
		const managerOptions: BunReplManagerOptions = {
			cwd: this.options.cwd,
			env: this.options.env,
			hostHandlers: this.options.hostHandlers,
			snapshotDir: this.options.snapshotDir,
			bunPath: this.options.bunPath,
		};

		const manager = new BunReplManager(managerOptions);

		try {
			if (this.options.readyGate) {
				await this.options.readyGate.catch(() => {});
			}

			await manager.start(signal);

			if (this.options.snapshotDir) {
				const hasSnapshot = await snapshotExists(this.options.snapshotDir);
				if (hasSnapshot) {
					const restore = await manager.restoreState();
					if (restore) {
						this._lastRestore = restore;
						this.options.onRestore?.(restore.restoredNames);
					}
				}
			}

			return manager;
		} catch (error) {
			void manager.dispose();
			throw error;
		}
	}
}
