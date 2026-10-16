import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { validateSessionBootstrap } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import {
	allocatePort,
	cleanupDgHome,
	collectFrames,
	decodeChatMarker,
	deliverUserMessage,
	freshDgHome,
	killDaemonByPidFile,
	spawnServe,
	waitForHealth,
	waitForOpen,
	waitForValue,
	wsExtensionSocket,
} from "@dg/dg-daemon/test-harness";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import { sendConnectHandshake } from "@dg/dg-daemon/test-harness";
import { runCli } from "./cli-wire";

let dgHome: string;

afterEach(() => {
	killDaemonByPidFile(dgHome);
	cleanupDgHome(dgHome);
});

function sessionFiles(): string[] {
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	try {
		return readdirSync(paths.sessionsDir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
}

describe("Claude as the runner, with sessions stored in the daemon database", () => {
	it("chats both ways with the panel and still delivers send --to", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		spawnServe(dgHome, port);
		await waitForHealth(port);

		const started = await runCli(dgHome, port, ["start", "-a", "claude"]);
		expect(started.exitCode).toBe(0);
		expect(started.stderr).toContain("open the extension side panel and choose Connect");
		expect(started.stderr).not.toContain("sk-");
		const bootstrap = validateSessionBootstrap(decodeChatMarker(started.stdout.trim()));
		expect(bootstrap.agentIdentity).toBe("claude");
		expect(started.stderr).not.toContain(bootstrap.token);
		expect(sessionFiles()).toEqual([]);

		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const raw = new Database(paths.dbPath, { readonly: true, strict: true });
		try {
			const row = raw
				.query(
					"SELECT agent_identity, token_ciphertext FROM sessions WHERE id = ?",
				)
				.get(bootstrap.sessionId) as {
				agent_identity: string;
				token_ciphertext: Uint8Array;
			};
			expect(row.agent_identity).toBe("claude");
			expect(
				Buffer.from(row.token_ciphertext).includes(Buffer.from(bootstrap.token)),
			).toBe(false);
		} finally {
			raw.close();
		}

		await deliverUserMessage(port, bootstrap, "hello from the panel");
		const received = await runCli(dgHome, port, [
			"recv",
			"--session",
			bootstrap.sessionId,
		]);
		expect(received.exitCode).toBe(0);
		expect(received.stdout).toContain("hello from the panel");

		const page = wsExtensionSocket(port);
		try {
			await waitForOpen(page);
			sendConnectHandshake(page, bootstrap, CHAT_PROTOCOL_VERSION);
			const frames = collectFrames(page);
			const sent = await runCli(dgHome, port, [
				"send",
				"--session",
				bootstrap.sessionId,
				"hello from claude",
			]);
			expect(sent.exitCode).toBe(0);
			const agentFrames = await waitForValue(() => {
				const seen = frames.filter(
					(frame) =>
						typeof frame === "object" &&
						frame !== null &&
						(frame as { type?: string }).type === "agent-message",
				) as { body?: string }[];
				return seen.length > 0 ? seen : undefined;
			}, 3000);
			expect(agentFrames.map((frame) => frame.body)).toEqual(["hello from claude"]);
		} finally {
			page.close();
		}

		const reviewer = await runCli(dgHome, port, [
			"start",
			"-a",
			"reviewer",
			"--fresh",
		]);
		expect(reviewer.exitCode).toBe(0);
		const reviewerBootstrap = validateSessionBootstrap(
			decodeChatMarker(reviewer.stdout.trim()),
		);
		const forwarded = await runCli(dgHome, port, [
			"send",
			"--session",
			bootstrap.sessionId,
			"--to",
			"reviewer",
			"please look",
		]);
		expect(forwarded.exitCode).toBe(0);
		const review = await runCli(dgHome, port, [
			"recv",
			"--session",
			reviewerBootstrap.sessionId,
		]);
		expect(review.exitCode).toBe(0);
		expect(review.stdout).toContain("please look");
		expect(review.stdout).not.toContain(bootstrap.token);
		expect(sessionFiles()).toEqual([]);
	}, 20_000);
});
