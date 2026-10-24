import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { PhoneDb } from "../../src/phone/db";
import { legacyRoot, migrateIfNeeded, resolveDaemonExecutable, runArgv, runDaemonJobCli, siblingDaemonPath } from "../../src/phone/migrate";

describe("legacyRoot / migrateIfNeeded", () => {
	it("is undefined on a fresh install with neither root", () => {
		const home = mkdtempSync(join(tmpdir(), "dg-phone-migrate-"));
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: home } });
			expect(legacyRoot(paths)).toBeUndefined();
			expect(migrateIfNeeded(paths)).toEqual({ migrated: false });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("finds the old root once a line database exists there, and stops once phone.db exists", () => {
		const home = mkdtempSync(join(tmpdir(), "dg-phone-migrate-"));
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: home } });
			mkdirSync(join(paths.phoneFriendRoot, "default"), { recursive: true });
			writeFileSync(join(paths.phoneFriendRoot, "default", "phone-friend.db"), "");

			expect(legacyRoot(paths)).toBe(paths.phoneFriendRoot);

			const db = PhoneDb.open(paths);
			db.close();
			expect(legacyRoot(paths)).toBeUndefined();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("ignores a phone-friend root with no line database in it", () => {
		const home = mkdtempSync(join(tmpdir(), "dg-phone-migrate-"));
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: home } });
			mkdirSync(paths.phoneFriendRoot, { recursive: true });

			expect(legacyRoot(paths)).toBeUndefined();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("resolveDaemonExecutable", () => {
	it("prefers the daemon beside this executable", () => {
		expect(siblingDaemonPath("/opt/dg/dg-agent", "linux")).toBe("/opt/dg/dg-daemon");
		expect(siblingDaemonPath("/opt/dg/dg-agent.exe", "win32")).toBe("/opt/dg/dg-daemon.exe");
		expect(
			resolveDaemonExecutable("/opt/dg/dg-agent", "linux", (path) => path.endsWith("dg-daemon"), () => "/usr/bin/dg-daemon"),
		).toBe("/opt/dg/dg-daemon");
	});

	it("uses PATH when the sibling is absent", () => {
		expect(
			resolveDaemonExecutable("/opt/dg/dg-agent", "linux", () => false, (name) =>
				name === "dg-daemon" ? "/usr/bin/dg-daemon" : undefined,
			),
		).toBe("/usr/bin/dg-daemon");
	});

	it("says how to install dg-daemon when neither place has it", () => {
		expect(() => resolveDaemonExecutable("/opt/dg/dg-agent", "linux", () => false, () => undefined)).toThrow(
			"dg-skills install",
		);
	});
});

describe("runArgv", () => {
	it("captures stdout and the env it was given", async () => {
		const ran = await runArgv([process.execPath, "-e", "console.log(process.env.MARKER ?? '')"], {
			...process.env,
			MARKER: "dg-phone-migrate",
		});

		expect(ran.code).toBe(0);
		expect(ran.stdout).toBe("dg-phone-migrate\n");
	});

	it("captures a non-zero exit and stderr", async () => {
		const ran = await runArgv([process.execPath, "-e", "console.error('nope'); process.exit(3)"], process.env);

		expect(ran.code).toBe(3);
		expect(ran.stderr).toContain("nope");
	});

	it("returns a failure when the executable cannot be spawned", async () => {
		const ran = await runArgv(["/no/such/dg-daemon-binary"], process.env);

		expect(ran.code).not.toBe(0);
		expect(ran.stdout).toBe("");
		expect(ran.stderr.length).toBeGreaterThan(0);
	});
});

describe("runDaemonJobCli", () => {
	it("runs the dg-daemon found on PATH and forwards the job arguments", async () => {
		const bin = mkdtempSync(join(tmpdir(), "dg-daemon-bin-"));
		writeFileSync(join(bin, "dg-daemon"), "#!/bin/sh\nprintf '%s\n' \"$@\"\n");
		chmodSync(join(bin, "dg-daemon"), 0o755);
		const previous = process.env.PATH;
		process.env.PATH = `${bin}${delimiter}${previous ?? ""}`;
		try {
			const ran = await runDaemonJobCli(["job", "list"]);
			expect(ran.code).toBe(0);
			expect(ran.stdout).toBe("job\nlist\n");
		} finally {
			process.env.PATH = previous;
			rmSync(bin, { recursive: true, force: true });
		}
	});
});

