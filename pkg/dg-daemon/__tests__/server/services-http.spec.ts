import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT_SERVICES_PATH } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import {
	bootServe,
	cleanupDgHome,
	createCleanupSlot,
	ENTRY,
	stopServe,
	subprocessEnv,
} from "../utils/daemon-harness";

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

const cleanupSlot = createCleanupSlot();

afterEach(() => cleanupSlot.run());

async function boot(declare: (dgHome: string) => unknown = () => ({})) {
	const { dgHome, port, proc } = await bootServe();
	cleanupSlot.set(async () => {
		await fetchService(port, "bot/stop", "POST");
		await stopServe(proc);
		cleanupDgHome(dgHome);
	});
	const { configPath } = resolveDgPaths({ env: { DG_HOME: dgHome } });
	mkdirSync(join(configPath, ".."), { recursive: true });
	writeFileSync(configPath, JSON.stringify({ services: declare(dgHome) }));
	return { dgHome, port };
}

function fetchService(
	port: number,
	path: string,
	method: "GET" | "POST",
	origin?: string,
): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${CHAT_SERVICES_PATH}/${path}`, {
		method,
		headers: {
			Host: `127.0.0.1:${port}`,
			...(origin ? { Origin: origin } : {}),
		},
	});
}

const botDecl = (cwd: string) => ({
	bot: {
		argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
		cwd,
	},
});

describe("GET/POST /services", () => {
	it("lists, starts and stops a declared service for the extension", async () => {
		const { dgHome, port } = await boot(botDecl);

		const listed = await fetchService(port, "", "GET", EXTENSION_ORIGIN);
		expect((await listed.json()).services[0]).toMatchObject({
			label: "bot",
			state: "stopped",
		});

		const started = await fetchService(
			port,
			"bot/start",
			"POST",
			EXTENSION_ORIGIN,
		);
		expect(started.status).toBe(200);
		expect(await started.json()).toMatchObject({ state: "running" });

		const again = await fetchService(
			port,
			"bot/start",
			"POST",
			EXTENSION_ORIGIN,
		);
		expect(again.status).toBe(409);

		const stopped = await fetchService(
			port,
			"bot/stop",
			"POST",
			EXTENSION_ORIGIN,
		);
		expect(await stopped.json()).toMatchObject({ state: "stopped" });
	});

	it("answers 404 for a label the config does not declare", async () => {
		const { port } = await boot();
		const resp = await fetchService(port, "made-up/start", "POST");
		expect(resp.status).toBe(404);
	});

	it("refuses a browser page origin", async () => {
		const { dgHome, port } = await boot(botDecl);
		const resp = await fetchService(
			port,
			"bot/start",
			"POST",
			"https://evil.example",
		);
		expect(resp.status).toBe(400);
		const status = await fetchService(port, "", "GET");
		expect((await status.json()).services[0].state).toBe("stopped");
	});

	it("refuses a request whose Host is not the loopback authority", async () => {
		const { port } = await boot(botDecl);
		const resp = await fetch(`http://127.0.0.1:${port}${CHAT_SERVICES_PATH}`, {
			headers: { Host: "evil.example" },
		});
		expect(resp.status).toBe(400);
	});

	it("drives the same routes from the service CLI", async () => {
		const { dgHome } = await boot(botDecl);
		const run = async (...args: string[]) => {
			const proc = Bun.spawn([process.execPath, ENTRY, "service", ...args], {
				env: subprocessEnv(dgHome, 0),
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				proc.exited,
			]);
			return { stdout, exitCode };
		};

		expect((await run("start", "bot")).stdout).toContain("bot  running");
		expect((await run("status")).stdout).toContain("bot  running");
		expect((await run("stop", "bot")).stdout).toContain("bot  stopped");
		expect((await run("start", "nope")).exitCode).not.toBe(0);
	});
});
