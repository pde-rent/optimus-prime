import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitObjectType } from "../src/core/git/objects.js";
import { applyDelta, PackReader } from "../src/core/git/pack-read.js";
import {
	buildPackBuffer,
	buildPackIdx,
	crc32,
	createDelta,
	packChecksum,
	scanPack,
	writePackFiles,
} from "../src/core/git/pack-write.js";
import { GitRepository } from "../src/core/git/repository.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GIT_VERSION = Bun.which("git") ? spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.trim() : "";
const HAS_GIT = GIT_VERSION.startsWith("git version");

let fixtureCounter = 0;
function makeTempDir(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${fixtureCounter++}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function gitOrThrow(cwd: string, args: string[]): Buffer {
	const proc = spawnSync("git", ["-C", cwd, ...args], { encoding: "buffer" });
	if (proc.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(proc.stderr)}`);
	return proc.stdout;
}

/** Fixture repo built by real git: two commits with delta-friendly history. */
function makeGitFixture(): Array<{ sha: string; type: GitObjectType; body: Uint8Array }> {
	const workdir = makeTempDir("pi-packwrite-fixture");
	gitOrThrow(workdir, ["init", "-b", "main"]);
	gitOrThrow(workdir, ["config", "user.name", "Fixture Bot"]);
	gitOrThrow(workdir, ["config", "user.email", "fixture@example.com"]);
	writeFileSync(join(workdir, "hello.txt"), "line one\nline two\nline three\n");
	mkdirSync(join(workdir, "lib"));
	writeFileSync(join(workdir, "lib", "util.txt"), "shared code\nshared more\n");
	writeFileSync(join(workdir, "run.sh"), "#!/bin/sh\necho hi\n");
	writeFileSync(join(workdir, "notes.md"), "# notes\nnested content\n".repeat(30));
	gitOrThrow(workdir, ["add", "."]);
	gitOrThrow(workdir, ["commit", "-m", "first"]);
	writeFileSync(join(workdir, "hello.txt"), "line one\nline two\nline three\nline four\nline five\nsix\nseven\n");
	writeFileSync(join(workdir, "notes.md"), `${"# notes\nnested content\n".repeat(30)}appended tail\n`);
	gitOrThrow(workdir, ["add", "."]);
	gitOrThrow(workdir, ["commit", "-m", "second"]);
	const repo = GitRepository.open(workdir)!;
	const shas = [
		...new Set(
			gitOrThrow(workdir, ["rev-list", "--objects", "--all"])
				.toString()
				.trim()
				.split("\n")
				.map((line) => line.split(" ")[0]),
		),
	];
	return shas.map((sha) => {
		const object = repo.readObject(sha)!;
		return { sha, type: object.type, body: object.body };
	});
}

function countEntryTypes(pack: Uint8Array): Map<number, number> {
	const types = new Map<number, number>();
	for (const entry of scanPack(pack).entries) types.set(entry.typeNumber, (types.get(entry.typeNumber) ?? 0) + 1);
	return types;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("pack write: pure helpers", () => {
	test("crc32 matches the known zlib test vector", () => {
		expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
	});

	test("createDelta round-trips through applyDelta with and without matches", () => {
		const encoder = new TextEncoder();
		const cases: Array<[Uint8Array, Uint8Array]> = [
			[encoder.encode(""), encoder.encode("only target")],
			[encoder.encode("only source"), encoder.encode("")],
			[encoder.encode("a\nb\nc\n"), encoder.encode("a\nb\nc\n")],
			[encoder.encode("x\n".repeat(200)), encoder.encode("x\n".repeat(100))],
			[encoder.encode("same prefix\n"), encoder.encode("same prefix\nplus a longer suffix that spans chunks\n")],
			[new Uint8Array(0), new Uint8Array([1, 2, 3])],
		];
		for (const [source, target] of cases) {
			const delta = createDelta(source, target);
			expect(Buffer.from(applyDelta(delta, source))).toEqual(Buffer.from(target));
		}
	});

	test("createDelta produces copy ops for repeated content", () => {
		const encoder = new TextEncoder();
		const source = encoder.encode(`${"the quick brown fox jumps over the lazy dog\n".repeat(20)}tail`);
		const target = encoder.encode(`head\n${"the quick brown fox jumps over the lazy dog\n".repeat(20)}tail`);
		const delta = createDelta(source, target);
		expect(delta.length).toBeLessThan(source.length / 2);
		expect(Buffer.from(applyDelta(delta, source))).toEqual(Buffer.from(target));
	});
});

// ---------------------------------------------------------------------------
// Cross-verified against real git
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_GIT)(`pack write: cross-verified against real git (${GIT_VERSION})`, () => {
	test("built pack + idx are consumed by git fsck / verify-pack and match index-pack output", () => {
		const objects = makeGitFixture();
		const built = buildPackBuffer(objects);

		// Our own scanner agrees on every object.
		const scanned = scanPack(built.pack);
		for (const object of objects) {
			const got = scanned.objects.get(object.sha);
			expect(got).toBeDefined();
			expect(Buffer.from(got!.body)).toEqual(Buffer.from(object.body));
		}
		expect(scanned.entries).toHaveLength(objects.length);

		// Install into an empty bare repo and let real git judge it.
		const bare = join(makeTempDir("pi-packwrite-bare"), "repo.git");
		gitOrThrow(bare.replace(/\/repo\.git$/, ""), ["init", "--bare", bare]);
		writeFileSync(join(bare, "objects", "pack", `pack-${packChecksum(built.pack)}.pack`), built.pack);
		writeFileSync(join(bare, "objects", "pack", `pack-${packChecksum(built.pack)}.idx`), buildPackIdx(built.pack));
		const fsck = spawnSync("git", ["-C", bare, "fsck", "--strict"], { encoding: "buffer" });
		expect(String(fsck.stderr)).not.toMatch(/error|corrupt|missing/);
		const verify = spawnSync(
			"git",
			["-C", bare, "verify-pack", "-v", join(bare, "objects", "pack", `pack-${packChecksum(built.pack)}.idx`)],
			{
				encoding: "buffer",
			},
		);
		expect(verify.status).toBe(0);

		// Every object readable through cat-file with identical bytes.
		for (const object of objects) {
			const expectedType = object.type;
			const actualType = gitOrThrow(bare, ["cat-file", "-t", object.sha]).toString().trim();
			expect(actualType).toBe(expectedType);
			const bytes = gitOrThrow(bare, ["cat-file", object.type, object.sha]);
			expect(bytes).toEqual(Buffer.from(object.body));
		}

		// The .idx we emit must be byte-identical to what git generates for this pack.
		const canonDir = makeTempDir("pi-packwrite-canon");
		const packPath = join(canonDir, "p.pack");
		writeFileSync(packPath, built.pack);
		gitOrThrow(canonDir, ["index-pack", "-o", "p.idx", "p.pack"]);
		const canonicalIdx = readFileSync(join(canonDir, "p.idx"));
		expect(canonicalIdx).toEqual(Buffer.from(buildPackIdx(built.pack)));
	});

	test("ofs-delta compression kicks in and stays correct", () => {
		const objects = makeGitFixture();
		const withDelta = buildPackBuffer(objects, { delta: true });
		const withoutDelta = buildPackBuffer(objects, { delta: false });

		const deltaTypes = countEntryTypes(withDelta.pack);
		const fullTypes = countEntryTypes(withoutDelta.pack);
		expect(deltaTypes.get(6)).toBeGreaterThan(0); // at least one ofs-delta emitted
		expect(fullTypes.get(6)).toBeUndefined(); // no ofs-delta when disabled
		expect(withDelta.pack.length).toBeLessThan(withoutDelta.pack.length);

		// Delta entries still resolve to the exact original bodies.
		const scanned = scanPack(withDelta.pack);
		for (const object of objects)
			expect(Buffer.from(scanned.objects.get(object.sha)!.body)).toEqual(Buffer.from(object.body));

		// PackReader (phase 1 reader) resolves our packs too.
		const reader = PackReader.fromBuffers(withDelta.pack, buildPackIdx(withDelta.pack));
		for (const object of objects)
			expect(Buffer.from(reader.read(object.sha)!.body)).toEqual(Buffer.from(object.body));
	});

	test("scanPack rejects corrupted packs", () => {
		const objects = makeGitFixture();
		const built = buildPackBuffer(objects);
		const corrupt = new Uint8Array(built.pack);
		corrupt[corrupt.length - 5] ^= 0xff; // flip a byte inside the trailer region payload
		expect(() => scanPack(corrupt)).toThrow(/checksum|mismatch|unexpected/i);
	});

	test("writePackFiles stores a PackReader-compatible pair named by trailer checksum", () => {
		const objects = makeGitFixture();
		const built = buildPackBuffer(objects);
		const gitDir = join(makeTempDir("pi-packwrite-store"), ".git");
		const repo = GitRepository.init(gitDir.replace(/\/\.git$/, ""));
		const checksum = writePackFiles(repo.gitDir, built.pack);
		const reader = PackReader.open(join(repo.gitDir, "objects", "pack", `pack-${checksum}.pack`));
		expect(reader.objectCount).toBe(objects.length);
		expect(reader.verifyPackChecksum()).toBe(true);
		for (const object of objects) {
			expect(reader.has(object.sha)).toBe(true);
			expect(Buffer.from(reader.read(object.sha)!.body)).toEqual(Buffer.from(object.body));
		}
		// And repo.readObject finds them through the normal object store path.
		for (const object of objects) {
			const got = repo.readObject(object.sha)!;
			expect(Buffer.from(got.body)).toEqual(Buffer.from(object.body));
		}
	});
});
