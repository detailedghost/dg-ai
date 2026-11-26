import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	addFixture,
	BIN_RUN,
	changeBlock,
	commit,
	gitIn,
	makeFolder,
	makeRepo,
	readConfig,
	readRegistry,
	runJob,
	type Sandbox,
	sandbox,
	withBun,
} from "../commands/job-source-kit";

const box = sandbox(["tool", "sh"]);
let sb: Sandbox;
afterEach(() => box.cleanup());

const COMMIT = "b".repeat(40);

const manifest = (extra = "", args = '["--fast"]') =>
	[
		'name = "bot"',
		'version = "1.0.0"',
		'kind = "job"',
		extra,
		"[entry]",
		'command = "./bin/run"',
		`args = ${args}`,
	].join("\n");

const argvOf = () => readConfig(sb).jobs.bot.argv as string[];

describe("job add of a folder with a plugin.toml", () => {
	it("stores the manifest argv and the commit pin", async () => {
		sb = box.create();
		const dir = makeFolder({
			files: { "plugin.toml": manifest(`commit = "${COMMIT}"`), "bin/run": BIN_RUN },
		});

		const result = await runJob(["add", dir], withBun(sb));

		expect(result.code).toBe(0);
		expect(argvOf()).toEqual([expect.stringMatching(/\/bin\/run$/), "--fast"]);
		const record = readRegistry(sb).toolkit;
		expect(record.pin).toEqual({ kind: "commit", value: COMMIT });
		expect(record.jobs).toEqual(["bot"]);
		expect(typeof record.declarationHash).toBe("string");
	});

	it("stores no pin when the manifest has none", async () => {
		sb = box.create();
		const dir = makeFolder({ files: { "plugin.toml": manifest(), "bin/run": BIN_RUN } });

		const result = await runJob(["add", dir], withBun(sb));

		expect(result.code).toBe(0);
		expect(readRegistry(sb).toolkit).not.toHaveProperty("pin");
	});

	it("refuses a manifest of another kind", async () => {
		sb = box.create();
		const dir = makeFolder({
			files: {
				"plugin.toml": manifest(`commit = "${COMMIT}"`).replace('kind = "job"', 'kind = "skill"'),
				"bin/run": BIN_RUN,
			},
		});

		const result = await runJob(["add", dir], withBun(sb));

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("not a job");
	});

	it("refreshes the argv and the pin on update", async () => {
		sb = box.create();
		const dir = makeFolder({ files: { "plugin.toml": manifest(), "bin/run": BIN_RUN } });
		await runJob(["add", dir], withBun(sb));
		writeFileSync(
			join(dir, "plugin.toml"),
			manifest(`commit = "${COMMIT}"`, '["--slow"]'),
		);

		const result = await runJob(["update", "bot"], withBun(sb));

		expect(result.code).toBe(0);
		expect(argvOf()).toEqual([expect.stringMatching(/\/bin\/run$/), "--slow"]);
		expect(readRegistry(sb).toolkit.pin).toEqual({ kind: "commit", value: COMMIT });
	});
});

describe("job add of a repository with a plugin.toml", () => {
	it("pins the record to the checked-out commit and records its tree id", async () => {
		sb = box.create();
		const repo = makeRepo({ files: { "plugin.toml": manifest(), "bin/run": BIN_RUN } });

		await addFixture(sb, repo, "tools");

		expect(argvOf()).toEqual([expect.stringMatching(/\/bin\/run$/), "--fast"]);
		const record = readRegistry(sb).tools;
		expect(record.pin).toEqual({ kind: "commit", value: repo.sha });
		expect(record.tree).toBe(gitIn(repo.dir, ["rev-parse", "HEAD^{tree}"]).trim());
	});

	it("refuses a manifest pin that is not the checked-out commit", async () => {
		sb = box.create();
		const repo = makeRepo({
			files: { "plugin.toml": manifest(`commit = "${COMMIT}"`), "bin/run": BIN_RUN },
		});

		const result = await runJob(
			["add", `file://${repo.dir}`, "--name", "tools", "--yes"],
			withBun(sb),
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("is not the checked-out commit");
		expect(result.stderr).toContain("Next:");
		expect(readRegistry(sb)).not.toHaveProperty("tools");
	});

	it("refuses a plugin.toml that is not a regular file", async () => {
		sb = box.create();
		const repo = makeRepo({ files: { "bin/run": BIN_RUN } });
		commit(repo, { files: { "real.toml": manifest() } });
		const blob = gitIn(repo.dir, ["hash-object", "-w", "real.toml"]);
		gitIn(repo.dir, ["update-index", "--add", "--cacheinfo", `120000,${blob},plugin.toml`]);
		gitIn(repo.dir, ["commit", "-m", "link"]);

		const result = await runJob(
			["add", `file://${repo.dir}`, "--name", "tools", "--yes"],
			withBun(sb),
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("plugin.toml is not a regular file");
	});

	it("takes the new argv, pin and tree id on update", async () => {
		sb = box.create();
		const repo = makeRepo({ files: { "plugin.toml": manifest(), "bin/run": BIN_RUN } });
		await addFixture(sb, repo, "tools");
		const next = changeBlock(repo, undefined, {
			"plugin.toml": manifest("", '["--slow"]'),
		});

		const result = await runJob(["update", "bot"], withBun(sb));

		expect(result.code).toBe(0);
		expect(argvOf()).toEqual([expect.stringMatching(/\/bin\/run$/), "--slow"]);
		const record = readRegistry(sb).tools;
		expect(record.sha).toBe(next);
		expect(record.pin).toEqual({ kind: "commit", value: next });
		expect(record.tree).toBe(gitIn(repo.dir, ["rev-parse", "HEAD^{tree}"]).trim());
	});
});
