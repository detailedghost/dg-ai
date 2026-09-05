import { describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import { getPinnedOrigin } from "../../src/server/origin";
import {
	cleanupDgHome,
	ENTRY,
	EXTENSION_ORIGIN,
	freshDgHome,
	subprocessEnv,
} from "../utils/daemon-harness";

type RunResult = { code: number; stdout: string; stderr: string };

async function dg(dgHome: string, ...args: string[]): Promise<RunResult> {
	const proc = Bun.spawn([process.execPath, ENTRY, ...args], {
		env: subprocessEnv(dgHome, 0),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

async function withHome(run: (dgHome: string) => Promise<void>): Promise<void> {
	const dgHome = freshDgHome();
	try {
		await run(dgHome);
	} finally {
		cleanupDgHome(dgHome);
	}
}

describe("dg-daemon origin show", () => {
	it("reports that nothing is pinned yet on a fresh install", async () => {
		await withHome(async (dgHome) => {
			const result = await dg(dgHome, "origin", "show");
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("no origin pinned");
		});
	});

	it("prints a previously pinned origin", async () => {
		await withHome(async (dgHome) => {
			const { writeConfig } = await import("../../src/server/config-store");
			writeConfig(resolveDgPaths({ env: { DG_HOME: dgHome } }), {
				pinnedOrigin: EXTENSION_ORIGIN,
			});

			const result = await dg(dgHome, "origin", "show");
			expect(result.code).toBe(0);
			expect(result.stdout).toContain(EXTENSION_ORIGIN);
		});
	});
});

describe("dg-daemon origin clear", () => {
	it("removes a pinned origin so a new one can pin", async () => {
		await withHome(async (dgHome) => {
			const { writeConfig } = await import("../../src/server/config-store");
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			writeConfig(paths, { pinnedOrigin: EXTENSION_ORIGIN });

			const result = await dg(dgHome, "origin", "clear");

			expect(result.code).toBe(0);
			expect(getPinnedOrigin(paths)).toBeUndefined();
		});
	});

	it("is a harmless no-op when nothing was pinned", async () => {
		await withHome(async (dgHome) => {
			const result = await dg(dgHome, "origin", "clear");
			expect(result.code).toBe(0);
		});
	});
});
