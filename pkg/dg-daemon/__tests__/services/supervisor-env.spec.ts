import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposeRigs, type Rig, rig, SLEEPER, until } from "./supervisor-kit";

afterEach(disposeRigs);

const passEnvWarning = (label: string, name: string) =>
	`service ${label}: passEnv name ${name} is not set in the daemon environment`;

function withDaemonEnv<T>(vars: Record<string, string>, run: () => T): T {
	for (const [key, value] of Object.entries(vars)) process.env[key] = value;
	try {
		return run();
	} finally {
		for (const key of Object.keys(vars)) delete process.env[key];
	}
}

async function dumpedEnv(
	extra: Record<string, unknown>,
	prepare: (root: string) => Record<string, unknown> = () => ({}),
): Promise<{ env: Record<string, string>; rig: Rig }> {
	const dumpDir = mkdtempSync(join(tmpdir(), "dg-envdump-"));
	const dump = join(dumpDir, "env.json");
	const r = rig(({ root, script }) => ({
		bot: {
			argv: script(
				`require("node:fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env)); ${SLEEPER}`,
			),
			cwd: root,
			...prepare(root),
			...extra,
		},
	}));
	expect(r.supervisor.start("bot").ok).toBe(true);
	await until(() => existsSync(dump));
	return { env: JSON.parse(readFileSync(dump, "utf8")), rig: r };
}

describe("supervisor passEnv and envFile layering", () => {
	it("copies a passEnv name from the daemon process and withholds other daemon variables", async () => {
		const { env } = await withDaemonEnv(
			{ DG_TEST_PASS: "from-daemon", DG_TEST_OTHER: "leak" },
			() => dumpedEnv({ passEnv: ["DG_TEST_PASS"] }),
		);
		expect(env.DG_TEST_PASS).toBe("from-daemon");
		expect(env.DG_TEST_OTHER).toBeUndefined();
	});

	it("lets an envFile value win over the same passEnv name", async () => {
		const envDir = mkdtempSync(join(tmpdir(), "dg-envfile-"));
		const envFile = join(envDir, "secrets.env");
		writeFileSync(envFile, "DG_TEST_PASS=from-file\n", { mode: 0o600 });
		const { env } = await withDaemonEnv({ DG_TEST_PASS: "from-daemon" }, () =>
			dumpedEnv({ passEnv: ["DG_TEST_PASS"], envFile }),
		);
		expect(env.DG_TEST_PASS).toBe("from-file");
	});

	it("lets an envFile value win over an allowlisted name", async () => {
		const envDir = mkdtempSync(join(tmpdir(), "dg-envfile-"));
		const envFile = join(envDir, "secrets.env");
		writeFileSync(envFile, "LANG=from-file\n", { mode: 0o600 });
		const { env } = await dumpedEnv({ envFile });
		expect(env.LANG).toBe("from-file");
	});

	it("copies an empty passEnv value and logs no warning", async () => {
		const { env, rig: r } = await withDaemonEnv({ DG_TEST_EMPTY: "" }, () =>
			dumpedEnv({ passEnv: ["DG_TEST_EMPTY"] }),
		);
		expect(env.DG_TEST_EMPTY).toBe("");
		expect(r.warns).toEqual([]);
	});

	it("warns once with the exact text for a missing passEnv name and still runs the service", async () => {
		delete process.env.DG_TEST_ABSENT;
		const { rig: r } = await dumpedEnv({ passEnv: ["DG_TEST_ABSENT"] });
		expect(r.warns).toEqual([passEnvWarning("bot", "DG_TEST_ABSENT")]);
		expect(r.status().state).toBe("running");
	});

	it("never puts a passEnv value into a warning", async () => {
		delete process.env.DG_TEST_ABSENT;
		const { rig: r } = await withDaemonEnv(
			{ DG_TEST_PASS: "s3cret-value" },
			() => dumpedEnv({ passEnv: ["DG_TEST_PASS", "DG_TEST_ABSENT"] }),
		);
		expect(r.warns).toHaveLength(1);
		expect(r.warns.join("\n")).not.toContain("s3cret-value");
	});

	it("warns again on each launch of a restarted service", async () => {
		delete process.env.DG_TEST_ABSENT;
		const runs = mkdtempSync(join(tmpdir(), "dg-runs-"));
		const counter = join(runs, "runs");
		const r = rig(({ root, script }) => ({
			bot: {
				argv: script(
					`require("node:fs").appendFileSync(${JSON.stringify(counter)}, "x"); process.exit(1);`,
				),
				cwd: root,
				passEnv: ["DG_TEST_ABSENT"],
			},
		}));
		r.supervisor.start("bot");
		await until(() => r.status().restarts >= 2);
		await r.supervisor.stop("bot");
		const launches = r.infos.filter((m) =>
			m.startsWith("service bot started"),
		).length;
		const passWarns = r.warns.filter(
			(w) => w === passEnvWarning("bot", "DG_TEST_ABSENT"),
		);
		expect(passWarns.length).toBe(launches);
		expect(launches).toBeGreaterThanOrEqual(3);
		expect(readFileSync(counter, "utf8").length).toBeGreaterThanOrEqual(2);
	});
});
