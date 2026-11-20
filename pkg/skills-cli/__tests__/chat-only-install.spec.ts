/**
 * bootstrap.sh --chat-only: downloads only the checksum-verified chat skills bundle and unpacks it
 * into one folder. No runtime, bundle, launchers or extension, and nothing it unpacks is run.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { present, removeBootstrapDirs, removeBootstrapFixtures, runBootstrap, sha256 } from "./bootstrap-fixtures";

const VERSION = "1.27.0";
const ASSET = `dg-chat-skills-${VERSION}.zip`;
const made: string[] = [];

afterEach(removeBootstrapDirs);
afterAll(() => {
	removeBootstrapFixtures();
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A bundle zip holding the given entry names, each a small text file. */
function bundle(entries: string[]): { path: string; sha: string } {
	const dir = mkdtempSync(join(tmpdir(), "dg-chat-bundle-"));
	made.push(dir);
	const stage = join(dir, "stage");
	mkdirSync(stage);
	for (const entry of entries) {
		mkdirSync(join(stage, entry, ".."), { recursive: true });
		writeFileSync(join(stage, entry), `${entry}\n`);
	}
	const path = join(dir, ASSET);
	const zip = Bun.spawnSync(["zip", "-q", "-r", path, ...entries], { cwd: stage });
	if (zip.exitCode !== 0) throw new Error(zip.stderr.toString());
	return { path, sha: sha256(readFileSync(path)) };
}

const GOOD = ["dg-demo.zip", "dg-proto.zip", "UPLOAD.md"];

describe("bootstrap.sh --chat-only", () => {
	test("unpacks the verified bundle into ./dg-chat-skills and installs nothing else", async () => {
		const { path, sha } = bundle(GOOD);
		const run = await runBootstrap({ args: ["--chat-only"], serve: { [ASSET]: path }, extraAssets: { [ASSET]: sha } });

		expect(run.code, run.stderr).toBe(0);
		const dest = join(run.dir, "dg-chat-skills");
		expect(readdirSync(dest).sort()).toEqual([...GOOD].sort());
		for (const entry of GOOD) expect(statSync(join(dest, entry)).mode & 0o777).toBe(0o644);
		expect(run.stdout).toContain(`Chat skills ${VERSION} are in dg-chat-skills:`);
		expect(run.stdout).toContain("Upload a skill");
		expect(run.stdout).toContain("nothing else was installed and nothing was run");

		expect(run.bunZipRequests).toEqual([]);
		expect(run.requests.some((url) => url.includes("dg-lib-"))).toBe(false);
		expect(run.requests.some((url) => url.endsWith("runtime.json"))).toBe(false);
		expect(run.installCall).toBeUndefined();
		expect(present(run.root)).toBe(false);
		expect(present(join(run.home, ".local", "bin", "dg-skills"))).toBe(false);
	});

	test("--dest chooses the folder, in both spellings", async () => {
		for (const args of [["--chat-only", "--dest", "out/skills"], ["--chat-only", "--dest=out/skills"]]) {
			const { path, sha } = bundle(GOOD);
			const run = await runBootstrap({ args, serve: { [ASSET]: path }, extraAssets: { [ASSET]: sha } });
			expect(run.code, run.stderr).toBe(0);
			expect(readdirSync(join(run.dir, "out", "skills")).sort()).toEqual([...GOOD].sort());
			expect(existsSync(join(run.dir, "dg-chat-skills"))).toBe(false);
		}
	});

	test("--version pins the release it downloads from", async () => {
		const { path, sha } = bundle(GOOD);
		const run = await runBootstrap({ args: ["--chat-only", "--version", VERSION], serve: { [ASSET]: path }, extraAssets: { [ASSET]: sha } });
		expect(run.code, run.stderr).toBe(0);
		expect(run.requests.some((url) => url.endsWith(`/v${VERSION}/${ASSET}`))).toBe(true);
	});

	test("a checksum mismatch stops before anything is unpacked", async () => {
		const { path } = bundle(GOOD);
		const run = await runBootstrap({ args: ["--chat-only"], serve: { [ASSET]: path }, extraAssets: { [ASSET]: "0".repeat(64) } });
		expect(run.code).toBe(1);
		expect(run.stderr).toContain(`checksum mismatch for ${ASSET}`);
		expect(existsSync(join(run.dir, "dg-chat-skills"))).toBe(false);
	});

	test("a bundle missing from SHA256SUMS is refused", async () => {
		const { path } = bundle(GOOD);
		const run = await runBootstrap({ args: ["--chat-only"], serve: { [ASSET]: path }, extraAssets: { [ASSET]: null } });
		expect(run.code).toBe(1);
		expect(run.stderr).toContain(`has no entry for ${ASSET}`);
	});

	test.each([
		["a nested path", ["dg-demo.zip", "nested/dg-x.zip"]],
		["a file that is not a skill ZIP", ["dg-demo.zip", "run.sh"]],
	])("refuses %s inside the bundle and unpacks nothing", async (_why, entries) => {
		const { path, sha } = bundle(entries);
		const run = await runBootstrap({ args: ["--chat-only"], serve: { [ASSET]: path }, extraAssets: { [ASSET]: sha } });
		expect(run.code).toBe(1);
		expect(run.stderr).toContain("refusing");
		expect(existsSync(join(run.dir, "dg-chat-skills"))).toBe(false);
	});

	test.each(["--cli-only", "--skills-only", "--agent-only", "--codex", "--no-cli"])("refuses %s alongside it", async (flag) => {
		const run = await runBootstrap({ args: ["--chat-only", flag] });
		expect(run.code).toBe(1);
		expect(run.stderr).toContain(`--chat-only installs nothing but the chat skills; drop ${flag}`);
		expect(run.requests).toEqual([]);
	});

	test("has no environment-variable form", async () => {
		const run = await runBootstrap({ env: { DG_CHAT_ONLY: "1" }, args: ["--cli-only"] });
		expect(run.stdout).not.toContain("Chat skills");
	});
});
