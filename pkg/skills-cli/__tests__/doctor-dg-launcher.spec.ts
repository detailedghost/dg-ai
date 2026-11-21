import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { compiledProgramPath } from "@dg/common/node/program";
import { runnableFix } from "../src/doctor/groups";
import { DOCTOR_REGISTRY } from "../src/doctor/registry";
import { createContext, runDoctor } from "../src/doctor/runner";
import { dgLauncherCheck, sharedChecks } from "../src/doctor/shared";
import type { DoctorCheck, DoctorContext } from "../src/doctor/types";
import { versionProgramPath, writeDgLink } from "../src/install/compiled";
import { linkCurrent } from "../src/install/current";
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
	const { binDir, dataDir } = ctx.paths;
	const program = versionProgramPath(dataDir, "7.0.0", platform);
	mkdirSync(join(dataDir, "bin", "7.0.0"), { recursive: true });
	writeFileSync(program, "#!/bin/sh\necho 7.0.0\n", { mode: 0o755 });
	linkCurrent(dataDir, "bin", "7.0.0");
	if (platform === "win32") {
		mkdirSync(binDir, { recursive: true });
		linkSync(program, join(binDir, "dg.exe"));
		return;
	}
	writeDgLink(binDir, dataDir, "7.0.0", platform, () => {});
}

const never = (): boolean => false;
const always = (): boolean => true;

posix("doctor check dg-launcher", () => {
	test("is ok and says it runs from source when no compiled dg is installed", async () => {
		const result = await dgLauncherCheck(never, "linux").run(context());

		expect(result.status).toBe("ok");
		expect(result.detail).toBe("no compiled dg installed; running from source");
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
		expect(result.fix).toBe("dg install");
		expect(runnableFix(result.fix ?? null)).toEqual(["dg", "install"]);
	});

	test("names install --cli-only as the fix for a CLI-only install", async () => {
		const ctx = context();
		installLaunchers(ctx);
		rmSync(join(ctx.paths.binDir, "dg"));

		const result = await dgLauncherCheck(always, "linux").run(ctx);

		expect(result.status).toBe("warn");
		expect(result.fix).toBe("dg install --cli-only");
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
		rmSync(dg);
		writeFileSync(dg, "#!/bin/sh\necho other tool\n");

		const result = await dgLauncherCheck(never, "linux").run(ctx);

		expect(result.status).toBe("warn");
		expect(result.detail).toBe(`${dg} is not a dg launcher`);
		expect(result.fix).toBe(
			`remove or rename ${dg}, then run dg install`,
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
		expect(check?.fix).toBe("dg install");
	});
});

describe("doctor check dg-launcher on the win32 platform parameter", () => {
	test("warns when a compiled dg is installed and dg.exe is missing", async () => {
		const ctx = context();
		installLaunchers(ctx, "win32");
		rmSync(join(ctx.paths.binDir, "dg.exe"));

		const result = await dgLauncherCheck(never, "win32").run(ctx);

		expect(result.status).toBe("warn");
		expect(result.fix).toBe("dg install");
	});

	test("reads dg.exe, so a dg file with no extension does not count", async () => {
		const ctx = context();
		installLaunchers(ctx, "win32");
		rmSync(join(ctx.paths.binDir, "dg.exe"));
		writeFileSync(join(ctx.paths.binDir, "dg"), "#!/bin/sh\n");

		const result = await dgLauncherCheck(never, "win32").run(ctx);

		expect(result.status).toBe("warn");
	});

	test("is ok when dg.exe is a hard link to the installed program", async () => {
		const ctx = context();
		installLaunchers(ctx, "win32");

		const result = await dgLauncherCheck(never, "win32").run(ctx);

		expect(result.status).toBe("ok");
	});

	test("warns when dg.exe is a copy that is not linked to an installed program", async () => {
		const ctx = context();
		installLaunchers(ctx, "win32");
		const exe = join(ctx.paths.binDir, "dg.exe");
		rmSync(exe);
		writeFileSync(exe, "MZ");

		const result = await dgLauncherCheck(never, "win32").run(ctx);

		expect(result.status).toBe("warn");
		expect(result.detail).toBe(`${exe} is not a dg launcher`);
	});
});

describe("doctor check program-present", () => {
	const programCheck = (): DoctorCheck | undefined =>
		sharedChecks.find((check) => check.id === "program-present");

	test("is ok and says it runs from source when no compiled dg is installed", async () => {
		const result = await programCheck()?.run(context());

		expect(result?.status).toBe("ok");
		expect(result?.detail).toBe("no compiled dg installed; running from source");
	});

	test.skipIf(process.platform === "win32")("is ok and names the version the installed program prints", async () => {
		const ctx = context();
		installLaunchers(ctx);

		const result = await programCheck()?.run(ctx);

		expect(result?.status).toBe("ok");
		expect(result?.detail).toContain("the dg program");
	});

	test.skipIf(process.platform === "win32")("fails when bin/current points at a version whose program is gone", async () => {
		const ctx = context();
		installLaunchers(ctx);
		rmSync(join(ctx.paths.dataDir, "bin", "7.0.0"), { recursive: true });

		const result = await programCheck()?.run(ctx);

		expect(result?.status).toBe("fail");
		expect(result?.detail).toContain(compiledProgramPath(ctx.paths.dataDir));
	});

	test("is registered in place of runtime-present", () => {
		const ids = sharedChecks.map((check) => check.id);

		expect(ids).toContain("program-present");
		expect(ids).not.toContain("runtime-present");
	});
});
