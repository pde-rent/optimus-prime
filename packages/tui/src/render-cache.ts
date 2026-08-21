type RenderCacheKey = ReadonlyArray<string | number | boolean | undefined>;

/**
 * Single-slot memo for component render output.
 *
 * The key carries everything that can change the rendered lines (text content,
 * width, mode flags, ...); a hit returns the previous lines unchanged.
 */
export class KeyedRenderCache {
	private cachedKey?: RenderCacheKey;
	private cachedLines?: string[];

	get(...key: RenderCacheKey): string[] | undefined {
		const cachedKey = this.cachedKey;
		if (cachedKey === undefined || this.cachedLines === undefined) return undefined;
		if (cachedKey.length !== key.length) return undefined;
		for (let i = 0; i < key.length; i++) {
			if (cachedKey[i] !== key[i]) return undefined;
		}
		return this.cachedLines;
	}

	set(key: RenderCacheKey, lines: string[]): string[] {
		this.cachedKey = key;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedKey = undefined;
		this.cachedLines = undefined;
	}
}

export class VersionedRenderCache {
	private cache = new KeyedRenderCache();

	get(width: number, version: number): string[] | undefined {
		return this.cache.get(width, version);
	}

	set(width: number, version: number, lines: string[]): string[] {
		return this.cache.set([width, version], lines);
	}

	invalidate(): void {
		this.cache.invalidate();
	}
}
