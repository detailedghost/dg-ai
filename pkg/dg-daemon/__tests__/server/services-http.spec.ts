import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT_SERVICES_PATH, OWNER_TOKEN_HEADER } from "@dg/common";
import { readOwnerToken, resolveDgPaths } from "@dg/common/node";
import {
	bootServe,
	cleanupDgHome,
	createCleanupSlot,
	ENTRY,
	registerSession,
	stopServe,
	subprocessEnv,
} from "../utils/daemon-harness";

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

const cleanupSlot = createCleanupSlot();

afterEach(() => cleanupSlot.run());

async function boot(declare: (dgHome: string) => unknown = () => ({})) {
	const { dgHome, port, proc } = await bootServe();
	cleanupSlot.set(async () => {
		await fetchService(port, "bot/stop", "POST", EXTENSION_ORIGIN);
		await stopServe(proc);
		cleanupDgHome(dgHome);
	});
	const { daemonConfigPath: configPath } = resolveDgPaths({ env: { DG_HOME: dgHome } });
	mkdirSync(join(configPath, ".."), { recursive: true });
	writeFileSync(configPath, JSON.stringify({ services: declare(dgHome) }));
	return { dgHome, port };
}

function fetchService(
	port: number,
	path: string,
	method: "GET" | "POST",
	origin?: string,
	extraHeaders: Record<string, string> = {},
): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${CHAT_SERVICES_PATH}/${path}`, {
		method,
		headers: {
			Host: `127.0.0.1:${port}`,
			...(origin ? { Origin: origin } : {}),
			...extraHeaders,
		},
	});
}

function ownerHeaders(dgHome: string): Record<string, string> {
	const owner = readOwnerToken(resolveDgPaths({ env: { DG_HOME: dgHome } }));
	if (owner === undefined) throw new Error("the daemon wrote no owner token");
	return { [OWNER_TOKEN_HEADER]: owner };
}

async function serviceState(port: number): Promise<string> {
	const resp = await fetchService(port, "", "GET", EXTENSION_ORIGIN);
	return (await resp.json()).services[0].state;
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
		const resp = await fetchService(
			port,
			"made-up/start",
			"POST",
			EXTENSION_ORIGIN,
		);
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
		expect(await serviceState(port)).toBe("stopped");
	});

	it("answers 400 for a malformed percent-encoded label", async () => {
		const { port } = await boot(botDecl);
		const resp = await fetchService(
			port,
			"%E0%A4%A/start",
			"POST",
			EXTENSION_ORIGIN,
		);
		expect(resp.status).toBe(400);
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

describe("a /services request with no Origin", () => {
	it("refuses a list with no credential", async () => {
		const { port } = await boot(botDecl);
		const resp = await fetchService(port, "", "GET");
		expect(resp.status).toBe(403);
		expect(await resp.text()).not.toContain("bot");
	});

	it("refuses a start with no credential and starts nothing", async () => {
		const { port } = await boot(botDecl);
		const resp = await fetchService(port, "bot/start", "POST");
		expect(resp.status).toBe(403);
		expect(await serviceState(port)).toBe("stopped");
	});

	it("refuses a stop with no credential and leaves the service running", async () => {
		const { port } = await boot(botDecl);
		await fetchService(port, "bot/start", "POST", EXTENSION_ORIGIN);
		const resp = await fetchService(port, "bot/stop", "POST");
		expect(resp.status).toBe(403);
		expect(await serviceState(port)).toBe("running");
	});

	it("refuses a wrong owner token", async () => {
		const { port } = await boot(botDecl);
		const resp = await fetchService(port, "bot/start", "POST", undefined, {
			[OWNER_TOKEN_HEADER]: "not-the-owner-token",
		});
		expect(resp.status).toBe(403);
		expect(await serviceState(port)).toBe("stopped");
	});

	it("refuses a live session token, which is not the owner credential", async () => {
		const { port } = await boot(botDecl);
		const session = await registerSession(port);
		const resp = await fetchService(port, "bot/start", "POST", undefined, {
			Authorization: `Bearer ${session.token}`,
		});
		expect(resp.status).toBe(403);
		expect(await serviceState(port)).toBe("stopped");
	});

	it("serves the owner token, which is what the service CLI sends", async () => {
		const { dgHome, port } = await boot(botDecl);
		const owner = ownerHeaders(dgHome);
		const listed = await fetchService(port, "", "GET", undefined, owner);
		expect(listed.status).toBe(200);
		const started = await fetchService(
			port,
			"bot/start",
			"POST",
			undefined,
			owner,
		);
		expect(started.status).toBe(200);
		expect(await serviceState(port)).toBe("running");
	});
});
