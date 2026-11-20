import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jobStateDir } from "@dg/common/node";
import { allocatePort, spawnServe, stopServe, waitForHealth } from "../utils/daemon-harness";
import { fetchJobRows, waitUntil } from "./job-cli-helpers";
import {
	BIN_RUN,
	makeFolder,
	makeScript,
	runJob,
	type Sandbox,
	sandbox,
} from "./job-source-kit";
import { type Rig, setupFile, setupRig, VALUE_A } from "./job-setup-kit";

setDefaultTimeout(30_000);

const bunOnly = (name: string) => (name === "bun" ? process.execPath : null);
const offline = {
	isTerminal: () => false,
	confirm: async (): Promise<boolean> => {
		throw new Error("unexpected question");
	},
};

const rigs: Rig[] = [];
afterEach(() => {
	for (const rig of rigs.splice(0)) rig.close();
});

function rigWith(options: Parameters<typeof setupRig>[1] = {}): Rig {
	const rig = setupRig(() => ({}), { terminal: false, ...options });
	rigs.push(rig);
	return rig;
}

describe("a local add with no terminal", () => {
	it("adds a file job and a folder with no question", async () => {
		const rig = rigWith();
		const dir = makeFolder({
			dg: { jobs: { a: { argv: ["./bin/run"], continuous: true } } },
			files: { "bin/run": BIN_RUN },
		});

		const file = await rig.run(["add", makeScript("poll.ts"), "--every", "15m"], {
			...offline,
			which: bunOnly,
		});
		const folder = await rig.run(["add", dir], { ...offline, which: (name) => rig.sb.tools.which(name) });

		expect(file.code).toBe(0);
		expect(folder.code).toBe(0);
		expect(Object.keys(rig.table())).toEqual(["poll", "a"]);
	});

	it("stores the value, makes the grant and enables the job with zero questions", async () => {
		const rig = rigWith({ grant: "missing" });
		await rig.run(["add", makeScript("poll.ts"), "--every", "15m", "--credential", "api-key"], {
			...offline,
			which: bunOnly,
		});
		const answers = setupFile({ version: 1, credentials: { "api-key": { value: VALUE_A } } });
		rig.states.set("poll", "stopped");

		const result = await rig.run(["enable", "poll", "--setup", answers], offline);

		expect(result.code).toBe(0);
		expect(rig.calls.set.map((call) => [call.name, call.value])).toEqual([["poll/api-key", VALUE_A]]);
		expect(rig.calls.ensureGrant).toBe(1);
		expect(rig.table().poll.enabled).toBe(true);
		expect(rig.asked.confirms).toEqual([]);
		expect(rig.asked.hidden).toEqual([]);
	});

	it("exits 1 when the prefix holds credentials", async () => {
		const rig = rigWith({ stored: [{ name: "poll/other" }], grant: "ok" });
		await rig.run(["add", makeScript("poll.ts"), "--every", "15m", "--credential", "api-key"], {
			...offline,
			which: bunOnly,
		});
		const answers = setupFile({ version: 1, credentials: { "api-key": { value: VALUE_A } } });

		const result = await rig.run(["enable", "poll", "--setup", answers], offline);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("holds credentials");
		expect(rig.calls.set).toEqual([]);
	});
});

const sleeper = (executable: boolean) =>
	`${executable ? `#!${process.execPath}\n` : ""}setTimeout(() => {}, 600000);\n`;

describe("a local job against a live daemon", () => {
	const box = sandbox(["tool", "sh"]);
	const procs: ReturnType<typeof spawnServe>[] = [];
	afterEach(async () => {
		for (const proc of procs.splice(0)) await stopServe(proc).catch(() => {});
		box.cleanup();
	});

	async function live(env: Record<string, string> = {}) {
		const sb = box.create();
		const port = allocatePort();
		procs.push(spawnServe(sb.dgHome, port, env));
		await waitForHealth(port, 8000);
		return { sb, port };
	}

	const run = (sb: Sandbox, args: string[]) =>
		runJob(args, { ...sb.deps(), ...offline, which: bunOnly });

	it("runs a continuous file job again with a new pid after a daemon restart", async () => {
		const { sb, port } = await live();
		const file = makeScript("loop.js", sleeper(false));
		expect((await run(sb, ["add", file, "--continuous"])).code).toBe(0);
		expect((await run(sb, ["enable", "loop"])).code).toBe(0);
		const pidOf = async (at: number) => {
			let pid: number | null = null;
			await waitUntil(async () => {
				pid = (await fetchJobRows(sb.dgHome, at)).find((row) => row.label === "loop")?.pid ?? null;
				return pid !== null;
			});
			return pid as unknown as number;
		};
		const first = await pidOf(port);

		await stopServe(procs.pop() as ReturnType<typeof spawnServe>);
		const next = allocatePort();
		procs.push(spawnServe(sb.dgHome, next));
		await waitForHealth(next, 8000);
		const second = await pidOf(next);

		expect(second).not.toBe(first);
	});

	it("runs a scheduled file job two times and the second run reads the edited file", async () => {
		const { sb } = await live({ DG_JOB_TICK_MS: "120" });
		const out = join(sb.dgHome, "out.txt");
		const body = (word: string) =>
			`require("node:fs").appendFileSync(${JSON.stringify(out)}, ${JSON.stringify(`${word}\n`)});\n`;
		const file = makeScript("tick.js", body("one"));
		expect((await run(sb, ["add", file, "--every", "1s"])).code).toBe(0);
		expect((await run(sb, ["enable", "tick"])).code).toBe(0);
		await waitUntil(() => existsSync(out) && readFileSync(out, "utf8").includes("one"));

		writeFileSync(file, body("two"));
		await run(sb, ["start", "tick"]);
		await waitUntil(() => readFileSync(out, "utf8").includes("two"));

		const words = readFileSync(out, "utf8").trim().split("\n");
		expect(words[0]).toBe("one");
		expect(words).toContain("two");
	});

	it("lets a file job read its credential through service API v1", async () => {
		const { sb } = await live();
		const script = makeScript(
			"reader.js",
			`const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
(async () => {
	const prefix = process.env.DG_CREDENTIAL_GRANT_PREFIX;
	const token = readFileSync(process.env.DG_CREDENTIAL_GRANT_FILE, "utf8").trim();
	const response = await fetch(process.env.DG_DAEMON_URL + "/service-api/v1/credentials", {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Dg-Grant-Prefix": prefix, "X-Dg-Grant-Token": token },
		body: JSON.stringify({ operation: "get", name: prefix + "/api-key" }),
	});
	const body = await response.json();
	writeFileSync(
		join(process.env.DG_SERVICE_STATE_DIR, "got"),
		createHash("sha256").update(body.value.value).digest("hex"),
	);
	setTimeout(() => {}, 600000);
})();
`,
		);
		expect((await run(sb, ["add", script, "--continuous", "--credential", "api-key"])).code).toBe(0);
		const answers = setupFile({ version: 1, credentials: { "api-key": { value: VALUE_A } } });

		const result = await run(sb, ["enable", "reader", "--setup", answers]);

		expect(result.code).toBe(0);
		const got = join(jobStateDir(sb.paths, "reader"), "got");
		await waitUntil(() => existsSync(got));
		expect(readFileSync(got, "utf8")).toBe(createHash("sha256").update(VALUE_A).digest("hex"));
	});

	it("does not report the state running for a job whose script is gone and shows source missing", async () => {
		const { sb } = await live();
		const file = makeScript("gone.sh", "#!/bin/sh\nsleep 60\n", { executable: true });
		await run(sb, ["add", file, "--continuous"]);
		const real = realpathSync(file);
		rmSync(real);

		const enabled = await run(sb, ["enable", "gone"]);
		const status = await run(sb, ["status", "gone"]);

		expect(enabled.stdout).not.toMatch(/gone +running/);
		expect(status.stdout).not.toMatch(/\brunning\b/);
		expect(status.stdout).toContain(`source missing: ${real}`);
	});
});
