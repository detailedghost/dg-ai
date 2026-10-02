import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	CHAT_PAIR_PATH,
	validatePairResponse,
} from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { writeConfig } from "../../src/server/config-store";
import {
	allocatePort,
	BROWSER_ORIGIN,
	cleanupDgHome,
	createCleanupSlot,
	EXTENSION_ORIGIN,
	freshDgHome,
	runDaemonCommand,
	spawnServe,
	stopServe,
	waitForHealth,
} from "../utils/daemon-harness";

const cleanupSlot = createCleanupSlot();

afterEach(() => cleanupSlot.run());

function extractCode(stdout: string): string {
	const match = stdout.match(/Pairing code: (\d{6})/);
	if (!match) throw new Error(`pairing code missing from output: ${stdout}`);
	return match[1];
}

async function bootPairedServer() {
	const dgHome = freshDgHome();
	const command = await runDaemonCommand(dgHome, "pair");
	const code = extractCode(command.stdout);
	const port = allocatePort();
	const proc = spawnServe(dgHome, port);
	await waitForHealth(port);
	cleanupSlot.set(async () => {
		await stopServe(proc);
		cleanupDgHome(dgHome);
	});
	return {
		code,
		dgHome,
		port,
		paths: resolveDgPaths({ env: { DG_HOME: dgHome } }),
	};
}

function wrongCode(code: string): string {
	const lastDigit = (Number(code.at(-1)) + 1) % 10;
	return `${code.slice(0, -1)}${lastDigit}`;
}

function pairRequest(
	port: number,
	code: string,
	origin: string | null = EXTENSION_ORIGIN,
): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${CHAT_PAIR_PATH}`, {
		method: "POST",
		headers: {
			Host: `127.0.0.1:${port}`,
			"Content-Type": "application/json",
			...(origin === null ? {} : { Origin: origin }),
		},
		body: JSON.stringify({ code }),
	});
}

describe("POST /pair", () => {
	it("returns a paired extension bootstrap and consumes the record", async () => {
		const { code, paths, port } = await bootPairedServer();

		const response = await pairRequest(port, code);
		const bootstrap = validatePairResponse(await response.json());

		expect(response.status).toBe(200);
		expect(bootstrap.port).toBe(port);
		expect(bootstrap.agentIdentity).toBe("extension");
		expect(existsSync(paths.pairingPath)).toBe(false);

		const reused = await pairRequest(port, code);
		expect(reused.status).toBe(404);
	});

	it("refuses a missing Origin without consuming the record", async () => {
		const { code, paths, port } = await bootPairedServer();

		const response = await pairRequest(port, code, null);

		expect(response.status).toBe(400);
		expect(await response.text()).toContain("extension-scheme Origin");
		expect(existsSync(paths.pairingPath)).toBe(true);
	});

	it("decrements attempts after a wrong code", async () => {
		const { code, paths, port } = await bootPairedServer();

		const response = await pairRequest(port, wrongCode(code), EXTENSION_ORIGIN);
		const record = JSON.parse(readFileSync(paths.pairingPath, "utf8"));

		expect(response.status).toBe(401);
		expect(record.attemptsLeft).toBe(4);
		expect(await response.text()).toContain("4 attempts left");
	});

	it("deletes the record after five wrong attempts and refuses a sixth", async () => {
		const { code, paths, port } = await bootPairedServer();
		const wrong = wrongCode(code);

		for (let attempt = 0; attempt < 5; attempt++) {
			expect((await pairRequest(port, wrong)).status).toBe(401);
		}

		expect(existsSync(paths.pairingPath)).toBe(false);
		expect((await pairRequest(port, wrong)).status).toBe(404);
	});

	it("returns 410 for an expired code and deletes the record", async () => {
		const { code, paths, port } = await bootPairedServer();
		const record = JSON.parse(readFileSync(paths.pairingPath, "utf8"));
		writeFileSync(
			paths.pairingPath,
			JSON.stringify({ ...record, expiresAt: Date.now() - 1 }),
		);

		const response = await pairRequest(port, code);

		expect(response.status).toBe(410);
		expect(existsSync(paths.pairingPath)).toBe(false);
	});

	it("refuses a browser Origin without consuming an attempt", async () => {
		const { code, paths, port } = await bootPairedServer();

		const response = await pairRequest(port, code, BROWSER_ORIGIN);
		const record = JSON.parse(readFileSync(paths.pairingPath, "utf8"));

		expect(response.status).toBe(400);
		expect(record.attemptsLeft).toBe(5);
	});

	it("returns 409 when a different extension Origin is already pinned", async () => {
		const { code, paths, port } = await bootPairedServer();
		writeConfig(paths, { pinnedOrigin: EXTENSION_ORIGIN });

		const response = await pairRequest(
			port,
			code,
			"chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		);

		expect(response.status).toBe(409);
		expect(await response.text()).toContain("dg-daemon origin clear");
		expect(existsSync(paths.pairingPath)).toBe(true);
	});

	it("allows only one of two concurrent requests to consume the code", async () => {
		const { code, paths, port } = await bootPairedServer();

		const responses = await Promise.all([
			pairRequest(port, code),
			pairRequest(port, code),
		]);

		expect(responses.map(({ status }) => status).sort()).toEqual([200, 404]);
		expect(existsSync(paths.pairingPath)).toBe(false);
	});
});
