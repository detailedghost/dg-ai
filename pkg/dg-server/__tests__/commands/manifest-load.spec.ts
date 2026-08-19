/**
 * Pure manifest-loading logic: JSON file -> validated CommandEntry[] ->
 * publish-time argv[0] resolution/refusal. Deliberately import-only (no
 * subprocess) since none of this depends on a live daemon.
 *
 * [SPEC] ASSUMED module surface — not named anywhere in plan.md:
 *   src/manifest/load.ts exports
 *     loadManifestFile(path: string): CommandEntry[]        (read+parse+validate)
 *     resolveManifestForPublish(entries): CommandEntry[]    (Bun.which + denylist)
 *     ManifestLoadError extends Error                       (thrown by both)
 * See deferrals for the invented shell/script-host denylist.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadManifestFile,
	loadSubagentManifestFile,
	resolveManifestForPublish,
} from "../../src/manifest/load";

let scratchDir: string;

function writeManifestFile(contents: unknown): string {
	scratchDir = mkdtempSync(join(tmpdir(), "dg-manifest-test-"));
	const path = join(scratchDir, "manifest.json");
	writeFileSync(path, JSON.stringify(contents));
	return path;
}

afterEach(() => {
	if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

const SAFE_ENTRY = {
	label: "List files",
	argv: ["ls", "-la"],
	params: [],
};

describe("loadManifestFile", () => {
	it("accepts a valid manifest file and returns its parsed CommandEntry array", () => {
		const path = writeManifestFile([SAFE_ENTRY]);
		expect(loadManifestFile(path)).toEqual([SAFE_ENTRY]);
	});

	it("rejects an invalid entry, naming the offending entry rather than a generic parse failure", () => {
		const path = writeManifestFile([{ command: "ls -la" }]);
		expect(() => loadManifestFile(path)).toThrow(/\[0\]/);
	});

	it("publishes nothing from a manifest where only the SECOND entry is invalid — the whole file is rejected, not partially applied", () => {
		const path = writeManifestFile([
			SAFE_ENTRY,
			{ label: "bad", argv: [], params: [], command: "not allowed" },
		]);
		expect(() => loadManifestFile(path)).toThrow();
	});
});

function writeSubagentFile(contents: unknown): string {
	scratchDir = mkdtempSync(join(tmpdir(), "dg-subagents-test-"));
	const path = join(scratchDir, "subagents.json");
	writeFileSync(path, JSON.stringify(contents));
	return path;
}

describe("loadSubagentManifestFile", () => {
	it("reads and validates a list of subagent names", () => {
		const path = writeSubagentFile(["reviewer", "planner-2"]);
		expect(loadSubagentManifestFile(path)).toEqual(["reviewer", "planner-2"]);
	});

	it("rejects a name that fails the shared identifier grammar", () => {
		const path = writeSubagentFile(["ok", "not a valid name"]);
		expect(() => loadSubagentManifestFile(path)).toThrow(/\[1\]/);
	});

	it("rejects a file that isn't a JSON array", () => {
		const path = writeSubagentFile({ names: ["reviewer"] });
		expect(() => loadSubagentManifestFile(path)).toThrow(/array/i);
	});
});

describe("resolveManifestForPublish", () => {
	it("resolves an ordinary binary's argv[0] and leaves the entry otherwise unchanged", () => {
		const entries = resolveManifestForPublish([SAFE_ENTRY]);
		expect(entries).toEqual([SAFE_ENTRY]);
	});

	it("refuses an entry whose argv[0] does not resolve on PATH at all", () => {
		const entries = [
			{ label: "ghost", argv: ["dg-totally-fake-binary-zzz"], params: [] },
		];
		expect(() => resolveManifestForPublish(entries)).toThrow(/ghost|resolve/i);
	});

	it("refuses an entry whose argv[0] resolves to a shell", () => {
		const entries = [
			{ label: "shell", argv: ["bash", "-c", "ls"], params: [] },
		];
		expect(() => resolveManifestForPublish(entries)).toThrow(/shell|bash/i);
	});

	// python3 is on this box's PATH via a version-suffixed symlink (python3 ->
	// python3.14) — exactly the shape a literal-only denylist match misses.
	it.skipIf(!Bun.which("python3"))(
		"refuses python3 even when it resolves through a version-suffixed symlink",
		() => {
			const entries = [
				{ label: "python", argv: ["python3", "-c", "print(1)"], params: [] },
			];
			expect(() => resolveManifestForPublish(entries)).toThrow(/python/i);
		},
	);

	it("does not resolve/refuse other entries once one entry in the same file fails — no partial publish", () => {
		const entries = [
			SAFE_ENTRY,
			{ label: "shell", argv: ["bash"], params: [] },
		];
		expect(() => resolveManifestForPublish(entries)).toThrow();
	});
});
