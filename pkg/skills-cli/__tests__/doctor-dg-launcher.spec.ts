import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { runnableFix } from "../src/doctor/groups";
import { DOCTOR_REGISTRY } from "../src/doctor/registry";
import { createContext, runDoctor } from "../src/doctor/runner";
import { dgLauncherCheck } from "../src/doctor/shared";
import type { DoctorContext } from "../src/doctor/types";
import { writeShims } from "../src/install/shims";
import { makeArea } from "./dg-launcher-fixtures";

const posix = describe.skipIf(process.platform === "win32");

let area: string;
let cleanup: () => void;
let home: string;

beforeEach(() => {
	({ area, cleanup } = makeArea("doctor-dg-launcher"));
	home = join(area, "home");
	mkdirSync(home, { recursive: true });
});

afterEach(() => cleanup());

function context(path?: string): DoctorContext {
	const ctx = createContext({
		home,
		env: { HOME: home, PATH: path ?? "/usr/bin" },
	});
	return ctx;
}

function installLaunchers(
	ctx: DoctorContext,
	platform: NodeJS.Platform = "linux",
): void {
	writeShims(ctx.paths.binDir, join(area, "root"), platform, () => {});
}

const never = (): boolean => false;
const always = (): boolean => true;

posix("doctor check dg-launcher", () => {
	test("is ok when the bin folder holds no launcher at all", async () => {
		const result = await dgLauncherCheck(never, "linux").run(context());

		expect(result.status).toBe("ok");
	});

	test("is ok when the dg launcher exists and the first dg on PATH is that launcher", async () => {
		const ctx = context();
		installLaunchers(ctx);
		const withPath = context(ctx.paths.binDir);

		expect((await dgLauncherCheck(never, "linux").run(withPath)).status).toBe(
			"ok",
		);
	});

	test("warns with the install command when only the dg launcher is absent", async () => {
		const ctx = context();
		installLaunchers(ctx);
		rmSync(join(ctx.paths.binDir, "dg"));

		const result = await dgLauncherCheck(never, "linux").run(ctx);

		expect(result.status).toBe("warn");
		expect(result.fix).toBe("dg-skills install");
		expect(runnableFix(result.fix ?? null)).toEqual(["dg-skills", "install"]);
	});

	test("names install --cli-only as the fix for a CLI-only install", async () => {
		const ctx = context();
		installLaunchers(ctx);
		rmSync(join(ctx.paths.binDir, "dg"));

		const result = await dgLauncherCheck(always, "linux").run(ctx);

		expect(result.status).toBe("warn");
		expect(result.fix).toBe("dg-skills install --cli-only");
	});

	test("passes the context to the CLI-only predicate", async () => {
		const ctx = context();
		installLaunchers(ctx);
		rmSync(join(ctx.paths.binDir, "dg"));
		const seen: DoctorContext[] = [];

		await dgLauncherCheck((given) => (seen.push(given), false), "linux").run(
			ctx,
		);

		expect(seen).toEqual([ctx]);
	});

	test("warns that a dg file that is not a dg launcher is not one, with a fix that doctor does not run", async () => {
		const ctx = context();
		installLaunchers(ctx);
		const dg = join(ctx.paths.binDir, "dg");
		writeFileSync(dg, "#!/bin/sh\necho other tool\n");

		const result = await dgLauncherCheck(never, "linux").run(ctx);

		expect(result.status).toBe("warn");
		expect(result.detail).toBe(`${dg} is not a dg launcher`);
		expect(result.fix).toBe(
			`remove or rename ${dg}, then run dg-skills install`,
		);
		expect(runnableFix(result.fix ?? null)).toBeNull();
	});

	test("warns when the first dg on PATH is a different file, with a text-only fix", async () => {
		const ctx = context();
		installLaunchers(ctx);
		const other = join(area, "other-bin");
		mkdirSync(other);
		writeFileSync(join(other, "dg"), "#!/bin/sh\necho other tool\n");
		chmodSync(join(other, "dg"), 0o755);
		const shadowed = context([other, ctx.paths.binDir].join(delimiter));

		const result = await dgLauncherCheck(never, "linux").run(shadowed);

		expect(result.status).toBe("warn");
		expect(result.detail).toBe(
			`dg on PATH is ${join(other, "dg")}, not ${join(ctx.paths.binDir, "dg")}`,
		);
		expect(result.fix).not.toBeNull();
		expect(runnableFix(result.fix ?? null)).toBeNull();
	});

	test("is registered in the shared item of the doctor report", async () => {
		const ctx = context();
		installLaunchers(ctx);
		rmSync(join(ctx.paths.binDir, "dg"));

		const report = await runDoctor(["shared"], DOCTOR_REGISTRY, ctx);

		const check = report.items
			.find((entry) => entry.item === "shared")
			?.checks.find((entry) => entry.id === "dg-launcher");
		expect(check?.status).toBe("warn");
		expect(check?.fix).toBe("dg-skills install");
	});
});

describe("doctor check dg-launcher on the win32 platform parameter", () => {
	function windowsBin(ctx: DoctorContext): string {
		mkdirSync(ctx.paths.binDir, { recursive: true });
		for (const file of ["dg-skills", "dg-skills.cmd"])
			writeFileSync(join(ctx.paths.binDir, file), "x");
		return ctx.paths.binDir;
	}

	test("warns when dg-skills.cmd exists and dg.cmd does not", async () => {
		const ctx = context();
		windowsBin(ctx);

		const result = await dgLauncherCheck(never, "win32").run(ctx);

		expect(result.status).toBe("warn");
		expect(result.fix).toBe("dg-skills install");
	});

	test("reads dg.cmd, so a dg file with no extension does not count", async () => {
		const ctx = context();
		const bin = windowsBin(ctx);
		installLaunchers(ctx, "linux");
		writeFileSync(join(bin, "dg"), "#!/bin/sh\n");

		const result = await dgLauncherCheck(never, "win32").run(ctx);

		expect(result.status).toBe("warn");
	});

	test("is ok when dg.cmd is a dg launcher", async () => {
		const ctx = context();
		installLaunchers(ctx, "win32");
		writeFileSync(join(ctx.paths.binDir, "dg-skills"), "x");

		const result = await dgLauncherCheck(never, "win32").run(ctx);

		expect(result.status).toBe("ok");
	});
});
