import * as os from "node:os";
import * as path from "node:path";
import { parseGitUrl } from "../../utils/git.js";
import type { AgentConnectionSourceInfo } from "../agent-connection/index.js";
import { theme } from "./theme/theme.js";

export function formatSplashCwd(cwd: string): string {
	const normalized = cwd.replace(/\\/g, "/");
	const home = os.homedir().replace(/\\/g, "/");
	if (home && normalized === home) {
		return "~";
	}
	if (home && normalized.startsWith(`${home}/`)) {
		return `~${normalized.slice(home.length)}`;
	}

	return normalized;
}

export function formatDisplayPath(p: string): string {
	const home = os.homedir();
	let result = p;

	// Replace home directory with ~
	if (result.startsWith(home)) {
		result = `~${result.slice(home.length)}`;
	}

	return result;
}

export function formatExtensionDisplayPath(pathStr: string): string {
	let result = formatDisplayPath(pathStr);
	result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
	return result;
}

function isPackageSource(sourceInfo?: AgentConnectionSourceInfo): boolean {
	const source = sourceInfo?.source ?? "";
	return source.startsWith("npm:") || source.startsWith("git:");
}

export function getShortPath(fullPath: string, sourceInfo?: AgentConnectionSourceInfo): string {
	const baseDir = sourceInfo?.baseDir;
	if (baseDir && isPackageSource(sourceInfo)) {
		const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
		if (
			relativePath &&
			relativePath !== "." &&
			!relativePath.startsWith("..") &&
			!relativePath.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relativePath)
		) {
			return relativePath.replace(/\\/g, "/");
		}
	}

	const source = sourceInfo?.source ?? "";
	const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
	if (npmMatch && source.startsWith("npm:")) {
		return npmMatch[2];
	}

	const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
	if (gitMatch && source.startsWith("git:")) {
		return gitMatch[1];
	}

	return formatDisplayPath(fullPath);
}

export function getCompactPathLabel(resourcePath: string, sourceInfo?: AgentConnectionSourceInfo): string {
	const shortPath = getShortPath(resourcePath, sourceInfo);
	const normalizedPath = shortPath.replace(/\\/g, "/");
	const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
	if (segments.length > 0) {
		return segments[segments.length - 1]!;
	}
	return shortPath;
}

export function getCompactDisplayPathSegments(resourcePath: string): string[] {
	return formatDisplayPath(resourcePath)
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== "~");
}

export function getDisplaySourceInfo(sourceInfo?: AgentConnectionSourceInfo): {
	label: string;
	scopeLabel?: string;
	color: "accent" | "muted";
} {
	const source = sourceInfo?.source ?? "local";
	const scope = sourceInfo?.scope ?? "project";
	if (source === "local") {
		if (scope === "user") {
			return { label: "user", color: "muted" };
		}
		if (scope === "project") {
			return { label: "project", color: "muted" };
		}
		if (scope === "temporary") {
			return { label: "path", scopeLabel: "temp", color: "muted" };
		}
		return { label: "path", color: "muted" };
	}

	if (source === "cli") {
		return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
	}

	const scopeLabel =
		scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
	return { label: source, scopeLabel, color: "accent" };
}

export function getScopeGroup(sourceInfo?: AgentConnectionSourceInfo): "user" | "project" | "path" {
	const source = sourceInfo?.source ?? "local";
	const scope = sourceInfo?.scope ?? "project";
	if (source === "cli" || scope === "temporary") return "path";
	if (scope === "user") return "user";
	if (scope === "project") return "project";
	return "path";
}

export function formatScopeGroups(
	groups: Array<{
		scope: "user" | "project" | "path";
		paths: Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>;
		packages: Map<string, Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>>;
	}>,
	options: {
		formatPath: (item: { path: string; sourceInfo?: AgentConnectionSourceInfo }) => string;
		formatPackagePath: (item: { path: string; sourceInfo?: AgentConnectionSourceInfo }, source: string) => string;
	},
): string {
	const lines: string[] = [];

	for (const group of groups) {
		lines.push(`  ${theme.fg("accent", group.scope)}`);

		const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
		for (const item of sortedPaths) {
			lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
		}

		const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
		for (const [source, items] of sortedPackages) {
			lines.push(`    ${theme.fg("mdLink", source)}`);
			const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPackagePaths) {
				lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
			}
		}
	}

	return lines.join("\n");
}

export function formatPathWithSource(p: string, sourceInfo?: AgentConnectionSourceInfo): string {
	if (sourceInfo) {
		const shortPath = getShortPath(p, sourceInfo);
		const { label, scopeLabel } = getDisplaySourceInfo(sourceInfo);
		const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
		return `${labelText} ${shortPath}`;
	}
	return formatDisplayPath(p);
}

export function getCompactPackageSourceLabel(sourceInfo?: AgentConnectionSourceInfo): string {
	const source = sourceInfo?.source ?? "";
	if (source.startsWith("npm:")) {
		return source.slice("npm:".length) || source;
	}

	const gitSource = parseGitUrl(source);
	if (gitSource) {
		return gitSource.path || source;
	}

	return source;
}

export function getCompactExtensionLabel(resourcePath: string, sourceInfo?: AgentConnectionSourceInfo): string {
	if (!isPackageSource(sourceInfo)) {
		return getCompactPathLabel(resourcePath, sourceInfo);
	}

	const sourceLabel = getCompactPackageSourceLabel(sourceInfo);
	if (!sourceLabel) {
		return getCompactPathLabel(resourcePath, sourceInfo);
	}

	const shortPath = getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
	const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
	const parsedPath = path.posix.parse(packagePath);

	if (parsedPath.name === "index") {
		return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
	}

	return `${sourceLabel}:${packagePath}`;
}

export function getCompactNonPackageExtensionLabel(
	resourcePath: string,
	index: number,
	allPaths: Array<{ path: string; segments: string[] }>,
): string {
	const segments = allPaths[index]?.segments;
	if (!segments || segments.length === 0) {
		return getCompactPathLabel(resourcePath);
	}

	for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
		const candidate = segments.slice(-segmentCount).join("/");
		const isUnique = allPaths.every((item, itemIndex) => {
			if (itemIndex === index) {
				return true;
			}
			return item.segments.slice(-segmentCount).join("/") !== candidate;
		});

		if (isUnique) {
			return candidate;
		}
	}

	return segments.join("/");
}

export function getCompactExtensionLabels(
	extensions: Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>,
): string[] {
	const nonPackageExtensions = extensions
		.map((extension) => {
			const segments = getCompactDisplayPathSegments(extension.path);
			const lastSegment = segments[segments.length - 1];
			if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
				segments.pop();
			}
			return {
				path: extension.path,
				sourceInfo: extension.sourceInfo,
				segments,
			};
		})
		.filter((extension) => !isPackageSource(extension.sourceInfo));

	return extensions.map((extension) => {
		if (isPackageSource(extension.sourceInfo)) {
			return getCompactExtensionLabel(extension.path, extension.sourceInfo);
		}

		const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
		if (nonPackageIndex === -1) {
			return getCompactPathLabel(extension.path, extension.sourceInfo);
		}

		return getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
	});
}

export function buildScopeGroups(items: Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>): Array<{
	scope: "user" | "project" | "path";
	paths: Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>;
	packages: Map<string, Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>>;
}> {
	const groups: Record<
		"user" | "project" | "path",
		{
			scope: "user" | "project" | "path";
			paths: Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>;
			packages: Map<string, Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>>;
		}
	> = {
		user: { scope: "user", paths: [], packages: new Map() },
		project: { scope: "project", paths: [], packages: new Map() },
		path: { scope: "path", paths: [], packages: new Map() },
	};

	for (const item of items) {
		const groupKey = getScopeGroup(item.sourceInfo);
		const group = groups[groupKey];
		const source = item.sourceInfo?.source ?? "local";

		if (isPackageSource(item.sourceInfo)) {
			const list = group.packages.get(source) ?? [];
			list.push(item);
			group.packages.set(source, list);
		} else {
			group.paths.push(item);
		}
	}

	return [groups.project, groups.user, groups.path].filter(
		(group) => group.paths.length > 0 || group.packages.size > 0,
	);
}
