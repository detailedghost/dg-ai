import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { compiledBackupPath, migrateLauncherArgv } from "../../src/jobs/migrate";
import { cleanupDgHome, freshDgHome } from "../utils/daemon-harness";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) cleanupDgHome(home);
});

function setup(contents: unknown) {
	const dgHome = freshDgHome();
	homes.push(dgHome);
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	mkdirSync(dirname(paths.daemonConfigPath), { recursive: true });
	writeFileSync(paths.daemonConfigPath, JSON.stringify(contents, null, 2));
	return paths;
}

const configOf = (paths: ReturnType<typeof setup>) => JSON.parse(readFileSync(paths.daemonConfigPath, "utf8"));
const posix = process.platform === "win32" ? it.skip : it;

describe("migrateLauncherArgv", () => {
	posix("rewrites a 6.3 bundle argv and an old program name on PATH, and keeps a 0600 backup of the old config", () => {
		const root = "/d";
		const config = {
			jobsVersion: 2,
			jobs: {
				bot: { argv: [`${root}/runtime/current/bun`, `${root}/lib/current/dg.js`, "dg-skills", "inbox", "sweep"], every: "15m" },
				mail: { argv: ["dg-skills", "inbox", "--x"], continuous: true },
				phone: { argv: ["dg-agent", "phone", "listen"], continuous: true },
				other: { argv: ["python3", "bot.py"], continuous: true },
			},
		};
		const paths = setup(config);
		const before = readFileSync(paths.daemonConfigPath, "utf8");
		const { rewritten } = migrateLauncherArgv(paths);
		expect(rewritten.map((job) => job.name)).toEqual(["bot", "mail", "phone"]);
		const jobs = configOf(paths).jobs;
		expect(jobs.bot.argv).toEqual([`${root}/bin/current/dg`, "skills", "inbox", "sweep"]);
		expect(jobs.bot.every).toBe("15m");
		expect(jobs.mail.argv).toEqual(["dg", "skills", "inbox", "--x"]);
		expect(jobs.phone.argv).toEqual(["dg", "agent", "phone", "listen"]);
		expect(jobs.other.argv).toEqual(["python3", "bot.py"]);
		expect(configOf(paths).jobsVersion).toBe(2);
		expect(readFileSync(compiledBackupPath(paths), "utf8")).toBe(before);
		expect(statSync(compiledBackupPath(paths)).mode & 0o777).toBe(0o600);
		expect(statSync(paths.daemonConfigPath).mode & 0o777).toBe(0o600);
	});

	posix("is idempotent: a second run changes nothing and writes no second backup", () => {
		const paths = setup({ jobs: { mail: { argv: ["dg-skills", "stat"], continuous: true } } });
		migrateLauncherArgv(paths);
		const after = readFileSync(paths.daemonConfigPath, "utf8");
		const backup = readFileSync(compiledBackupPath(paths), "utf8");
		writeFileSync(join(dirname(compiledBackupPath(paths)), "marker"), "");
		expect(migrateLauncherArgv(paths).rewritten).toEqual([]);
		expect(readFileSync(paths.daemonConfigPath, "utf8")).toBe(after);
		expect(readFileSync(compiledBackupPath(paths), "utf8")).toBe(backup);
	});

	it("writes nothing when no job names an old program", () => {
		const paths = setup({ jobs: { other: { argv: ["dg", "stat"], continuous: true } } });
		expect(migrateLauncherArgv(paths).rewritten).toEqual([]);
		expect(existsSync(compiledBackupPath(paths))).toBe(false);
	});

	it("does nothing without a config file", () => {
		const dgHome = freshDgHome();
		homes.push(dgHome);
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		expect(migrateLauncherArgv(paths).rewritten).toEqual([]);
	});
});
