import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CHAT_PROTOCOL_VERSION,
	CLI_SESSION_ID_HEADER,
	CLI_SESSION_TOKEN_HEADER,
} from "@dg/common";
import { resolveDgPaths, writePidFileAtomic, writeSessionToken } from "@dg/common/node";
import { inboxDaemonRuntime } from "../src/commands/inbox";
import { inboxCliHarness } from "./inbox-cli-harness";

function fixtureCredentialsDaemon(dgHome: string, store: Map<string, string>) {
	const sessionId = "fixture-mail-credentials-session";
	const token = "fixture-mail-credentials-token";
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			const sessionOk =
				request.headers.get(CLI_SESSION_ID_HEADER) === sessionId &&
				request.headers.get(CLI_SESSION_TOKEN_HEADER) === token;
			if (!sessionOk) return new Response("unauthorized", { status: 401 });
			if (server.upgrade(request)) return;
			return new Response("upgrade required", { status: 400 });
		},
		websocket: {
			message(socket, message) {
				const frame = JSON.parse(String(message)) as Record<string, string>;
				let value: unknown = null;
				if (frame.operation === "get" && store.has(frame.name)) {
					value = {
						value: store.get(frame.name),
						meta: {},
						updatedAt: "2026-01-01T00:00:00.000Z",
					};
				}
				socket.send(
					JSON.stringify({
						type: "cli-credentials-result",
						sessionId,
						requestId: frame.requestId,
						ok: true,
						value,
					}),
				);
			},
		},
	});
	writePidFileAtomic(paths, {
		pid: process.pid,
		port: server.port!,
		instanceId: "fixture-mail-credentials-daemon",
		versions: { package: "1.0.0", protocol: CHAT_PROTOCOL_VERSION },
	});
	writeSessionToken(paths, sessionId, {
		sessionId,
		token,
		cwd: dgHome,
		agentIdentity: "fixture-model",
	});
	return { sessionId, stop: () => server.stop(true) };
}

describe("inboxDaemonRuntime credentialGet", () => {
	test("never writes the credential value to stdout or stderr on success or failure", async () => {
		const dgHome = mkdtempSync(join(tmpdir(), "dg-mail-credentials-"));
		const secret = "fixture-bridge-password-f3a9";
		const store = new Map([["inbox/protonmail-bridge/work", secret]]);
		const daemon = fixtureCredentialsDaemon(dgHome, store);
		const originalHome = process.env.DG_HOME;
		const originalToken = process.env.DG_SESSION_TOKEN;
		process.env.DG_HOME = dgHome;
		delete process.env.DG_SESSION_TOKEN;
		const stdout: string[] = [];
		const stderr: string[] = [];
		const log = console.log;
		const errorLog = console.error;
		console.log = (...values: unknown[]) => stdout.push(values.map(String).join(" "));
		console.error = (...values: unknown[]) => stderr.push(values.map(String).join(" "));
		let thrown: unknown;
		try {
			const { runtime, close } = inboxDaemonRuntime(daemon.sessionId);
			const found = await runtime.credentialGet!("inbox/protonmail-bridge/work");
			expect(found).toBe(secret);
			const missing = await runtime.credentialGet!("inbox/protonmail-bridge/missing");
			expect(missing).toBeNull();
			close();

			daemon.stop();
			const { runtime: afterStop, close: closeAfterStop } = inboxDaemonRuntime(
				daemon.sessionId,
			);
			try {
				await afterStop.credentialGet!("inbox/protonmail-bridge/work");
			} catch (error) {
				thrown = error;
			} finally {
				closeAfterStop();
			}
		} finally {
			console.log = log;
			console.error = errorLog;
			if (originalHome === undefined) delete process.env.DG_HOME;
			else process.env.DG_HOME = originalHome;
			if (originalToken !== undefined) process.env.DG_SESSION_TOKEN = originalToken;
			rmSync(dgHome, { recursive: true, force: true });
		}
		expect(thrown).toBeInstanceOf(Error);
		expect(String((thrown as Error).message)).not.toContain(secret);
		expect(stdout.join("\n")).not.toContain(secret);
		expect(stderr.join("\n")).not.toContain(secret);
	});
});

describe("dg-skills inbox mail --help", () => {
	test("lists the seven mail verbs and no legacy browser flags", async () => {
		const h = inboxCliHarness();
		try {
			const result = await h.run(["mail", "--help"]);
			expect(result.code, result.stderr).toBe(0);
			for (const verb of ["list", "search", "read", "attachments", "new", "reply", "send"])
				expect(result.stdout).toContain(verb);
			for (const legacy of [
				"--live-browser",
				"--session-profile",
				"--browser-type",
				"--browser-executable-path",
				"--browser-headless",
				"--login-timeout",
			])
				expect(result.stdout).not.toContain(legacy);
		} finally {
			h.cleanup();
		}
	});
});
