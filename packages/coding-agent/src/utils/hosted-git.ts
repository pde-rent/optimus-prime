/**
 * Parse the git URL shorthands npm accepts, replacing `hosted-git-info`.
 *
 * Only the fields this codebase reads are returned (`domain`, `user`, `project`, `committish`),
 * and only for the hosts it can actually resolve. Anything unrecognised returns null, which is
 * what the callers already branch on.
 */

export interface HostedGitInfo {
	/** Shorthand prefix for the host: `github`, `gitlab`, `bitbucket`, `gist`. */
	type: string;
	domain: string;
	user: string;
	project: string;
	/** Ref pinned with `#`, if any. */
	committish?: string;
}

const HOSTS: Record<string, string> = {
	github: "github.com",
	gitlab: "gitlab.com",
	bitbucket: "bitbucket.org",
	gist: "gist.github.com",
};

const DOMAIN_TO_TYPE: Record<string, string> = {
	"github.com": "github",
	"www.github.com": "github",
	"gitlab.com": "gitlab",
	"www.gitlab.com": "gitlab",
	"bitbucket.org": "bitbucket",
	"www.bitbucket.org": "bitbucket",
	"gist.github.com": "gist",
};

/** Strip a trailing `.git` and any surrounding slashes from a path segment. */
const clean = (value: string): string => value.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");

/** Split a trailing `#ref` off a url. */
function splitCommittish(url: string): { base: string; committish?: string } {
	const hash = url.indexOf("#");
	if (hash === -1) return { base: url };
	return { base: url.slice(0, hash), committish: url.slice(hash + 1) || undefined };
}

function build(type: string, domain: string, user: string, project: string, committish?: string): HostedGitInfo | null {
	// A shorthand missing either half is not a repo reference; `hosted-git-info` rejects these too.
	if (!user || !project) return null;
	return { type, domain, user, project: clean(project), committish };
}

export function fromUrl(input: string): HostedGitInfo | null {
	if (!input || typeof input !== "string") return null;
	const { base, committish } = splitCommittish(input.trim());
	if (!base) return null;

	// `github:user/repo` and friends.
	const shorthand = /^([a-z]+):(?!\/\/)(.+)$/i.exec(base);
	if (shorthand) {
		const domain = HOSTS[shorthand[1].toLowerCase()];
		if (!domain) return null;
		const [user, project] = clean(shorthand[2]).split("/");
		return build(shorthand[1].toLowerCase(), domain, user, project, committish);
	}

	// `git@github.com:user/repo.git`
	const scp = /^(?:([^@]+)@)?([^:/]+):(.+)$/.exec(base);
	if (scp && !base.includes("://")) {
		const type = DOMAIN_TO_TYPE[scp[2].toLowerCase()];
		if (!type) return null;
		const [user, project] = clean(scp[3]).split("/");
		return build(type, HOSTS[type], user, project, committish);
	}

	if (/^[a-z+]+:\/\//i.test(base)) {
		let parsed: URL;
		try {
			parsed = new URL(base);
		} catch {
			return null;
		}
		const type = DOMAIN_TO_TYPE[parsed.hostname.toLowerCase()];
		if (!type) return null;
		const segments = clean(parsed.pathname).split("/").filter(Boolean);
		// A gist url carries only the gist id, with no owner segment.
		if (type === "gist" && segments.length === 1) {
			return build(type, HOSTS[type], "", segments[0], committish);
		}
		return build(type, HOSTS[type], segments[0], segments[1], committish);
	}

	// Bare `user/repo`, which npm resolves against GitHub.
	const bare = clean(base).split("/");
	if (bare.length === 2) return build("github", HOSTS.github, bare[0], bare[1], committish);
	return null;
}

export default { fromUrl };
