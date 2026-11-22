import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node/dg-paths";
import { finishLegacyUpgrade, UNFINISHED_HINT, unfinishedUpgrade } from "../src/install/finish-upgrade";

function recorder(unfinished: boolean, fail?: Error) {
	const lines: string[] = [];
	let finished = 0;
	return {
		lines,
		finished: () => finished,
		seams: {
			unfinished: () => unfinished,
			finish: async () => {
				finished++;
				if (fail) throw fail;
			},
			warn: (line: string) => void lines.push(line),
		},
	};
}

describe("finishLegacyUpgrade", () => {
	test("finishes the layout for a dg or dg-skills command through an old launcher", async () => {
		const cases: [Parameters<typeof finishLegacyUpgrade>[0], string[]][] = [
			["dg", ["stash", "--help"]],
			["dg-skills", ["doctor"]],
			["dg", ["skills", "pw"]],
		];
		for (const [name, args] of cases) {
			const r = recorder(true);
			await finishLegacyUpgrade(name, args, r.seams);
			expect([name, r.finished()]).toEqual([name, 1]);
		}
	});

	test("does nothing once the compiled dg is installed", async () => {
		const r = recorder(false);
		await finishLegacyUpgrade("dg-skills", ["doctor"], r.seams);
		expect(r.finished()).toBe(0);
		expect(r.lines).toEqual([]);
	});

	test("leaves install and update alone, since they finish the layout themselves", async () => {
		for (const args of [["install", "launchers"], ["update"], ["upgrade"], ["skills", "install"]]) {
			const r = recorder(true);
			await finishLegacyUpgrade("dg-skills", args, r.seams);
			expect([args, r.finished(), r.lines]).toEqual([args, 0, []]);
		}
	});

	test("prints the next step and downloads nothing for hooks, completion, flags and service programs", async () => {
		const cases: [Parameters<typeof finishLegacyUpgrade>[0], string[]][] = [
			["dg-skills", ["hooks", "run", "daily-prune"]],
			["dg-skills", ["completion", "zsh"]],
			["dg", ["--help"]],
			["dg-agent", ["phone", "listen"]],
			["dg-daemon", ["serve"]],
		];
		for (const [name, args] of cases) {
			const r = recorder(true);
			await finishLegacyUpgrade(name, args, r.seams);
			expect([name, args, r.finished(), r.lines]).toEqual([name, args, 0, [UNFINISHED_HINT]]);
		}
	});

	test("a failed finish warns with the next step and lets the command run", async () => {
		const r = recorder(true, new Error("HTTP 503"));
		await finishLegacyUpgrade("dg", ["doctor"], r.seams);
		expect(r.lines.at(-1)).toBe("dg: the upgrade is not finished: HTTP 503; run dg upgrade once more");
	});
});

describe("unfinishedUpgrade", () => {
	function layout() {
		const home = mkdtempSync(join(tmpdir(), "dg-finish-upgrade-"));
		const paths = resolveDgPaths({ homeDir: home, env: { DG_HOME: home } });
		const entry = join(paths.dataDir, "lib", "7.0.0", "dg.js");
		mkdirSync(join(entry, ".."), { recursive: true });
		writeFileSync(entry, "bundle");
		return { home, paths, entry, cleanup: () => rmSync(home, { recursive: true, force: true }) };
	}

	test("is true for the bundle in a version folder of the data lib dir while bin/current/dg is missing", () => {
		const w = layout();
		try {
			expect(unfinishedUpgrade(w.entry, w.paths)).toBe(true);
			mkdirSync(join(w.paths.dataDir, "bin", "current"), { recursive: true });
			writeFileSync(join(w.paths.dataDir, "bin", "current", "dg"), "compiled");
			expect(unfinishedUpgrade(w.entry, w.paths)).toBe(false);
		} finally {
			w.cleanup();
		}
	});

	test("is false for a staged bundle, a source checkout and the compiled program", () => {
		const w = layout();
		try {
			expect(unfinishedUpgrade(join(w.paths.dataDir, "lib", ".7.0.0.staging-x", "dg.js"), w.paths)).toBe(false);
			expect(unfinishedUpgrade(join(import.meta.dir, "..", "..", "launcher", "src", "dg.ts"), w.paths)).toBe(false);
			expect(unfinishedUpgrade("/$bunfs/root/dg", w.paths)).toBe(false);
		} finally {
			w.cleanup();
		}
	});
});
