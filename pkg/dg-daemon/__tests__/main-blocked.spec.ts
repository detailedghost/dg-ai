import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node/dg-paths";
import { ensureLayout, type LayoutResult } from "@dg/common/node/layout";
import { main } from "../src/main";

const posix = describe.skipIf(process.platform === "win32");

let tempHome: string;
let saved: Record<"DG_HOME" | "DG_KEY_SOURCE", string | undefined>;
let realError: typeof console.error;

beforeEach(() => {
	saved = { DG_HOME: process.env.DG_HOME, DG_KEY_SOURCE: process.env.DG_KEY_SOURCE };
	tempHome = mkdtempSync(join(tmpdir(), "dg-main-blocked-"));
	process.env.DG_HOME = join(tempHome, ".dg");
	process.env.DG_KEY_SOURCE = "file";
	realError = console.error;
	console.error = () => {};
});

afterEach(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	console.error = realError;
	rmSync(tempHome, { recursive: true, force: true });
});

async function blockDaemon(): Promise<void> {
	const paths = resolveDgPaths();
	const from = join(paths.legacyHome, "daemon");
	await ensureLayout(paths, {
		log: () => {},
		readdir: () => ["daemon"],
		load: async () =>
			({
				snapshot: () => ({}),
				planLayout: () => ({}),
				mutates: () => false,
				applyLayout: () =>
					({
						daemon: { kind: "blocked", reason: "live-writer", from, to: paths.daemonDir, fix: `dg: kept ${from}; stop it` },
					}) as unknown as LayoutResult,
			}) as never,
	});
}

posix("dg-daemon main with a blocked daemon entry", () => {
	it("refuses serve before it writes the owner token or opens a store", async () => {
		await blockDaemon();
		const paths = resolveDgPaths();

		const code = await main(["serve"]);

		expect(code).toBe(1);
		expect(existsSync(join(paths.daemonDir, "owner.token"))).toBe(false);
		expect(existsSync(paths.daemonDir)).toBe(false);
		expect(existsSync(paths.logDir)).toBe(false);
	});
});

function twoUsedHome(): { from: string; to: string } {
	const paths = resolveDgPaths();
	const from = join(paths.legacyHome, "daemon");
	for (const folder of [from, paths.daemonDir]) {
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, "key"), "k");
	}
	return { from, to: paths.daemonDir };
}

posix("dg-daemon main with two used daemon folders", () => {
	it("exits 78 on serve with the two-used text on stderr and writes no pid file", async () => {
		const { from, to } = twoUsedHome();
		const errors: string[] = [];
		console.error = (...args: unknown[]) => void errors.push(args.join(" "));

		const code = await main(["serve"]);

		expect(code).toBe(78);
		expect(errors.join("\n")).toContain(
			`dg: two daemon folders hold data: ${from} and ${to}. dg does not choose one and does not merge them. Move the folder that you do not want to a different name, then run the command again`,
		);
		expect(readdirSync(to).filter((name) => name.endsWith(".pid"))).toEqual([]);
		expect(existsSync(join(to, "owner.token"))).toBe(false);
	});

	it("runs status without the layout block", async () => {
		twoUsedHome();
		const errors: string[] = [];
		console.error = (...args: unknown[]) => void errors.push(args.join(" "));

		const code = await main(["status"]);

		expect(code).not.toBe(78);
		expect(errors.join("\n")).not.toContain("two daemon folders hold data");
	});
});
