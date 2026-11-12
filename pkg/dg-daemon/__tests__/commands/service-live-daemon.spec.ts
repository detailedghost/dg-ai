import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { CHAT_SERVICES_PATH } from "@dg/common";
import {
	bootServe,
	cleanupDgHome,
	createCleanupSlot,
	ownerTokenHeader,
	stopServe,
	waitForPidFile,
} from "../utils/daemon-harness";
import { configPathOf, writeConfigFile } from "../utils/service-daemon";
import { lines, runCli } from "./service-cli-helpers";

const cleanupSlot = createCleanupSlot();
afterEach(() => cleanupSlot.run());

const sleeper = (cwd: string) => ({
	argv: [process.execPath, "-e", "setTimeout(() => {}, 600000)"],
	cwd,
});

async function boot(services: (dgHome: string) => Record<string, unknown>) {
	const { dgHome, port, proc } = await bootServe();
	cleanupSlot.set(async () => {
		await stopServe(proc);
		cleanupDgHome(dgHome);
	});
	await waitForPidFile(dgHome);
	writeConfigFile(dgHome, { pinnedOrigin: "p", services: services(dgHome) });
	return { dgHome, port };
}

const post = (port: number, path: string) =>
	fetch(`http://127.0.0.1:${port}${CHAT_SERVICES_PATH}/${path}`, {
		method: "POST",
		headers: { Host: `127.0.0.1:${port}`, ...ownerTokenHeader(port) },
	});

describe("service commands against a live daemon", () => {
	it("service rm refuses a running service and keeps the entry", async () => {
		const { dgHome, port } = await boot((home) => ({ bot: sleeper(home) }));
		expect((await post(port, "bot/start")).ok).toBe(true);
		const before = readFileSync(configPathOf(dgHome), "utf8");
		const result = await runCli(dgHome, ["service", "rm", "bot"], { port });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			'service "bot" is running — stop it first with dg-daemon service stop bot',
		);
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(before);
		await post(port, "bot/stop");
	});

	it("service rm refuses a service in backoff and keeps the entry", async () => {
		const { dgHome, port } = await boot((home) => ({
			bot: { argv: [process.execPath, "-e", "process.exit(1)"], cwd: home },
		}));
		expect((await post(port, "bot/start")).ok).toBe(true);
		const before = readFileSync(configPathOf(dgHome), "utf8");
		let result = await runCli(dgHome, ["service", "rm", "bot"], { port });
		for (let i = 0; i < 40 && !result.stderr.includes("is backoff"); i++) {
			await Bun.sleep(100);
			result = await runCli(dgHome, ["service", "rm", "bot"], { port });
		}
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			'service "bot" is backoff — stop it first with dg-daemon service stop bot',
		);
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(before);
		await post(port, "bot/stop");
	});

	it("service rm removes a stopped service", async () => {
		const { dgHome, port } = await boot((home) => ({ bot: sleeper(home) }));
		const result = await runCli(dgHome, ["service", "rm", "bot"], { port });
		expect(result.code).toBe(0);
		expect(JSON.parse(readFileSync(configPathOf(dgHome), "utf8"))).toEqual({
			pinnedOrigin: "p",
			services: {},
		});
	});

	it("service status no longer lists a service that ran, was stopped and was removed", async () => {
		const { dgHome, port } = await boot((home) => ({
			bot: sleeper(home),
			keep: sleeper(home),
		}));
		expect((await post(port, "bot/start")).ok).toBe(true);
		expect((await post(port, "bot/stop")).ok).toBe(true);
		expect(
			(await runCli(dgHome, ["service", "rm", "bot"], { port })).code,
		).toBe(0);

		const json = await runCli(dgHome, ["service", "status", "--json"], {
			port,
		});
		const text = await runCli(dgHome, ["service", "status"], { port });

		expect(
			JSON.parse(json.stdout).services.map((s: { label: string }) => s.label),
		).toEqual(["keep"]);
		expect(text.stdout).not.toContain("bot");
	});

	it("service add prints the live-daemon next line", async () => {
		const { dgHome, port } = await boot(() => ({}));
		const result = await runCli(
			dgHome,
			["service", "add", "bot", "--cwd", dgHome, "--", "bun", "x.ts"],
			{ port },
		);
		expect(lines(result.stdout)).toEqual([
			'added service "bot"',
			"next: dg-daemon service start bot",
		]);
	});

	it("service status --json prints one line holding every entry, or one by label", async () => {
		const { dgHome, port } = await boot((home) => ({
			alpha: sleeper(home),
			beta: sleeper(home),
		}));
		const all = await runCli(dgHome, ["service", "status", "--json"], { port });
		expect(all.code).toBe(0);
		expect(lines(all.stdout)).toHaveLength(1);
		const parsed = JSON.parse(all.stdout);
		expect(
			parsed.services.map((s: { label: string }) => s.label).sort(),
		).toEqual(["alpha", "beta"]);

		const one = await runCli(dgHome, ["service", "status", "alpha", "--json"], {
			port,
		});
		expect(
			JSON.parse(one.stdout).services.map((s: { label: string }) => s.label),
		).toEqual(["alpha"]);

		const unknown = await runCli(
			dgHome,
			["service", "status", "ghost", "--json"],
			{ port },
		);
		expect(unknown.code).toBe(1);
		expect(unknown.stdout).toBe("");
		expect(unknown.stderr).toContain('no service labelled "ghost"');
	});

	it('service status --json prints {"services":[]} with nothing declared, while plain status exits 1', async () => {
		const { dgHome, port } = await boot(() => ({}));
		const json = await runCli(dgHome, ["service", "status", "--json"], {
			port,
		});
		expect(json.code).toBe(0);
		expect(json.stdout.trim()).toBe('{"services":[]}');
		const plain = await runCli(dgHome, ["service", "status"], { port });
		expect(plain.code).toBe(1);
		expect(plain.stderr).toContain("no services declared");
	});

	it("service status without --json prints one text line per service", async () => {
		const { dgHome, port } = await boot((home) => ({ alpha: sleeper(home) }));
		const result = await runCli(dgHome, ["service", "status"], { port });
		expect(result.code).toBe(0);
		const [line] = lines(result.stdout);
		expect(line).toStartWith("alpha");
		expect(line).toContain("restarts 0");
	});

	it("a declaration with passEnv, stopTimeoutMs and grant is not invalid", async () => {
		const { dgHome, port } = await boot((home) => ({
			bot: {
				...sleeper(home),
				passEnv: ["A"],
				stopTimeoutMs: 1000,
				grant: "bot",
			},
		}));
		const result = await runCli(dgHome, ["service", "status", "--json"], {
			port,
		});
		const [entry] = JSON.parse(result.stdout).services;
		expect(entry.state).not.toBe("invalid");
	});
});
