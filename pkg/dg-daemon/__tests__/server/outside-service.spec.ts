import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT_SERVICES_PATH } from "@dg/common";
import { credentialGrantTokenPath, resolveDgPaths } from "@dg/common/node";
import {
	cleanupDgHome,
	closeSockets,
	collectFrames,
	connectCli,
	credentialRequest,
	credentialResult,
	killDaemonByPidFile,
	ownerTokenHeader,
	readDaemonLog,
	removeScratchDirs,
	startWithSession,
	waitForValue,
} from "../utils/daemon-harness";
import {
	bootWithServices,
	type ServiceDaemon,
	writeServiceConfig,
} from "../utils/service-daemon";

const FIXTURE = join(import.meta.dir, "../fixtures/outside-service.ts");
const VALUE = "outside-fixture-value-8d3f61a0";
const sockets: WebSocket[] = [];
let dgHome: string | undefined;
let booted: ServiceDaemon | undefined;

afterEach(async () => {
	closeSockets(sockets);
	if (dgHome) {
		killDaemonByPidFile(dgHome);
		cleanupDgHome(dgHome);
	}
	await booted?.dispose();
	booted = undefined;
	dgHome = undefined;
	removeScratchDirs();
});

async function bootWithCredentials(minted: boolean) {
	const started = await startWithSession();
	dgHome = started.dgHome;
	const cli = await connectCli(started.port, started.bootstrap);
	sockets.push(cli);
	const frames = collectFrames(cli);
	const call = (fields: Record<string, unknown>) =>
		credentialResult(frames, credentialRequest(cli, fields));
	await call({ operation: "set", name: "bot/token-x", value: VALUE, meta: {} });
	await call({
		operation: "set",
		name: "other/token-y",
		value: "other-value",
		meta: {},
	});
	if (minted) await call({ operation: "grant", prefix: "bot" });
	const paths = resolveDgPaths({ env: { DG_HOME: started.dgHome } });
	writeServiceConfig(started.dgHome, {
		bot: {
			argv: [process.execPath, FIXTURE],
			cwd: started.dgHome,
			grant: "bot",
		},
	});
	return { ...started, call, paths };
}

function serviceAction(port: number, verb: "start" | "stop") {
	return fetch(`http://127.0.0.1:${port}${CHAT_SERVICES_PATH}/bot/${verb}`, {
		method: "POST",
		headers: { Host: `127.0.0.1:${port}`, ...ownerTokenHeader(port) },
	});
}

async function serviceStatus(port: number) {
	const response = await fetch(
		`http://127.0.0.1:${port}${CHAT_SERVICES_PATH}`,
		{
			headers: { Host: `127.0.0.1:${port}`, ...ownerTokenHeader(port) },
		},
	);
	return (await response.json()).services[0] as {
		state: string;
		restarts: number;
	};
}

async function stoppedStatus(port: number) {
	const deadline = Date.now() + 5000;
	for (;;) {
		const current = await serviceStatus(port);
		if (current.state === "stopped" || Date.now() > deadline) return current;
		await new Promise((r) => setTimeout(r, 50));
	}
}

describe("a service that imports no dg code", () => {
	it("lists and gets a credential below its prefix through DG_DAEMON_URL and exits cleanly", async () => {
		const { port, paths, dgHome: home } = await bootWithCredentials(true);
		const started = await serviceAction(port, "start");
		expect(started.status).toBe(200);
		const logFile = join(paths.logDir, "service-bot.log");
		const line = await waitForValue(
			() => {
				if (!existsSync(logFile)) return undefined;
				const text = readFileSync(logFile, "utf8");
				return text.includes("\n") ? text : undefined;
			},
			10_000,
			"the fixture JSON line",
		);
		const lines = line.trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toMatchObject({
			names: ["bot/token-x"],
			sha256: createHash("sha256").update(VALUE).digest("hex"),
		});

		const settled = await stoppedStatus(port);
		expect(settled).toMatchObject({ state: "stopped", restarts: 0 });
		expect(readFileSync(logFile, "utf8").trim().split("\n")).toHaveLength(1);

		const token = readFileSync(
			credentialGrantTokenPath(paths, "bot"),
			"utf8",
		).trim();
		const serviceLog = readFileSync(logFile, "utf8");
		const daemonLog = readDaemonLog(home);
		for (const secret of [token, VALUE]) {
			expect(serviceLog).not.toContain(secret);
			expect(daemonLog).not.toContain(secret);
		}
	}, 30_000);
});

describe("a declared grant with no token file", () => {
	it("fails the start over HTTP with the path and the mint command, and starts nothing", async () => {
		const { port, paths } = await bootWithCredentials(false);
		const response = await serviceAction(port, "start");
		expect(response.status).toBe(400);
		expect(await response.text()).toBe(
			`grant token file not found: ${credentialGrantTokenPath(paths, "bot")} — create it with dg-skills credentials grant bot`,
		);
		expect((await serviceStatus(port)).state).toBe("stopped");
		expect(existsSync(join(paths.logDir, "service-bot.log"))).toBe(false);
	});

	it("fails the next start after revoke", async () => {
		const { port, call } = await bootWithCredentials(true);
		await call({ operation: "revoke", prefix: "bot" });
		const response = await serviceAction(port, "start");
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("grant token file not found:");
	});

	it("does not autostart the service and logs the preflight text", async () => {
		booted = await bootWithServices((home) => ({
			bot: {
				argv: [process.execPath, FIXTURE],
				cwd: home,
				grant: "bot",
				autostart: true,
			},
		}));
		const { dgHome: home, paths } = booted;
		const log = await waitForValue(
			() => {
				const text = readDaemonLog(home);
				return text.includes("service bot not autostarted:") ? text : undefined;
			},
			8000,
			"the not autostarted log line",
		);
		expect(log).toContain(
			`service bot not autostarted: grant token file not found: ${credentialGrantTokenPath(paths, "bot")} — create it with dg-skills credentials grant bot`,
		);
		expect(existsSync(join(paths.logDir, "service-bot.log"))).toBe(false);
	}, 20_000);
});
