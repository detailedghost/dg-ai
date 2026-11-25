import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "../../../common/src/plugins/manifest";
import { parseJobDeclaration } from "../../src/jobs/declaration";
import { jobFromManifest, readFolderManifest } from "../../src/jobs/plugin-manifest";
import { readSourceRecords, writeSource } from "../../src/jobs/sources";

const SOURCE_DIR = "/data/jobs/tools";
const context = { source: "tools", sourceDir: SOURCE_DIR, stateDir: (name: string) => join("/state/jobs", name) };
const COMMIT = "a".repeat(40);

const manifestText = (extra = "") => `name = "nightly-report"
version = "2.0.0"
kind = "job"
${extra}
[entry]
command = "bun"
args = ["run", "report.ts"]
`;
const manifest = (extra = "") => parseManifest(manifestText(extra), "plugin.toml");
const withCredentials = `${manifestText()}\n[permissions]\ncredentials = ["api-token"]\n`;

describe("jobFromManifest", () => {
	it("returns the declared job shape that package.json gives for the same argv", () => {
		const fromManifest = jobFromManifest(manifest(), context);
		const fromPackage = parseJobDeclaration(
			{ dg: { jobs: { "nightly-report": { argv: ["bun", "run", "report.ts"], continuous: true } } } },
			context,
		);

		if (!fromPackage.ok) throw new Error(fromPackage.error);
		expect(fromManifest).toEqual(fromPackage.jobs[0]);
		expect(fromManifest.entry.argv).toEqual(["bun", "run", "report.ts"]);
		expect(fromManifest.entry.cwd).toBe(SOURCE_DIR);
	});

	it("binds the credentials the manifest asks for", () => {
		const job = jobFromManifest(parseManifest(withCredentials, "plugin.toml"), context);

		expect(job.entry.credentials).toEqual(["api-token"]);
		expect(job.entry.grant).toBe("tools");
	});

	it("refuses a manifest of another kind", () => {
		const hook = parseManifest(manifestText().replace('kind = "job"', 'kind = "hook"'), "plugin.toml");

		expect(() => jobFromManifest(hook, context)).toThrow(/not a job/);
	});

	it("refuses a built-in entry because it has no argv", () => {
		const builtin = parseManifest('name = "x"\nversion = "1.0.0"\nkind = "job"\n[entry]\nbuiltin = "x"\n', "plugin.toml");

		expect(() => jobFromManifest(builtin, context)).toThrow(/argv/);
	});
});

describe("readFolderManifest", () => {
	it("returns nothing for a folder without plugin.toml", () => {
		const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pm-"));
		try {
			expect(readFolderManifest(dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns the manifest and its argv declaration when plugin.toml is present", () => {
		const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pm-"));
		try {
			writeFileSync(join(dir, "plugin.toml"), manifestText(`commit = "${COMMIT}"`));
			const found = readFolderManifest(dir);

			expect(found?.manifest.pin).toEqual({ kind: "commit", value: COMMIT });
			expect(found?.dg).toEqual({
				jobs: { "nightly-report": { argv: ["bun", "run", "report.ts"], continuous: true } },
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("names the file and line of a bad manifest", () => {
		const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pm-"));
		try {
			writeFileSync(join(dir, "plugin.toml"), 'name = "Bad Name"\n');

			expect(() => readFolderManifest(dir)).toThrow(/plugin\.toml:1/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("source records with a pin", () => {
	it("keeps the pin of a path record across a write and a read", () => {
		const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pm-"));
		try {
			const paths = { jobsDir: join(home, "jobs"), jobSourcesPath: join(home, "jobs", "sources.json") };
			mkdirSync(paths.jobsDir, { recursive: true });
			const pin = { kind: "commit", value: COMMIT } as const;
			writeSource(paths, "tools", {
				kind: "path",
				path: "/data/jobs/tools",
				jobs: ["nightly-report"],
				declarationHash: "b".repeat(64),
				credentials: {},
				pin,
			});

			expect(readSourceRecords(paths).tools).toMatchObject({ pin });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("rejects a pin with an unknown kind", () => {
		const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pm-"));
		try {
			const paths = { jobsDir: join(home, "jobs"), jobSourcesPath: join(home, "jobs", "sources.json") };
			mkdirSync(paths.jobsDir, { recursive: true });
			writeFileSync(
				paths.jobSourcesPath,
				JSON.stringify({
					tools: { kind: "path", path: "/data/x", jobs: [], credentials: {}, pin: { kind: "md5", value: "x" } },
				}),
			);

			expect(() => readSourceRecords(paths)).toThrow(/"pin"/);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
