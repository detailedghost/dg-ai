import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { blockedText } from "@dg/common/node/layout";
import { installChecks } from "../src/install/doctor";
import { createContext } from "../src/doctor/runner";
import type { CheckResult } from "../src/doctor/types";
import {
	type LegacyLayoutHome,
	type LegacyLayoutShape,
	legacyLayoutHome,
	snapshotTree,
} from "./doctor-fixtures";
import { scratchFixtures } from "./git-repo-fixtures";

const fixtures = scratchFixtures();
const opened: LegacyLayoutHome[] = [];

afterEach(() => {
	for (const world of opened.splice(0)) world.close();
	fixtures.cleanup();
});

function layoutCheck() {
	const found = installChecks.find((entry) => entry.id === "layout");
	if (!found) throw new Error("installChecks has no layout check");
	return found;
}

function world(shape: LegacyLayoutShape) {
	const home = fixtures.tmp("doctor-layout-home-");
	const fixture = legacyLayoutHome(home, shape);
	opened.push(fixture);
	return { home, ...fixture };
}

async function runCheck(
	home: string,
	paths: ReturnType<typeof resolveDgPaths>,
): Promise<CheckResult> {
	return layoutCheck().run(
		createContext({ home, env: { HOME: home }, paths }),
	);
}

function occurrences(text: string, part: string): number {
	return text.split(part).length - 1;
}

const movedText = (from: string, to: string) =>
	`${from} has not moved to ${to}; run dg-skills install`;

describe("installChecks layout check", () => {
	test("is ok when the home has no legacy folder", async () => {
		const home = fixtures.tmp("doctor-layout-empty-");
		const paths = resolveDgPaths({
			platform: process.platform,
			homeDir: home,
			env: {},
		});

		const result = await runCheck(home, paths);

		expect(result.status).toBe("ok");
		expect(result.detail).toContain("every dg file is in its per-OS folder");
	});

	test("is ok when the legacy folder holds only launchers, the extension and an empty pending file", async () => {
		const { home, paths } = world("clean");

		const result = await runCheck(home, paths);

		expect(result.status).toBe("ok");
	});

	test("is ok for a flat DG_HOME home", async () => {
		const home = fixtures.tmp("doctor-layout-flat-");
		const flat = join(home, ".dg");
		for (const role of ["bin", "config", "data", "state", "cache", "log"]) {
			mkdirSync(join(flat, role), { recursive: true });
		}
		writeFileSync(join(flat, "state", "note.txt"), "x");
		const paths = resolveDgPaths({
			platform: process.platform,
			homeDir: home,
			env: { DG_HOME: flat },
		});

		const result = await runCheck(home, paths);

		expect(result.status).toBe("ok");
	});

	test("warns on a split phone copy, names both paths once and fixes with dg-skills install", async () => {
		const { home, paths, legacy } = world("split");

		const result = await runCheck(home, paths);

		expect(result.status).toBe("warn");
		expect(occurrences(result.detail, join(legacy, "phone"))).toBe(1);
		expect(occurrences(result.detail, paths.phoneRoot)).toBe(1);
		expect(result.detail).toContain(
			`${join(legacy, "phone")} and ${paths.phoneRoot} both hold data; compare them, then remove the one you do not need`,
		);
		expect(result.fix).toContain("dg-skills install");
	});

	test("reports a non-live legacy phone with no per-OS copy as not moved, not kept", async () => {
		const { home, paths, legacy } = world("no-hook");

		const result = await runCheck(home, paths);

		expect(result.status).toBe("warn");
		expect(result.detail).toContain(movedText(join(legacy, "phone"), paths.phoneRoot));
		expect(result.detail).not.toContain("dg: kept");
		expect(result.fix).toContain("dg-skills install");
	});

	test("warns with the kept text for a live daemon pid file and names nothing else", async () => {
		const { home, paths, legacy } = world("blocked");

		const result = await runCheck(home, paths);

		expect(result.status).toBe("warn");
		expect(result.detail).toContain(
			blockedText({
				reason: "live-writer",
				from: join(legacy, "daemon"),
				to: paths.daemonDir,
			}),
		);
		expect(result.detail.split("\n")).toHaveLength(1);
		expect(result.detail).not.toContain("memory.db");
	});

	test("does not report a dead pid file as blocked", async () => {
		const { home, paths, legacy } = world("blocked");
		const dead = Bun.spawnSync(["true"]).pid;
		writeFileSync(
			join(legacy, "daemon", "daemon.pid"),
			JSON.stringify({ pid: dead }),
		);

		const result = await runCheck(home, paths);

		expect(result.detail).not.toContain("a process that writes it is running");
	});

	test("writes nothing, including beside a WAL-mode phone.db, and creates no install lock", async () => {
		const { home, paths } = world("split");
		const before = snapshotTree(home);

		await runCheck(home, paths);

		expect(snapshotTree(home)).toEqual(before);
		expect(existsSync(join(paths.dataDir, ".install.lock"))).toBe(false);
	});

	test("reports a pending removal with a complete copy as waiting for removal", async () => {
		const { home, paths, legacy } = world("pending");

		const result = await runCheck(home, paths);

		expect(result.status).toBe("warn");
		expect(result.detail).toContain(
			`${join(legacy, "phone")} is copied and waits for removal`,
		);
	});

	test("reports a pending removal with an incomplete copy as kept", async () => {
		const { home, paths, legacy } = world("pending-incomplete");

		const result = await runCheck(home, paths);

		expect(result.status).toBe("warn");
		expect(result.detail).toContain(
			`${join(legacy, "phone")} is copied but the copy is incomplete; dg keeps it`,
		);
	});

	test("lists one line per leftover entry, joined by a newline, with a single install fix", async () => {
		const { home, paths, legacy } = world("no-hook");
		mkdirSync(join(legacy, "daemon"), { recursive: true });
		writeFileSync(join(legacy, "daemon", "daemon.db"), "daemon-bytes");
		writeFileSync(join(legacy, "daemon", "daemon.pid"), JSON.stringify({ pid: process.pid }));

		const result = await runCheck(home, paths);

		const lines = result.detail.split("\n");
		expect(result.status).toBe("warn");
		expect(lines).toHaveLength(2);
		expect(lines).toContain(movedText(join(legacy, "phone"), paths.phoneRoot));
		expect(lines).toContain(
			blockedText({ reason: "live-writer", from: join(legacy, "daemon"), to: paths.daemonDir }),
		);
		expect(result.fix).toBe("dg-skills install");
	});

	test("reports a legacy ssms config as not moved", async () => {
		const home = fixtures.tmp("doctor-layout-ssms-");
		const paths = resolveDgPaths({ platform: process.platform, homeDir: home, env: {} });
		mkdirSync(join(paths.legacyHome, "ssms"), { recursive: true });
		writeFileSync(join(paths.legacyHome, "ssms", "config.yaml"), "allow: []\n");

		const result = await runCheck(home, paths);

		expect(result.status).toBe("warn");
		expect(result.detail).toContain(`${join(paths.legacyHome, "ssms", "config.yaml")} has not moved to `);
		expect(result.detail).toContain("; run dg-skills install");
	});

	test("stays ok after the layout moved everything it can", async () => {
		const home = fixtures.tmp("doctor-layout-after-");
		const paths = resolveDgPaths({ platform: process.platform, homeDir: home, env: {} });
		mkdirSync(join(paths.legacyHome, "grants"), { recursive: true });
		writeFileSync(join(paths.legacyHome, "grants", "g.json"), "{}");
		const { ensureLayout } = await import("@dg/common/node/layout");
		await ensureLayout(paths, {});

		const result = await runCheck(home, paths);

		expect(result.status).toBe("ok");
	});
});
