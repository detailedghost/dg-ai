import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	allChecks,
	allowRule,
	type CheckStatus,
	CURRENT_TOOL_VERSION,
	checksOf,
	doctorWorld,
	type FakeCredentialDaemon,
	INSTALLED_VERSION,
	mentions,
	NEWER_PLUGIN_VERSION,
	OLD_TOOL_VERSION,
	snapshotTree,
	startFakeCredentialDaemon,
} from "./doctor-fixtures";
import { anyToolCheck } from "../src/doctor/checks";
import { createContext, doctorExitCode, runDoctor } from "../src/doctor/runner";
import { sharedChecks } from "../src/doctor/shared";
import {
	CLI_PATH,
	hasAllowRule,
	isOlder,
	parseVersion,
} from "../src/doctor/probes";

const STATUSES: CheckStatus[] = ["ok", "warn", "fail"];
const SHIPPED_ITEMS = [
	"jot",
	"bg",
	"sniff",
	"worktree",
	"spec",
	"proxy",
	"thrash",
	"channel-review",
	"demo",
	"proto",
	"launch",
	"batch-open",
	"credentials",
	"install",
];

let world = doctorWorld();

afterEach(() => {
	world.cleanup();
	world = doctorWorld();
});

describe("dg-skills doctor --json shape", () => {
	test("prints one document with items, checks and ok", async () => {
		world.healthy(["jot"]);
		const { run, report } = await world.report(["jot"]);
		expect(run.exitCode).toBe(0);
		expect(Object.keys(report).sort()).toEqual(["items", "ok"]);
		expect(typeof report.ok).toBe("boolean");
		expect(report.items.length).toBeGreaterThan(0);
		for (const entry of report.items) {
			expect(Object.keys(entry).sort()).toEqual(["checks", "item"]);
			expect(typeof entry.item).toBe("string");
			expect(entry.checks.length).toBeGreaterThan(0);
			for (const check of entry.checks) {
				expect(typeof check.id).toBe("string");
				expect(check.id.length).toBeGreaterThan(0);
				expect(STATUSES).toContain(check.status);
				expect(typeof check.detail).toBe("string");
				expect(check.detail.length).toBeGreaterThan(0);
				for (const key of Object.keys(check))
					expect(["id", "status", "detail", "fix"]).toContain(key);
				if (check.fix !== undefined && check.fix !== null)
					expect(check.fix.length).toBeGreaterThan(0);
			}
		}
	});

	test("ok is true exactly when no check fails", async () => {
		world.healthy([]);
		const { report } = await world.report(["jot"]);
		const failed = allChecks(report).some((check) => check.status === "fail");
		expect(report.ok).toBe(!failed);
	});

	test("lists every shipped item with at least one check on a full run", async () => {
		world.healthy([]);
		const { report } = await world.report();
		for (const item of SHIPPED_ITEMS)
			expect([item, checksOf(report, item).length > 0]).toEqual([item, true]);
	});

	test("runs only the selected items, in the order given", async () => {
		world.healthy([]);
		const { report } = await world.report(["bg", "jot"]);
		const names = report.items.map((entry) => entry.item);
		expect(names).toContain("jot");
		expect(names).toContain("bg");
		expect(names).not.toContain("worktree");
		expect(names).not.toContain("spec");
		expect(names.indexOf("bg")).toBeLessThan(names.indexOf("jot"));
	});
});

describe("dg-skills doctor exit codes", () => {
	test("exits 0 and reports ok for a healthy item", async () => {
		world.healthy(["jot"]);
		const { run, report } = await world.report(["jot"]);
		expect(run.exitCode).toBe(0);
		expect(report.ok).toBe(true);
		expect(allChecks(report).every((check) => check.status === "ok")).toBe(
			true,
		);
	});

	test("exits 0 when checks only warn", async () => {
		world.healthy([]);
		const { run, report } = await world.report(["jot"]);
		expect(run.exitCode).toBe(0);
		expect(report.ok).toBe(true);
		expect(allChecks(report).some((check) => check.status === "warn")).toBe(
			true,
		);
		expect(allChecks(report).some((check) => check.status === "fail")).toBe(
			false,
		);
	});

	test("exits 1 when any check fails", async () => {
		world.healthy(["worktree"]);
		world.removeTool("git");
		const { run, report } = await world.report(["worktree"]);
		expect(run.exitCode).toBe(1);
		expect(report.ok).toBe(false);
		expect(allChecks(report).some((check) => check.status === "fail")).toBe(
			true,
		);
	});

	test("exits 2 for an unknown item and lists the known items", async () => {
		world.healthy([]);
		const result = await world.run(["doctor", "no-such-item"]);
		expect(result.exitCode).toBe(2);
		const output = `${result.stdout}${result.stderr}`;
		expect(output).toContain("no-such-item");
		for (const item of ["jot", "bg", "worktree", "spec"])
			expect(output).toContain(item);
	});

	test("exits 2 and runs nothing when one of several items is unknown", async () => {
		world.healthy(["jot"]);
		const result = await world.run(["doctor", "jot", "no-such-item", "--json"]);
		expect(result.exitCode).toBe(2);
		expect(() => JSON.parse(result.stdout)).toThrow();
	});
});

describe("dg-skills doctor check outcomes", () => {
	test("a missing allow rule warns with the exact rule as the Fix", async () => {
		world.healthy([]);
		const { report } = await world.report(["jot"]);
		const rule = allowRule("jot");
		const warned = checksOf(report, "jot").filter(
			(check) => check.status === "warn" && check.fix === rule,
		);
		expect(warned).toHaveLength(1);
	});

	test("a present allow rule passes", async () => {
		world.healthy(["jot"]);
		const { report } = await world.report(["jot"]);
		expect(
			checksOf(report, "jot").some((check) => check.fix === allowRule("jot")),
		).toBe(false);
	});

	test("an allow rule for another subcommand does not satisfy the item", async () => {
		world.healthy(["bg"]);
		const { report } = await world.report(["jot"]);
		expect(
			checksOf(report, "jot").some(
				(check) => check.status === "warn" && check.fix === allowRule("jot"),
			),
		).toBe(true);
	});

	test("a missing required tool fails with a Fix", async () => {
		world.healthy(["worktree"]);
		world.removeTool("git");
		const { report } = await world.report(["worktree"]);
		const failed = checksOf(report, "worktree").filter(
			(check) => check.status === "fail" && mentions(check, /git/i),
		);
		expect(failed.length).toBeGreaterThan(0);
		for (const check of failed) {
			expect(typeof check.fix).toBe("string");
			expect((check.fix ?? "").length).toBeGreaterThan(0);
		}
	});

	test("a required tool below its minimum version fails and names the version", async () => {
		world.healthy(["worktree"]);
		world.installTool("git", OLD_TOOL_VERSION);
		const { run, report } = await world.report(["worktree"]);
		expect(run.exitCode).toBe(1);
		const failed = checksOf(report, "worktree").filter(
			(check) =>
				check.status === "fail" && check.detail.includes(OLD_TOOL_VERSION),
		);
		expect(failed.length).toBeGreaterThan(0);
		expect(failed.every((check) => (check.fix ?? "").length > 0)).toBe(true);
	});

	test("a current tool version passes the same check", async () => {
		world.healthy(["worktree"]);
		const { report } = await world.report(["worktree"]);
		expect(
			checksOf(report, "worktree").some((check) => check.status === "fail"),
		).toBe(false);
		expect(
			checksOf(report, "worktree").some((check) =>
				check.detail.includes(CURRENT_TOOL_VERSION),
			),
		).toBe(true);
	});

	test("a missing optional proxy backend warns with a Fix and does not fail", async () => {
		world.healthy(["proxy"]);
		world.removeTool("codex");
		const { run, report } = await world.report(["proxy"]);
		expect(run.exitCode).toBe(0);
		const warned = checksOf(report, "proxy").filter(
			(check) => check.status === "warn" && mentions(check, /codex/i),
		);
		expect(warned.length).toBeGreaterThan(0);
		expect(warned.every((check) => (check.fix ?? "").length > 0)).toBe(true);
		expect(
			checksOf(report, "proxy").some((check) => check.status === "fail"),
		).toBe(false);
	});

	test("extension items report an unreachable daemon with the start command as the Fix", async () => {
		world.healthy(["batch-open", "launch", "credentials"]);
		for (const item of ["batch-open", "launch", "credentials"]) {
			const { report } = await world.report([item]);
			const probes = checksOf(report, item).filter(
				(check) =>
					check.status !== "ok" && (check.fix ?? "").includes("dg-agent start"),
			);
			expect([item, probes.length > 0]).toEqual([item, true]);
		}
	});
});

describe("dg-skills doctor credential checks", () => {
	const CREDENTIAL = "channel-review/datadog";
	let daemon: FakeCredentialDaemon | undefined;

	afterEach(() => {
		daemon?.stop();
		daemon = undefined;
	});

	const credentialCheck = (report: Parameters<typeof checksOf>[0]) =>
		checksOf(report, "channel-review").find(
			(check) => check.id === "credential-channel-review-datadog",
		);

	test("a credential missing from the store warns with the credentials set Fix", async () => {
		world.healthy(["channel-review"]);
		daemon = startFakeCredentialDaemon(world, []);
		const { report } = await world.report(["channel-review"]);
		const check = credentialCheck(report);
		expect(check?.status).toBe("warn");
		expect(check?.detail).toContain(CREDENTIAL);
		expect(check?.fix).toBe(`${CLI_PATH} credentials set ${CREDENTIAL}`);
	});

	test("a stored credential passes and the check only lists metadata", async () => {
		world.healthy(["channel-review"]);
		daemon = startFakeCredentialDaemon(world, [CREDENTIAL]);
		const { report } = await world.report(["channel-review"]);
		const check = credentialCheck(report);
		expect(check?.status).toBe("ok");
		expect(check?.fix ?? null).toBeNull();
		expect(daemon.operations.length).toBeGreaterThan(0);
		expect(new Set(daemon.operations)).toEqual(new Set(["list"]));
	});

	test("a missing credential never makes the run fail when it is optional", async () => {
		world.healthy(["channel-review"]);
		daemon = startFakeCredentialDaemon(world, []);
		const { run } = await world.report(["channel-review"]);
		expect(run.exitCode).toBe(0);
		expect(daemon.operations).not.toContain("get");
	});
});

describe("dg-skills doctor shared checks", () => {
	test("a plugin newer than the installed binary fails once with a re-install Fix", async () => {
		world.healthy(["jot"]);
		world.installPlugin(NEWER_PLUGIN_VERSION);
		const { run, report } = await world.report([]);
		expect(run.exitCode).toBe(1);
		const stale = allChecks(report).filter(
			(check) =>
				check.detail.includes(NEWER_PLUGIN_VERSION) &&
				check.detail.includes(INSTALLED_VERSION),
		);
		expect(stale).toHaveLength(1);
		expect(stale[0]?.status).toBe("fail");
		expect(stale[0]?.fix).toMatch(/dg-skills install|bootstrap\.sh/);
	});

	test("the stale-binary failure also shows when only one item is selected", async () => {
		world.healthy(["jot"]);
		world.installPlugin(NEWER_PLUGIN_VERSION);
		const { run, report } = await world.report(["jot"]);
		expect(run.exitCode).toBe(1);
		expect(
			allChecks(report).filter((check) =>
				check.detail.includes(NEWER_PLUGIN_VERSION),
			),
		).toHaveLength(1);
	});

	test("a plugin equal to the installed binary passes", async () => {
		world.healthy(["jot"]);
		const { report } = await world.report(["jot"]);
		expect(
			allChecks(report).some((check) =>
				check.detail.includes(NEWER_PLUGIN_VERSION),
			),
		).toBe(false);
		expect(allChecks(report).some((check) => check.status === "fail")).toBe(
			false,
		);
	});

	test("a missing dg plugin is reported with a Fix", async () => {
		world.healthy(["jot"]);
		rmSync(join(world.home, ".claude", "plugins"), {
			recursive: true,
			force: true,
		});
		const { report } = await world.report(["jot"]);
		const missing = allChecks(report).filter(
			(check) => check.status !== "ok" && mentions(check, /plugin/i),
		);
		expect(missing.length).toBeGreaterThan(0);
		expect(missing.every((check) => (check.fix ?? "").length > 0)).toBe(true);
	});

	test("an unwritable scratch root fails with a Fix", async () => {
		world.healthy(["jot"]);
		const { report } = await world.report(["jot"], {
			AI_SCRATCH_DIR: "/proc/doctor-unwritable-scratch",
		});
		const failed = allChecks(report).filter(
			(check) => check.status === "fail" && mentions(check, /scratch/i),
		);
		expect(failed.length).toBeGreaterThan(0);
		expect(failed.every((check) => (check.fix ?? "").length > 0)).toBe(true);
	});

	test("an unwritable state root fails with a Fix", async () => {
		world.healthy(["jot"]);
		const { report } = await world.report(["jot"], {
			AI_STATE_DIR: "/proc/doctor-unwritable-state",
		});
		const failed = allChecks(report).filter(
			(check) => check.status === "fail" && mentions(check, /state/i),
		);
		expect(failed.length).toBeGreaterThan(0);
		expect(failed.every((check) => (check.fix ?? "").length > 0)).toBe(true);
	});
});

describe("dg-skills doctor text output", () => {
	test("prints one line per check with a status icon and an indented Fix line", async () => {
		world.healthy([]);
		const result = await world.run(["doctor", "jot"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("✅");
		expect(result.stdout).toContain("⚠️");
		expect(result.stdout).toMatch(
			new RegExp(
				`^\\s+Fix: ${allowRule("jot").replace(/[()*]/g, "\\$&")}$`,
				"m",
			),
		);
	});

	test("marks failing checks with the fail icon and exits 1", async () => {
		world.healthy(["worktree"]);
		world.removeTool("git");
		const result = await world.run(["doctor", "worktree"]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("❌");
		expect(result.stdout).toMatch(/^\s+Fix: .+$/m);
	});

	test("a passing check has no Fix line", async () => {
		world.healthy(["jot"]);
		const result = await world.run(["doctor", "jot"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain("Fix:");
		expect(result.stdout).not.toContain("⚠️");
		expect(result.stdout).not.toContain("❌");
	});
});

describe("dg-skills doctor on a bare machine", () => {
	test("every warning or failure carries a Fix and the run exits 1", async () => {
		rmSync(join(world.home, ".claude"), { recursive: true, force: true });
		const { run, report } = await world.report();
		expect(run.exitCode).toBe(1);
		expect(report.ok).toBe(false);
		const flagged = allChecks(report).filter((check) => check.status !== "ok");
		expect(flagged.length).toBeGreaterThan(0);
		for (const check of flagged)
			expect([check.id, (check.fix ?? "").length > 0]).toEqual([
				check.id,
				true,
			]);
	});
});

describe("dg-skills doctor reads and reports only", () => {
	test("starts no daemon, browser or network tool on a full run", async () => {
		world.healthy(["jot"]);
		const before = {
			claude: snapshotTree(join(world.home, ".claude")),
			dg: snapshotTree(join(world.home, ".dg")),
		};
		const settings = readFileSync(
			join(world.home, ".claude", "settings.json"),
			"utf8",
		);
		const { run } = await world.report();
		expect([0, 1]).toContain(run.exitCode);
		expect(world.forbiddenCalls()).toEqual([]);
		expect(snapshotTree(join(world.home, ".claude"))).toEqual(before.claude);
		expect(snapshotTree(join(world.home, ".dg"))).toEqual(before.dg);
		expect(
			readFileSync(join(world.home, ".claude", "settings.json"), "utf8"),
		).toBe(settings);
		expect(snapshotTree(join(world.home, ".dg", "daemon"))).toEqual({});
	});

	test("never writes the allow rule it asks for", async () => {
		world.healthy([]);
		await world.run(["doctor"]);
		const settings = JSON.parse(
			readFileSync(join(world.home, ".claude", "settings.json"), "utf8"),
		);
		expect(settings.permissions.allow).toEqual([]);
	});

	test("help starts no daemon or browser", async () => {
		world.healthy([]);
		const result = await world.run(["doctor", "--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("--json");
		expect(world.forbiddenCalls()).toEqual([]);
	});
});

describe("dg-skills doctor probe helpers", () => {
	test("parseVersion reads the first dotted number from tool output", () => {
		expect(parseVersion("git version 2.43.0")).toBe("2.43.0");
		expect(parseVersion("codex-cli 0.9")).toBe("0.9");
		expect(parseVersion("no digits here")).toBeNull();
	});

	test("isOlder treats an equal version as current", () => {
		expect(isOlder("2.17.0", "2.17.0")).toBe(false);
		expect(isOlder("2.16.9", "2.17.0")).toBe(true);
		expect(isOlder("2.18.0", "2.17.0")).toBe(false);
	});

	test("hasAllowRule accepts the exact rule and the blanket rule only", () => {
		expect(hasAllowRule([allowRule("jot")], "jot")).toBe(true);
		expect(hasAllowRule([`Bash(${CLI_PATH}:*)`], "bg")).toBe(true);
		expect(hasAllowRule([allowRule("jot")], "bg")).toBe(false);
		expect(hasAllowRule([], "jot")).toBe(false);
	});
});

describe("dg-skills doctor edge cases", () => {
	test("a blanket dg-skills allow rule satisfies every item", async () => {
		world.healthy([]);
		writeFileSync(
			join(world.home, ".claude", "settings.json"),
			JSON.stringify({ permissions: { allow: [`Bash(${CLI_PATH}:*)`] } }),
		);
		const { report } = await world.report(["jot", "bg"]);
		for (const item of ["jot", "bg"])
			expect(
				checksOf(report, item).some((check) => check.fix?.startsWith("Bash(")),
			).toBe(false);
	});

	test("malformed settings warn with the rule as the Fix and do not crash", async () => {
		world.healthy([]);
		writeFileSync(join(world.home, ".claude", "settings.json"), "{not json");
		const { run, report } = await world.report(["jot"]);
		expect(run.exitCode).toBe(0);
		expect(
			checksOf(report, "jot").some(
				(check) => check.status === "warn" && check.fix === allowRule("jot"),
			),
		).toBe(true);
	});

	test("missing settings file warns with the rule as the Fix", async () => {
		world.healthy([]);
		rmSync(join(world.home, ".claude", "settings.json"));
		const { run, report } = await world.report(["jot"]);
		expect(run.exitCode).toBe(0);
		expect(
			checksOf(report, "jot").some(
				(check) => check.status === "warn" && check.fix === allowRule("jot"),
			),
		).toBe(true);
	});

	test("a plugin older than the installed binary warns and does not fail", async () => {
		world.healthy(["jot"]);
		rmSync(join(world.home, ".claude", "plugins"), { recursive: true, force: true });
		world.installPlugin("0.0.1");
		const { run, report } = await world.report(["jot"]);
		expect(run.exitCode).toBe(0);
		const older = allChecks(report).filter(
			(check) => check.detail.includes("0.0.1") && check.status === "warn",
		);
		expect(older).toHaveLength(1);
		expect((older[0]?.fix ?? "").length).toBeGreaterThan(0);
	});

	test("with several cached plugin versions the newest one is compared", async () => {
		world.healthy(["jot"]);
		world.installPlugin("0.0.1");
		world.installPlugin(NEWER_PLUGIN_VERSION);
		const { run, report } = await world.report(["jot"]);
		expect(run.exitCode).toBe(1);
		expect(
			allChecks(report).filter(
				(check) => check.status === "fail" && check.detail.includes(NEWER_PLUGIN_VERSION),
			),
		).toHaveLength(1);
	});

	test("a too-old required tool gets an upgrade Fix", async () => {
		world.healthy(["worktree"]);
		world.installTool("git", OLD_TOOL_VERSION);
		const { report } = await world.report(["worktree"]);
		const old = checksOf(report, "worktree").find(
			(check) => check.id === "tool-git" && check.status === "fail",
		);
		expect(old?.fix).toBe("sudo apt-get install --only-upgrade -y git");
	});

	test("a too-old tool in an any-of check says too old, not not found", async () => {
		world.healthy(["proxy"]);
		const check = anyToolCheck(
			"tool-any",
			[{ tool: "git", min: "999.0.0" }],
			{ required: true, why: "needs git" },
		);
		const result = await check.run(
			createContext({ home: world.home, env: world.env() }),
		);
		expect(result.status).toBe("fail");
		expect(result.detail).toContain("too old");
		expect(result.detail).not.toContain("not found");
		expect(result.fix).toBe("sudo apt-get install --only-upgrade -y git");
	});

	test("a tool exactly at its minimum version passes", async () => {
		world.healthy(["worktree"]);
		world.installTool("git", "2.17.0");
		const { run, report } = await world.report(["worktree"]);
		expect(run.exitCode).toBe(0);
		expect(
			checksOf(report, "worktree").some((check) => check.status === "fail"),
		).toBe(false);
	});

	test("repeating an item runs it once", async () => {
		world.healthy(["jot"]);
		const { report } = await world.report(["jot", "jot"]);
		expect(report.items.filter((entry) => entry.item === "jot")).toHaveLength(1);
	});

	test("a missing vcs CLI fails only when neither gh nor glab exists", async () => {
		world.healthy(["file"]);
		world.removeTool("gh");
		const withGlab = await world.report(["file"]);
		expect(
			checksOf(withGlab.report, "file").some((check) => check.status === "fail"),
		).toBe(false);
		world.removeTool("glab");
		const neither = await world.report(["file"]);
		expect(neither.run.exitCode).toBe(1);
		expect(
			checksOf(neither.report, "file").some(
				(check) => check.status === "fail" && (check.fix ?? "").length > 0,
			),
		).toBe(true);
	});

	test("without claude or codex a proxy backend run fails when no backend exists", async () => {
		world.healthy(["proxy"]);
		world.removeTool("codex");
		world.removeTool("copilot");
		const { run, report } = await world.report(["proxy"]);
		expect(run.exitCode).toBe(1);
		expect(
			checksOf(report, "proxy").some(
				(check) => check.status === "fail" && (check.fix ?? "").length > 0,
			),
		).toBe(true);
	});

	test("a machine with only grok installed passes the backend check and warns per missing backend", async () => {
		world.healthy(["proxy"]);
		for (const tool of ["codex", "copilot"]) world.removeTool(tool);
		world.installTool("grok");
		const { run, report } = await world.report(["proxy"]);
		expect(run.exitCode).toBe(0);
		const checks = checksOf(report, "proxy");
		expect(checks.find((check) => check.id === "tool-backend")?.status).toBe("ok");
		expect(checks.find((check) => check.id === "tool-grok")?.status).toBe("ok");
		for (const tool of ["codex", "copilot", "pi", "opencode"]) {
			const missing = checks.find((check) => check.id === `tool-${tool}`);
			expect([tool, missing?.status]).toEqual([tool, "warn"]);
			expect((missing?.fix ?? "").length).toBeGreaterThan(0);
		}
	});

	test("a stale pid file reports the daemon as unreachable with the start Fix", async () => {
		world.healthy(["batch-open"]);
		const daemonDir = join(world.home, ".dg", "daemon");
		mkdirSync(daemonDir, { recursive: true });
		writeFileSync(
			join(daemonDir, "daemon.pid"),
			JSON.stringify({
				pid: 1,
				port: 1,
				instanceId: "stale",
				versions: { package: "0.0.0", protocol: 1 },
			}),
		);
		const { report } = await world.report(["batch-open"]);
		const daemon = checksOf(report, "batch-open").find((check) => check.id === "daemon");
		expect(daemon?.status).toBe("fail");
		expect(daemon?.fix).toContain("dg-agent start");
	});

	test("a daemon that answers its health probe passes the daemon check", async () => {
		world.healthy(["batch-open"]);
		const instanceId = "live-instance";
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => Response.json({ instanceId }),
		});
		try {
			const daemonDir = join(world.home, ".dg", "daemon");
			mkdirSync(daemonDir, { recursive: true });
			writeFileSync(
				join(daemonDir, "daemon.pid"),
				JSON.stringify({
					pid: process.pid,
					port: server.port,
					instanceId,
					versions: { package: "0.0.0", protocol: 1 },
				}),
			);
			const { report } = await world.report(["batch-open"]);
			expect(
				checksOf(report, "batch-open").find((check) => check.id === "daemon")?.status,
			).toBe("ok");
			expect(world.forbiddenCalls()).toEqual([]);
		} finally {
			server.stop(true);
		}
	});

	test("a pending pairing code alone is not reported as paired", async () => {
		world.healthy(["batch-open"]);
		writeFileSync(join(world.home, ".dg", "pairing.json"), "{}");
		const { report } = await world.report(["batch-open"]);
		const pairing = checksOf(report, "batch-open").find(
			(check) => check.id === "extension-paired",
		);
		expect(pairing?.status).toBe("warn");
		expect(pairing?.detail).toContain("pending");
		expect(pairing?.fix).toBe("dg-daemon pair");
	});

	test("an extension that never connected warns with the pair command", async () => {
		world.healthy(["batch-open"]);
		const { report } = await world.report(["batch-open"]);
		const pairing = checksOf(report, "batch-open").find(
			(check) => check.id === "extension-paired",
		);
		expect(pairing?.status).toBe("warn");
		expect(pairing?.detail).toContain("open the extension");
		expect((pairing?.fix ?? "").length).toBeGreaterThan(0);
	});

	test("a pinned extension origin in the daemon config reports paired", async () => {
		world.healthy(["batch-open"]);
		const daemonDir = join(world.home, ".dg", "daemon");
		mkdirSync(daemonDir, { recursive: true });
		writeFileSync(
			join(daemonDir, "config.json"),
			JSON.stringify({ pinnedOrigin: "chrome-extension://abc" }),
		);
		const { report } = await world.report(["batch-open"]);
		const pairing = checksOf(report, "batch-open").find(
			(check) => check.id === "extension-paired",
		);
		expect(pairing?.status).toBe("ok");
		expect(pairing?.detail).toContain("chrome-extension://abc");
	});

	test("an unreadable daemon config does not report paired", async () => {
		world.healthy(["batch-open"]);
		const daemonDir = join(world.home, ".dg", "daemon");
		mkdirSync(daemonDir, { recursive: true });
		writeFileSync(join(daemonDir, "config.json"), "{not json");
		const { report } = await world.report(["batch-open"]);
		expect(
			checksOf(report, "batch-open").find((check) => check.id === "extension-paired")
				?.status,
		).toBe("warn");
	});

	test("a missing unslop plugin warns for polish with a Fix and a present one passes", async () => {
		world.healthy(["polish"]);
		const missing = await world.report(["polish"]);
		const warned = checksOf(missing.report, "polish").find((check) => check.id === "unslop");
		expect(warned?.status).toBe("warn");
		expect((warned?.fix ?? "").length).toBeGreaterThan(0);
		const skill = join(world.home, ".claude", "skills", "unslop");
		mkdirSync(skill, { recursive: true });
		writeFileSync(join(skill, "SKILL.md"), "unslop");
		const present = await world.report(["polish"]);
		expect(
			checksOf(present.report, "polish").find((check) => check.id === "unslop")?.status,
		).toBe("ok");
	});

	test("a broken skill tree fails the skill-files check with a Fix", async () => {
		world.healthy(["jot"]);
		rmSync(join(world.home, ".claude", "plugins"), { recursive: true, force: true });
		const dir = join(
			world.home,
			".claude",
			"plugins",
			"cache",
			"fake-market",
			"dg",
			INSTALLED_VERSION,
			"plugins",
			"dg",
			"skills",
		);
		mkdirSync(dir, { recursive: true });
		const { run, report } = await world.report(["jot"]);
		expect(run.exitCode).toBe(1);
		expect(
			checksOf(report, "jot").some(
				(check) =>
					check.id === "skill-files" &&
					check.status === "fail" &&
					(check.fix ?? "").length > 0,
			),
		).toBe(true);
	});
});

describe("dg-skills doctor runner", () => {
	test("a check that throws fails with the check id, the error and a rerun Fix", async () => {
		const throwing = {
			id: "boom",
			run() {
				throw new Error("kaput");
			},
		};
		const report = await runDoctor(["thing"], {
			shared: [],
			thing: [throwing],
		}, createContext({ home: world.home, env: world.env() }));
		const entry = report.items.find((item) => item.item === "thing")?.checks[0];
		expect(entry?.status).toBe("fail");
		expect(entry?.detail).toContain("boom");
		expect(entry?.detail).toContain("kaput");
		expect(entry?.fix).toBe(`${CLI_PATH} doctor thing --json`);
		expect(entry?.detail).toContain("issue");
		expect(report.ok).toBe(false);
		expect(doctorExitCode(report)).toBe(1);
	});
});

describe("dg-skills doctor context isolation", () => {
	test("the state root check reads the context env, not the process env", async () => {
		const blocker = join(world.home, "blocker");
		writeFileSync(blocker, "");
		const ctx = createContext({
			home: world.home,
			env: { HOME: world.home, AI_STATE_DIR: join(blocker, "state") },
		});
		const check = sharedChecks.find((entry) => entry.id === "state-root");
		const result = await check?.run(ctx);
		expect(result?.status).toBe("fail");
		expect(result?.fix).toContain(blocker);
		expect(result?.fix).not.toMatch(/^ls /);
	});

	test("the install checks use the context state directory", async () => {
		world.healthy(["install"]);
		const { report } = await world.report(["install"]);
		const binary = checksOf(report, "install").find(
			(check) => check.id === "cli-binary",
		);
		expect(binary?.status).toBe("warn");
		const dgBin = join(world.home, ".dg", "bin");
		mkdirSync(dgBin, { recursive: true });
		writeFileSync(join(dgBin, "dg-skills"), "");
		const again = await world.report(["install"]);
		expect(
			checksOf(again.report, "install").find((check) => check.id === "cli-binary")
				?.status,
		).toBe("ok");
	});
});

describe("dg-skills doctor extension items", () => {
	test("require-extension includes the daemon and pairing checks", async () => {
		world.healthy(["require-extension"]);
		const { report } = await world.report(["require-extension"]);
		const ids = checksOf(report, "require-extension").map((check) => check.id);
		expect(ids).toContain("daemon");
		expect(ids).toContain("extension-paired");
	});

	test("a full install keeps its mode in the bootstrap Fix", async () => {
		world.healthy(["install"]);
		world.installPlugin("0.0.1");
		world.installPlugin(NEWER_PLUGIN_VERSION);
		const { report } = await world.report(["install"]);
		const fixes = allChecks(report)
			.map((check) => check.fix ?? "")
			.filter((fix) => fix.includes("bootstrap.sh"));
		expect(fixes.length).toBeGreaterThan(0);
		for (const fix of fixes) expect(fix).not.toContain("--cli-only");
	});

	test("a CLI-only install keeps --cli-only in the bootstrap Fix", async () => {
		world.healthy(["install"]);
		world.installPlugin(NEWER_PLUGIN_VERSION);
		mkdirSync(join(world.home, ".dg"), { recursive: true });
		writeFileSync(join(world.home, ".dg", "cli-only"), "");
		const { report } = await world.report(["install"]);
		const fixes = allChecks(report)
			.map((check) => check.fix ?? "")
			.filter((fix) => fix.includes("bootstrap.sh"));
		expect(fixes.length).toBeGreaterThan(0);
		for (const fix of fixes) expect(fix).toContain("--cli-only");
	});

	test("a CLI-only install warns instead of failing on the daemon", async () => {
		world.healthy(["batch-open"]);
		mkdirSync(join(world.home, ".dg"), { recursive: true });
		writeFileSync(join(world.home, ".dg", "cli-only"), "");
		const { run, report } = await world.report(["batch-open"]);
		const daemon = checksOf(report, "batch-open").find(
			(check) => check.id === "daemon",
		);
		expect(daemon?.status).toBe("warn");
		expect(daemon?.fix).toContain("dg-skills install");
		expect(
			checksOf(report, "batch-open").some((check) => check.status === "fail"),
		).toBe(false);
		expect(run.exitCode).toBe(0);
	});

	test("prototype property names are unknown items, not crashes", async () => {
		world.healthy([]);
		const result = await world.run(["doctor", "constructor"]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).not.toContain("TypeError");
	});
});
