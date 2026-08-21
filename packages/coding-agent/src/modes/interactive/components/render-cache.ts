/**
 * Shared width+version keyed cache for components whose render() rebuilds a
 * fixed set of lines. `version` is any component-owned counter that changes
 * whenever the rendered content changes (animation tick, grid version, ...).
 */
export class LineRenderCache {
	private width = -1;
	private version = -1;
	private lines: string[] = [];

	get(width: number, version: number): string[] | undefined {
		return width === this.width && version === this.version ? this.lines : undefined;
	}

	set(width: number, version: number, lines: string[]): string[] {
		this.width = width;
		this.version = version;
		this.lines = lines;
		return lines;
	}

	invalidate(): void {
		this.width = -1;
	}
}
