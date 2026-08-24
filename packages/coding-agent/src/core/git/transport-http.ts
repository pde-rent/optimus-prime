import { concatBytes } from "./objects.js";

/**
 * Smart HTTP transport (protocol v0/v1): pkt-line framing, ref discovery,
 * fetch-pack and send-pack over POST, side-band-64k demux, token/URL auth.
 * HTTP-only by design; no SSH transport and no credential helpers.
 * Spec: Documentation/gitprotocol-http.txt + gitprotocol-pack.txt in git.git.
 */

export const UPLOAD_PACK_SERVICE = "git-upload-pack";
export const RECEIVE_PACK_SERVICE = "git-receive-pack";

export const ZERO_OID = "0".repeat(40);

// -- pkt-line framing ---------------------------------------------------------

const FLUSH_PKT = new TextEncoder().encode("0000");

/** Encode one data pkt-line; the 4-hex length prefix includes itself. */
export function encodePktLine(payload: string | Uint8Array): Uint8Array {
	const body = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
	if (body.length > 65516) throw new Error(`pkt-line payload too large: ${body.length}`);
	const out = new Uint8Array(4 + body.length);
	out.set(new TextEncoder().encode(lengthHex(body.length + 4)), 0);
	out.set(body, 4);
	return out;
}

function encodeFlushPkt(): Uint8Array {
	return FLUSH_PKT.slice();
}

function lengthHex(value: number): string {
	return value.toString(16).toLowerCase().padStart(4, "0");
}

/** Sequential pkt-line reader over an in-memory buffer. */
export class PktLineReader {
	private at = 0;
	constructor(private readonly data: Uint8Array) {}

	/** Next data pkt payload, null for a flush pkt, undefined when exhausted. */
	next(): Uint8Array | null | undefined {
		if (this.at + 4 > this.data.length) return undefined;
		const hex = new TextDecoder().decode(this.data.subarray(this.at, this.at + 4));
		if (!/^[0-9a-f]{4}$/.test(hex)) throw new Error(`bad pkt-line length prefix: ${JSON.stringify(hex)}`);
		const length = Number.parseInt(hex, 16);
		if (length === 0) {
			this.at += 4;
			return null; // flush
		}
		if (length === 1 || length === 2 || length < 4) throw new Error(`unsupported pkt-line length: ${length}`);
		if (this.at + length > this.data.length) throw new Error("truncated pkt-line");
		const payload = this.data.subarray(this.at + 4, this.at + length);
		this.at += length;
		return payload;
	}

	/** All bytes from the current position to the end (e.g. a raw packfile tail). */
	rest(): Uint8Array {
		return this.data.subarray(this.at);
	}

	get exhausted(): boolean {
		return this.at >= this.data.length;
	}
}

function pktText(payload: Uint8Array): string {
	return new TextDecoder().decode(payload);
}

// -- auth ---------------------------------------------------------------------

export interface RemoteCredentials {
	username?: string;
	password?: string;
	/** Bearer-style token (GitHub PAT / app token); sent as Basic x-access-token:<token>. */
	token?: string;
}

interface ResolvedAuth {
	/** URL with any embedded userinfo removed; safe to log and to fetch. */
	url: string;
	/** Value for the Authorization header, or null when anonymous. */
	authorization: string | null;
}

function basicAuth(username: string, password: string): string {
	return `Basic ${btoa(`${username}:${password}`)}`;
}

function percentDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Credentials for a remote URL: explicit options win, then URL-embedded
 * userinfo, then the GIT_TOKEN / GITHUB_TOKEN environment pattern. No
 * credential-helper subprocesses are ever spawned.
 */
export function resolveRemoteAuth(rawUrl: string, credentials?: RemoteCredentials): ResolvedAuth {
	if (credentials?.token) {
		return { url: stripUserInfo(rawUrl), authorization: basicAuth("x-access-token", credentials.token) };
	}
	if (credentials?.username && credentials?.password) {
		return {
			url: stripUserInfo(rawUrl),
			authorization: basicAuth(credentials.username, credentials.password),
		};
	}
	const match = /^([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)(?::([^\s/@]*))?@/.exec(rawUrl);
	if (match) {
		const user = percentDecode(match[2]);
		const pass = percentDecode(match[3] ?? "");
		return { url: stripUserInfo(rawUrl), authorization: basicAuth(user, pass) };
	}
	const token = process.env.GIT_TOKEN ?? process.env.GITHUB_TOKEN;
	if (token) return { url: rawUrl, authorization: basicAuth("x-access-token", token) };
	return { url: rawUrl, authorization: null };
}

function stripUserInfo(rawUrl: string): string {
	return rawUrl.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)(?::([^\s/@]*))?@/, "$1");
}

// -- ref discovery ------------------------------------------------------------

type PackService = typeof UPLOAD_PACK_SERVICE | typeof RECEIVE_PACK_SERVICE;

interface RefAdvertisement {
	/** refname -> oid; excludes peeled "^{}" entries and the empty-repo sentinel. */
	refs: Map<string, string>;
	/** tagname -> peeled oid (from "<tag>^{}" advertisement lines). */
	peeled: Map<string, string>;
	capabilities: Set<string>;
}

export class GitHttpError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: string,
	) {
		super(message);
	}
}

function serviceUrl(url: string, service: PackService, query: string): string {
	return `${url.replace(/\/+$/, "")}/info/refs?service=${service}${query}`;
}

/** Shared smart-HTTP POST: service headers, auth, non-OK -> GitHttpError with a body snippet. */
async function postService(
	_url: string,
	service: PackService,
	body: Uint8Array,
	auth: ResolvedAuth,
): Promise<Uint8Array> {
	const response = await fetch(`${auth.url.replace(/\/+$/, "")}/${service}`, {
		method: "POST",
		headers: {
			"Content-Type": `application/x-${service}-request`,
			Accept: `application/x-${service}-result`,
			"Git-Protocol": "version=1",
			...(auth.authorization ? { Authorization: auth.authorization } : {}),
		},
		body: new Blob([body]),
	});
	if (!response.ok) {
		const errBody = new Uint8Array(await response.arrayBuffer());
		throw new GitHttpError(`${service} failed with HTTP ${response.status}`, response.status, snippet(errBody));
	}
	return new Uint8Array(await response.arrayBuffer());
}

async function httpGet(url: string, authorization: string | null): Promise<Response> {
	const headers: Record<string, string> = { "Git-Protocol": "version=1" };
	if (authorization) headers.Authorization = authorization;
	const response = await fetch(url, { headers, redirect: "follow" });
	if (response.status === 401 || response.status === 403) {
		throw new GitHttpError(`authentication failed for ${url} (${response.status})`, response.status, "");
	}
	return response;
}

/**
 * GET /info/refs?service=<service>: parse the pkt-line ref advertisement.
 * The capabilities ride behind a NUL byte on the first advertised ref only.
 */
export async function discoverRefs(_url: string, service: PackService, auth: ResolvedAuth): Promise<RefAdvertisement> {
	const response = await httpGet(serviceUrl(auth.url, service, ""), auth.authorization);
	const body = new Uint8Array(await response.arrayBuffer());
	const contentType = response.headers.get("content-type") ?? "";
	if (!response.ok) {
		throw new GitHttpError(
			`${service} discovery failed with HTTP ${response.status}`,
			response.status,
			snippet(body),
		);
	}
	if (!contentType.startsWith(`application/x-${service}-advertisement`)) {
		throw new GitHttpError(
			`unexpected content-type ${contentType}; not a smart HTTP server`,
			response.status,
			snippet(body),
		);
	}
	const reader = new PktLineReader(body);
	const first = reader.next();
	if (first === null || first === undefined || !pktText(first).startsWith(`# service=${service}`)) {
		throw new GitHttpError(
			"malformed ref advertisement: missing service header line",
			response.status,
			snippet(body),
		);
	}
	const flush = reader.next();
	if (flush !== null) throw new Error("malformed ref advertisement: expected flush after service header");

	const refs = new Map<string, string>();
	const peeled = new Map<string, string>();
	let capabilities = new Set<string>();
	for (;;) {
		const line = reader.next();
		if (line === undefined) break;
		if (line === null) break;
		const text = pktText(line).replace(/\n$/, "");
		const nul = text.indexOf("\0");
		const head = nul === -1 ? text : text.slice(0, nul);
		if (nul !== -1)
			capabilities = new Set(
				text
					.slice(nul + 1)
					.split(/\s+/)
					.filter(Boolean),
			);
		const space = head.indexOf(" ");
		if (space === -1) continue;
		const oid = head.slice(0, space);
		const refName = head.slice(space + 1);
		if (refName.endsWith("^{}")) peeled.set(refName.slice(0, -3), oid);
		else if (oid !== ZERO_OID) refs.set(refName, oid);
		else capabilities.add("capabilities"); // empty repo: "<zero-id> capabilities^{}\0<caps>"
	}
	return { refs, peeled, capabilities };
}

function snippet(body: Uint8Array): string {
	const text = new TextDecoder().decode(body.subarray(0, 400));
	return text.replace(/[^\x20-\x7e\n\t]/g, ".");
}

// -- fetch-pack ---------------------------------------------------------------

interface UploadPackRequest {
	/** "want <oid>" lines (capabilities are appended to the first by this module). */
	wants: string[];
	/** Local tips to negotiate with ("have" lines). */
	haves: string[];
	/** Requested capability string for the first want line. */
	capabilities: string;
	/** Commit depth for shallow clones ("deepen <n>"). */
	depth?: number;
}

interface UploadPackResult {
	/** OIDs from final "ACK <oid>" lines (empty when nothing was common). */
	acks: string[];
	/** OIDs from "shallow <oid>" lines (grafts; parents not sent). */
	shallow: string[];
	/** OIDs from "unshallow <oid>" lines. */
	unshallow: string[];
	/** Demultiplexed packfile bytes; null when the server sent none. */
	pack: Uint8Array | null;
}

/**
 * POST /git-upload-pack and parse the response: shallow/unshallow section,
 * ACK/NAK line, then a side-band-64k multiplexed packfile. Channel 2 goes to
 * onProgress; channel 3 aborts with the server's error text.
 */
export async function postUploadPack(
	_url: string,
	request: UploadPackRequest,
	auth: ResolvedAuth,
	options: { onProgress?: (text: string) => void } = {},
): Promise<UploadPackResult> {
	const lines: Uint8Array[] = [];
	request.wants.forEach((oid, index) => {
		lines.push(encodePktLine(index === 0 ? `want ${oid} ${request.capabilities}\n` : `want ${oid}\n`));
	});
	if (request.wants.length === 0) throw new Error("upload-pack request without wants");
	if (request.depth !== undefined && request.depth > 0) lines.push(encodePktLine(`deepen ${request.depth}\n`));
	lines.push(encodeFlushPkt());
	for (const oid of request.haves) lines.push(encodePktLine(`have ${oid}\n`));
	lines.push(encodePktLine("done\n"));

	const reader = new PktLineReader(await postService(_url, "git-upload-pack", concatBytes(...lines), auth));

	const shallow: string[] = [];
	const unshallow: string[] = [];
	for (;;) {
		const line = reader.next();
		if (line === undefined) return { acks: [], shallow, unshallow, pack: null };
		if (line === null) break; // end of shallow-info section
		const text = pktText(line).trim();
		if (text.startsWith("shallow ")) shallow.push(text.slice("shallow ".length));
		else if (text.startsWith("unshallow ")) unshallow.push(text.slice("unshallow ".length));
		else break; // no deepen sent: the ACK/NAK can follow without a shallow section
	}

	const acks: string[] = [];
	for (;;) {
		const line = reader.next();
		if (line === undefined) return { acks, shallow, unshallow, pack: null };
		if (line === null) continue;
		const text = pktText(line).trim();
		if (text === "NAK") break;
		if (text.startsWith("ACK")) {
			const oid = text.split(/\s+/)[1];
			if (oid && /^[0-9a-f]{40}$/.test(oid)) acks.push(oid);
			// multi_ack variants carry suffixes ("continue"/"ready"/"common"); keep reading.
			if (/^ACK [0-9a-f]{40}$/.test(text)) break;
			continue;
		}
		break;
	}

	const packChunks: Uint8Array[] = [];
	for (;;) {
		const line = reader.next();
		if (line === undefined) break;
		if (line === null) continue;
		const channel = line[0];
		const payload = line.subarray(1);
		if (channel === 1) packChunks.push(payload);
		else if (channel === 2) options.onProgress?.(pktText(payload));
		else if (channel === 3) throw new Error(`fetch failed server-side: ${pktText(payload).trim()}`);
	}
	return { acks, shallow, unshallow, pack: packChunks.length > 0 ? concatBytes(...packChunks) : null };
}

// -- send-pack ----------------------------------------------------------------

export interface PushCommand {
	/** Old oid, or ZERO_OID to create. */
	oldOid: string;
	/** New oid, or ZERO_OID to delete. */
	newOid: string;
	refName: string;
}

interface PushReportEntry {
	refName: string;
	ok: boolean;
	reason?: string;
}

interface PushReport {
	unpackOk: boolean;
	unpackReason?: string;
	commands: PushReportEntry[];
}

/**
 * Build a git-receive-pack request body: command pkt-lines (capabilities on
 * the first), flush, then the RAW packfile (never side-band muxed here).
 */
export function buildReceivePackRequest(
	commands: PushCommand[],
	pack: Uint8Array | null,
	capabilities: string,
): Uint8Array {
	const lines: Uint8Array[] = [];
	commands.forEach((command, index) => {
		const base = `${command.oldOid} ${command.newOid} ${command.refName}`;
		lines.push(encodePktLine(index === 0 ? `${base}\0${capabilities}\n` : `${base}\n`));
	});
	lines.push(encodeFlushPkt());
	if (pack) lines.push(pack);
	return concatBytes(...lines);
}

/** POST /git-receive-pack and parse the report-status response. */
export async function postReceivePack(
	_url: string,
	body: Uint8Array,
	auth: ResolvedAuth,
	_options: { onProgress?: (text: string) => void } = {},
): Promise<PushReport> {
	const reader = new PktLineReader(await postService(_url, "git-receive-pack", body, auth));
	// We never request side-band-64k for push, so the report-status reply is
	// plain pkt-lines: "unpack ok|ng <reason>", then "ok|ng <ref> [<reason>]".
	const report: PushReport = { unpackOk: true, commands: [] };
	let sawStatus = false;
	for (;;) {
		const line = reader.next();
		if (line === undefined) break;
		if (line === null) continue;
		const text = pktText(line).trim();
		if (text.startsWith("unpack ")) {
			sawStatus = true;
			if (text !== "unpack ok") {
				report.unpackOk = false;
				report.unpackReason = text.slice("unpack ".length);
			}
		} else if (text.startsWith("ok ")) {
			sawStatus = true;
			report.commands.push({ refName: text.slice(3), ok: true });
		} else if (text.startsWith("ng ")) {
			sawStatus = true;
			const rest = text.slice(3);
			const space = rest.indexOf(" ");
			report.commands.push({
				refName: space === -1 ? rest : rest.slice(0, space),
				ok: false,
				reason: space === -1 ? "failed" : rest.slice(space + 1),
			});
		}
	}
	if (!sawStatus) throw new Error("receive-pack returned no report-status despite being requested");
	return report;
}
