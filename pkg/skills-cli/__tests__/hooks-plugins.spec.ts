import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { basename, join } from "node:path";
import { parseManifest } from "@dg/common/plugins/manifest";
import { encodeFrame, FRAME_FLAG_RESPONSE, type Frame } from "@dg/common/plugins/contract";
import { closeIpcConnections } from "@dg/common/plugins/transport/ipc";
import { FrameReader } from "@dg/common/plugins/transport/framing";
import { macOf } from "../src/plugin/approval";
import type { PluginRecord } from "../src/plugin/store";
import { hashTree } from "../src/plugin/tree";
import { downKeys, fakeKeys, TEST_KEY_HEX, useApprovalKeys } from "./support/approval-keys";
import { runExternalHook } from "../src/hooks/external";
import { hasConfiguredPlugins, resolveExternalHook } from "../src/hooks/plugins";
import { bashInput, hookWorld } from "./hooks/hook-fixtures";

const servers: Server[] = [];
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const reply = (frame: Frame, body: unknown): Frame => ({ encoding: "json", flags: FRAME_FLAG_RESPONSE, requestId: frame.requestId, payload: json(body) });

type Decide = (body: Record<string, unknown>) => Record<string, unknown> | "silent";

async function startPlugin(path: string, decide: Decide): Promise<{ connections: () => number; decides: Record<string, unknown>[] }> {
	let connections = 0;
	const decides: Record<string, unknown>[] = [];
	const server = createServer((socket: Socket) => {
		connections++;
		const reader = new FrameReader();
		socket.on("data", (chunk: Buffer) => {
			for (const frame of reader.push(chunk)) {
				const { route, body } = JSON.parse(new TextDecoder().decode(frame.payload)) as { route: string; body: Record<string, unknown> };
				if (route === "/v1/hello") socket.write(encodeFrame(reply(frame, { protocol: 1, encoding: "json", capabilities: ["hook"] })));
				if (route === "/v1/hook/decide") {
					decides.push(body);
					const answer = decide(body);
					if (answer !== "silent") socket.write(encodeFrame(reply(frame, answer)));
				}
			}
		});
		socket.on("error", () => {});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(path, resolve));
	chmodSync(path, 0o600);
	return { connections: () => connections, decides };
}

beforeEach(() => useApprovalKeys(fakeKeys()));

afterEach(async () => {
	useApprovalKeys(undefined);
	closeIpcConnections();
	for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

const MANIFEST = (name: string, extra = "") => `name = "${name}"\nversion = "1.0.0"\nkind = "hook"\ntransport = "ipc"\nendpoint = "p.sock"\n${extra}\n[entry]\ncommand = "dg-${name}"\n`;

function approve(dir: string, approved = true): void {
	const tree = hashTree(join(dir, "src"));
	const record: PluginRecord = { name: basename(dir), kind: "skill", source: "folder", pin: { kind: "sha256", value: tree }, treeSha256: tree, approvedSha256: approved ? tree : null, mac: null };
	if (approved) record.mac = macOf(record, Buffer.from(TEST_KEY_HEX, "hex"));
	writeFileSync(join(dir, "dg-plugin.json"), JSON.stringify(record));
}

function installPlugin(world: ReturnType<typeof hookWorld>, name: string, config: string, manifest = MANIFEST(name)) {
	const dir = join(world.dgHome, "data", "plugins", name);
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src", "plugin.toml"), manifest);
	approve(dir);
	mkdirSync(join(world.dgHome, "config"), { recursive: true });
	writeFileSync(join(world.dgHome, "config", "config.toml"), config);
	return dir;
}

const event = { event: "PreToolUse", tool: "Bash", input: { command: "ls" } };

describe("runExternalHook", () => {
	test("returns the decision and the latency from a running ipc plugin", async () => {
		const world = hookWorld();
		const dir = installPlugin(world, "scan", "");
		const plugin = await startPlugin(join(dir, "p.sock"), () => ({ decision: "deny", reason: "secret found" }));
		const manifest = parseManifest(MANIFEST("scan"), "plugin.toml");
		const outcome = await runExternalHook(manifest, event, { pluginDir: dir, allowRemote: false });
		expect(outcome).toMatchObject({ decision: "deny", reason: "secret found" });
		expect((outcome as { latencyMs: number }).latencyMs).toBeGreaterThanOrEqual(0);
		expect(plugin.decides).toEqual([event]);
	});

	test("returns a timeout result when the plugin stays silent", async () => {
		const world = hookWorld();
		const dir = installPlugin(world, "slow", "");
		await startPlugin(join(dir, "p.sock"), () => "silent");
		const manifest = parseManifest(MANIFEST("slow"), "plugin.toml");
		const outcome = await runExternalHook(manifest, event, { pluginDir: dir, allowRemote: false, timeoutMs: 80 });
		expect(outcome).toMatchObject({ failure: "timeout" });
		expect(outcome.latencyMs).toBeGreaterThanOrEqual(70);
		expect(outcome.latencyMs).toBeLessThan(1_000);
	});

	test("returns an unavailable result when no plugin listens, without starting one", async () => {
		const world = hookWorld();
		const dir = installPlugin(world, "gone", "");
		const manifest = parseManifest(MANIFEST("gone"), "plugin.toml");
		const outcome = await runExternalHook(manifest, event, { pluginDir: dir, allowRemote: false });
		expect(outcome).toMatchObject({ failure: "unavailable" });
	});

	test("flags a decision slower than the transport budget", async () => {
		const world = hookWorld();
		const dir = installPlugin(world, "budget", "");
		await startPlugin(join(dir, "p.sock"), () => ({ decision: "allow" }));
		const manifest = parseManifest(MANIFEST("budget"), "plugin.toml");
		const ticks = [0, 40];
		const outcome = await runExternalHook(manifest, event, { pluginDir: dir, allowRemote: false, now: () => ticks.shift() ?? 40 });
		expect(outcome).toMatchObject({ decision: "allow", latencyMs: 40, overBudget: true });
	});

	test("asks an http plugin with the stored token", async () => {
		const seen: { auth: string | null; body: unknown }[] = [];
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				seen.push({ auth: request.headers.get("authorization"), body: await request.json() });
				return Response.json({ decision: "ask", reason: "check this" });
			},
		});
		try {
			const manifest = parseManifest(`name = "web"\nversion = "1.0.0"\nkind = "hook"\ntransport = "http"\nendpoint = "http://127.0.0.1:${server.port}"\n[entry]\ncommand = "dg-web"\n`, "plugin.toml");
			const credentials = { resolveCredential: async () => ({ value: "tok", source: "store" as const }) };
			const outcome = await runExternalHook(manifest, event, { pluginDir: "/unused", allowRemote: false, credentials });
			expect(outcome).toMatchObject({ decision: "ask", reason: "check this" });
			expect(seen).toEqual([{ auth: "Bearer tok", body: event }]);
		} finally {
			await server.stop(true);
		}
	});
});

describe("hasConfiguredPlugins", () => {
	test("is false without a config file and without a plugins section", () => {
		const world = hookWorld();
		expect(hasConfiguredPlugins(world.env())).toBe(false);
		mkdirSync(join(world.dgHome, "config"), { recursive: true });
		writeFileSync(join(world.dgHome, "config", "config.toml"), "[hooks.spelling]\nlocale = \"en-US\"\n");
		expect(hasConfiguredPlugins(world.env())).toBe(false);
	});

	test("is true when config.toml has a plugins section", () => {
		const world = hookWorld();
		installPlugin(world, "scan", "[plugins.scan]\nenabled = true\n");
		expect(hasConfiguredPlugins(world.env())).toBe(true);
	});
});

describe("hooks run with an external hook plugin", () => {
	const ENABLED = "[plugins.scan]\nenabled = true\n";

	test("denies the tool call with exit 2 and the plugin reason", async () => {
		const world = hookWorld();
		const dir = installPlugin(world, "scan", ENABLED);
		await startPlugin(join(dir, "p.sock"), () => ({ decision: "deny", reason: "secret found" }));
		const result = await world.run("scan", bashInput("ls"));
		expect(result).toEqual({ code: 2, stdout: "", stderr: "secret found\n" });
	});

	test.each(["-1", "0", "abc"])("uses the default timeout when DG_HOOK_TIMEOUT_MS is %s", async (value) => {
		const world = hookWorld();
		const dir = installPlugin(world, "scan", ENABLED);
		await startPlugin(join(dir, "p.sock"), () => ({ decision: "deny", reason: "secret found" }));
		const result = await world.run("scan", bashInput("ls"), { env: { DG_HOOK_TIMEOUT_MS: value } });
		expect(result).toEqual({ code: 2, stdout: "", stderr: "secret found\n" });
	});

	test("lets the tool call go on when the plugin allows", async () => {
		const world = hookWorld();
		const dir = installPlugin(world, "scan", ENABLED);
		await startPlugin(join(dir, "p.sock"), () => ({ decision: "allow" }));
		expect(await world.run("scan", bashInput("ls"))).toEqual({ code: 0, stdout: "", stderr: "" });
	});

	test("emits an ask decision for the runtime", async () => {
		const world = hookWorld();
		const dir = installPlugin(world, "scan", ENABLED);
		await startPlugin(join(dir, "p.sock"), () => ({ decision: "ask", reason: "sure?" }));
		const result = await world.run("scan", bashInput("ls"));
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: "ask", permissionDecisionReason: "sure?" });
	});

	test("prints one line and lets the tool call go on when the plugin times out", async () => {
		const world = hookWorld();
		const dir = installPlugin(world, "scan", ENABLED);
		await startPlugin(join(dir, "p.sock"), () => "silent");
		const result = await world.run("scan", bashInput("ls"), { env: { DG_HOOK_TIMEOUT_MS: "80" } });
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
		expect(result.stderr).toContain("scan");
		expect(result.stderr).toContain("80 ms");
	});

	test("prints one line and lets the tool call go on when the plugin is not running", async () => {
		const world = hookWorld();
		installPlugin(world, "scan", ENABLED);
		const result = await world.run("scan", bashInput("ls"));
		expect(result.code).toBe(0);
		expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
		expect(result.stderr).toContain("scan");
	});

	describe("with fail_closed = true", () => {
		const CLOSED = "[plugins.scan]\nenabled = true\nfail_closed = true\n";

		test("blocks the tool call and names the plugin and the option when the plugin times out", async () => {
			const world = hookWorld();
			const dir = installPlugin(world, "scan", CLOSED);
			await startPlugin(join(dir, "p.sock"), () => "silent");
			const result = await world.run("scan", bashInput("ls"), { env: { DG_HOOK_TIMEOUT_MS: "80" } });
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("plugin scan");
			expect(result.stderr).toContain("80 ms");
			expect(result.stderr).toContain("plugins.scan.fail_closed");
			expect(result.stderr).toContain("blocked");
		});

		test("blocks the tool call when the plugin is not running", async () => {
			const world = hookWorld();
			installPlugin(world, "scan", CLOSED);
			const result = await world.run("scan", bashInput("ls"));
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("plugin scan is unavailable");
			expect(result.stderr).toContain("plugins.scan.fail_closed");
		});

		test("still lets the tool call go on when the plugin allows", async () => {
			const world = hookWorld();
			const dir = installPlugin(world, "scan", CLOSED);
			await startPlugin(join(dir, "p.sock"), () => ({ decision: "allow" }));
			expect(await world.run("scan", bashInput("ls"))).toEqual({ code: 0, stdout: "", stderr: "" });
		});
	});

	test("never connects to a disabled plugin", async () => {
		const world = hookWorld();
		const dir = installPlugin(world, "scan", "[plugins.scan]\nenabled = false\n");
		const plugin = await startPlugin(join(dir, "p.sock"), () => ({ decision: "deny" }));
		const result = await world.run("scan", bashInput("ls"));
		expect(plugin.connections()).toBe(0);
		expect(result).toEqual({ code: 1, stdout: "", stderr: "hooks run: unknown hook 'scan'\n" });
	});

	test("never connects to a plugin with no plugins section", async () => {
		const world = hookWorld();
		const dir = installPlugin(world, "scan", "[plugins.other]\nenabled = true\n");
		const plugin = await startPlugin(join(dir, "p.sock"), () => ({ decision: "deny" }));
		const result = await world.run("scan", bashInput("ls"));
		expect(plugin.connections()).toBe(0);
		expect(result.code).toBe(1);
	});

	test("never connects to a remote plugin without allow_remote", async () => {
		const world = hookWorld();
		const manifest = `name = "scan"\nversion = "1.0.0"\nkind = "hook"\ntransport = "http"\nremote = true\nendpoint = "https://hooks.example.com"\n[entry]\ncommand = "dg-scan"\n`;
		installPlugin(world, "scan", ENABLED, manifest);
		const result = await world.run("scan", bashInput("ls"));
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("allow_remote");
	});

	test("exits on its own after the decision, with no warm connection left open", async () => {
		const world = hookWorld();
		const dir = installPlugin(world, "scan", ENABLED);
		await startPlugin(join(dir, "p.sock"), () => ({ decision: "allow" }));
		const cli = join(import.meta.dir, "..", "src", "hooks", "cli.ts");
		const support = join(import.meta.dir, "support", "approval-keys.ts");
		const driver = `const { fakeKeys, useApprovalKeys } = await import(${JSON.stringify(support)}); useApprovalKeys(fakeKeys());
const { main } = await import(${JSON.stringify(cli)}); process.exitCode = await main(["run", "scan"]);`;
		const proc = Bun.spawn([process.execPath, "-e", driver], {
			env: { ...process.env, ...world.env() },
			stdin: new Blob([JSON.stringify(bashInput("ls"))]),
			stdout: "pipe",
			stderr: "pipe",
		});
		const timer = setTimeout(() => proc.kill(), 5_000);
		const code = await proc.exited;
		clearTimeout(timer);
		expect(code).toBe(0);
	});

	test("keeps built-in hooks in process and unchanged with plugins configured", async () => {
		const world = hookWorld();
		installPlugin(world, "scan", ENABLED);
		const result = await world.run("pr-confirm", bashInput("gh pr create --title x"));
		expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
	});
});

describe("resolveExternalHook", () => {
	test("loads the manifest from the approved src tree", async () => {
		const world = hookWorld();
		const dir = installPlugin(world, "scan", "[plugins.scan]\nenabled = true\n");
		const plugin = await resolveExternalHook("scan", world.env());
		expect(plugin?.manifest.name).toBe("scan");
		expect(plugin?.pluginDir).toBe(dir);
	});

	test("carries fail_closed from config.toml, false by default", async () => {
		const world = hookWorld();
		installPlugin(world, "scan", "[plugins.scan]\nenabled = true\n");
		expect((await resolveExternalHook("scan", world.env()))?.failClosed).toBe(false);
		installPlugin(world, "scan", "[plugins.scan]\nenabled = true\nfail_closed = true\n");
		expect((await resolveExternalHook("scan", world.env()))?.failClosed).toBe(true);
	});

	test("refuses a plugin with no approval record", async () => {
		const world = hookWorld();
		const dir = installPlugin(world, "scan", "[plugins.scan]\nenabled = true\n");
		rmSync(join(dir, "dg-plugin.json"));
		await expect(resolveExternalHook("scan", world.env())).rejects.toThrow(/not approved/);
	});

	test("refuses a plugin whose record was never approved", async () => {
		const world = hookWorld();
		const dir = installPlugin(world, "scan", "[plugins.scan]\nenabled = true\n");
		approve(dir, false);
		await expect(resolveExternalHook("scan", world.env())).rejects.toThrow(/not approved/);
	});

	test("refuses a record that the plugin store would reject", async () => {
		const world = hookWorld();
		const dir = installPlugin(world, "scan", "[plugins.scan]\nenabled = true\n");
		const tree = hashTree(join(dir, "src"));
		writeFileSync(join(dir, "dg-plugin.json"), JSON.stringify({ treeSha256: tree, approvedSha256: tree }));
		await expect(resolveExternalHook("scan", world.env())).rejects.toThrow(/not approved.*must hold exactly the keys/);
	});

	test("refuses an unsigned or badly signed approval and says to re-approve", async () => {
		const world = hookWorld();
		const dir = installPlugin(world, "scan", "[plugins.scan]\nenabled = true\n");
		const record = JSON.parse(readFileSync(join(dir, "dg-plugin.json"), "utf8"));
		writeFileSync(join(dir, "dg-plugin.json"), JSON.stringify({ ...record, mac: null }));
		await expect(resolveExternalHook("scan", world.env())).rejects.toThrow(/not approved.*re-approve with dg plugin verify scan --approve/);
		writeFileSync(join(dir, "dg-plugin.json"), JSON.stringify({ ...record, mac: "0".repeat(64) }));
		await expect(resolveExternalHook("scan", world.env())).rejects.toThrow(/not approved.*re-approve with dg plugin verify scan --approve/);
	});

	test("refuses every plugin when the daemon is down and says to start it", async () => {
		const world = hookWorld();
		installPlugin(world, "scan", "[plugins.scan]\nenabled = true\n");
		useApprovalKeys(downKeys());
		await expect(resolveExternalHook("scan", world.env())).rejects.toThrow(/not approved.*dg agent start/);
	});

	test("a stopped daemon with fail_closed unset ends the run with a non-blocking exit and says to start the daemon", async () => {
		const world = hookWorld();
		installPlugin(world, "scan", "[plugins.scan]\nenabled = true\n");
		useApprovalKeys(downKeys());
		const result = await world.run("scan", bashInput("ls"));
		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(/not approved.*dg agent start/);
	});

	test("a stopped daemon with fail_closed true still ends the run with a non-blocking exit", async () => {
		const world = hookWorld();
		installPlugin(world, "scan", "[plugins.scan]\nenabled = true\nfail_closed = true\n");
		useApprovalKeys(downKeys());
		const result = await world.run("scan", bashInput("ls"));
		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(/not approved.*dg agent start/);
	});

	test("refuses a plugin whose src changed after approval", async () => {
		const world = hookWorld();
		const dir = installPlugin(world, "scan", "[plugins.scan]\nenabled = true\n");
		writeFileSync(join(dir, "src", "extra.txt"), "x");
		await expect(resolveExternalHook("scan", world.env())).rejects.toThrow(/not approved/);
	});

	test("ignores a plugin.toml outside src", async () => {
		const world = hookWorld();
		const dir = installPlugin(world, "scan", "[plugins.scan]\nenabled = true\n");
		rmSync(join(dir, "src", "plugin.toml"));
		writeFileSync(join(dir, "plugin.toml"), MANIFEST("scan"));
		await expect(resolveExternalHook("scan", world.env())).rejects.toThrow(/no src\/plugin.toml/);
	});
});
