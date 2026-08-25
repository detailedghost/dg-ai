import { afterEach, describe, expect, it } from "bun:test";
import {
	CHAT_ASSETS_PATH,
	CHAT_CLI_PATH,
	CHAT_START_PATH,
	CHAT_STATUS_PATH,
	CHAT_WS_PATH,
} from "@dg/common";
import {
	bootServe as bootDaemonServe,
	cleanupDgHome,
	createCleanupSlot,
	stopServe,
} from "../utils/daemon-harness";

const cleanupSlot = createCleanupSlot();

afterEach(() => cleanupSlot.run());

async function bootServe(): Promise<number> {
	const { dgHome, port, proc } = await bootDaemonServe();
	cleanupSlot.set(async () => {
		await stopServe(proc);
		cleanupDgHome(dgHome);
	});
	return port;
}

function loopbackHeaders(port: number): Record<string, string> {
	return { Host: `127.0.0.1:${port}` };
}

function upgradeHeaders(port: number): Record<string, string> {
	return {
		...loopbackHeaders(port),
		Connection: "Upgrade",
		Upgrade: "websocket",
		"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
		"Sec-WebSocket-Version": "13",
	};
}

describe("the shared CHAT_*_PATH constants wire to the real route table", () => {
	it("answers GET CHAT_STATUS_PATH rather than a 404 route miss", async () => {
		const port = await bootServe();
		const resp = await fetch(`http://127.0.0.1:${port}${CHAT_STATUS_PATH}`, {
			headers: loopbackHeaders(port),
		});
		expect(resp.status).not.toBe(404);
	});

	it("answers GET CHAT_START_PATH with the bootstrap page rather than a 404 route miss", async () => {
		const port = await bootServe();
		const resp = await fetch(`http://127.0.0.1:${port}${CHAT_START_PATH}`, {
			headers: loopbackHeaders(port),
		});
		expect(resp.status).not.toBe(404);
		expect(await resp.text()).toContain("Starting chat session");
	});

	it("answers POST CHAT_ASSETS_PATH rather than a 404 route miss", async () => {
		const port = await bootServe();
		const resp = await fetch(`http://127.0.0.1:${port}${CHAT_ASSETS_PATH}`, {
			method: "POST",
			headers: loopbackHeaders(port),
		});
		expect(resp.status).not.toBe(404);
	});

	it("answers a GET under the CHAT_ASSETS_PATH prefix rather than a 404 route miss", async () => {
		const port = await bootServe();
		const resp = await fetch(
			`http://127.0.0.1:${port}${CHAT_ASSETS_PATH}/whatever-id`,
			{ headers: loopbackHeaders(port) },
		);
		expect(resp.status).not.toBe(404);
	});

	it("routes CHAT_WS_PATH and CHAT_CLI_PATH to the upgrade handlers rather than a 404 route miss", async () => {
		const port = await bootServe();
		const wsResp = await fetch(`http://127.0.0.1:${port}${CHAT_WS_PATH}`, {
			headers: upgradeHeaders(port),
		});
		expect(wsResp.status).not.toBe(404);

		const cliResp = await fetch(`http://127.0.0.1:${port}${CHAT_CLI_PATH}`, {
			headers: upgradeHeaders(port),
		});
		expect(cliResp.status).not.toBe(404);
	});
});

describe("requireSessionCredentials carries NOSNIFF on every 401 it produces", () => {
	it("carries X-Content-Type-Options: nosniff on the /cli upgrade's missing-credentials 401", async () => {
		const port = await bootServe();
		const resp = await fetch(`http://127.0.0.1:${port}${CHAT_CLI_PATH}`, {
			headers: loopbackHeaders(port),
		});
		expect(resp.status).toBe(401);
		expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
	});

	it("carries X-Content-Type-Options: nosniff on the /assets POST's missing-credentials 401", async () => {
		const port = await bootServe();
		const resp = await fetch(`http://127.0.0.1:${port}${CHAT_ASSETS_PATH}`, {
			method: "POST",
			headers: loopbackHeaders(port),
		});
		expect(resp.status).toBe(401);
		expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
	});
});
