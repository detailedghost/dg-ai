import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { CHAT_PROTOCOL_VERSION, type SessionBootstrap } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import {
	allocatePort,
	cleanupDgHome,
	collectFrames,
	deliverUserMessage,
	freshDgHome,
	killDaemonByPidFile,
	registerSession,
	sendConnectHandshake,
	spawnServe,
	waitForHealth,
	waitForOpen,
	waitForValue,
	wsExtensionSocket,
} from "@dg/dg-daemon/test-harness";
import { runCli } from "./cli-wire";

type CliResult = { stdout: string; stderr: string; exitCode: number | null };

type Fleet = {
	port: number;
	alpha: SessionBootstrap;
	beta: SessionBootstrap;
};

let dgHome: string;

afterEach(() => {
	killDaemonByPidFile(dgHome);
	cleanupDgHome(dgHome);
});

async function bootFleet(
	extraEnv: Record<string, string> = {},
): Promise<Fleet> {
	dgHome = freshDgHome();
	const port = allocatePort();
	spawnServe(dgHome, port, extraEnv);
	await waitForHealth(port);
	const alpha = await registerSession(port, { agentIdentity: "alpha" });
	const beta = await registerSession(port, { agentIdentity: "beta" });
	return { port, alpha, beta };
}

function send(
	port: number,
	from: SessionBootstrap,
	args: string[],
): Promise<CliResult> {
	return runCli(dgHome, port, ["send", "--session", from.sessionId, ...args]);
}

function recv(
	port: number,
	as: SessionBootstrap,
	args: string[] = [],
): Promise<CliResult> {
	return runCli(dgHome, port, ["recv", "--session", as.sessionId, ...args]);
}

function queuedRecipients(): string[] {
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	const raw = new Database(paths.dbPath, { strict: true, readonly: true });
	const rows = raw
		.query("SELECT recipient_identity FROM agent_messages ORDER BY seq")
		.all() as { recipient_identity: string }[];
	raw.close(true);
	return rows.map((row) => row.recipient_identity);
}

function outcomeOf(result: CliResult): {
	outcome: string;
	message?: Record<string, unknown>;
} {
	expect(result.stderr).toBe("");
	expect(result.exitCode).toBe(0);
	return JSON.parse(result.stdout.trim());
}

function delivered(result: CliResult): Record<string, unknown> {
	const parsed = outcomeOf(result);
	expect(parsed.outcome).toBe("delivered");
	return parsed.message ?? {};
}

describe("one agent addressing another by identity", () => {
	it("delivers the message to the recipient, naming the sender", async () => {
		const { port, alpha, beta } = await bootFleet();

		await send(port, alpha, ["--to", "beta", "run the migration"]);
		const received = await recv(port, beta);

		const message = delivered(received);
		expect(message.body).toBe("run the migration");
		expect(message.from).toBe("alpha");
		expect(message.to).toBe("beta");
	});

	it("leaves the sender's own recv empty", async () => {
		const { port, alpha } = await bootFleet();

		await send(port, alpha, ["--to", "beta", "run the migration"]);
		const received = await recv(port, alpha);

		expect(outcomeOf(received).outcome).toBe("empty");
	});

	it("waits for an identity that has no session yet", async () => {
		const { port, alpha } = await bootFleet();

		await send(port, alpha, ["--to", "gamma", "start when you can"]);
		const gamma = await registerSession(port, { agentIdentity: "gamma" });
		const received = await recv(port, gamma);

		expect(delivered(received).body).toBe("start when you can");
	});

	it("wakes a blocked recv that was already waiting", async () => {
		const { port, alpha, beta } = await bootFleet();

		const blocked = recv(port, beta, ["--block", "--timeout", "5000"]);
		await send(port, alpha, ["--to", "beta", "late arrival"]);
		const received = await blocked;

		expect(delivered(received).body).toBe("late arrival");
	});

	it("keeps it out of the human's canvas, which only sees the reply meant for them", async () => {
		const { port, alpha, beta } = await bootFleet();
		const page = wsExtensionSocket(port);
		try {
			await waitForOpen(page);
			sendConnectHandshake(page, alpha, CHAT_PROTOCOL_VERSION);
			const frames = collectFrames(page);

			await send(port, alpha, ["--to", "beta", "coordination chatter"]);
			await send(port, alpha, ["the answer for the human"]);
			const agentFrames = await waitForValue(() => {
				const seen = frames.filter(
					(frame) => (frame as { type?: string }).type === "agent-message",
				) as { body: string }[];
				return seen.length > 0 ? seen : undefined;
			}, 3000);

			expect(agentFrames.map((frame) => frame.body)).toEqual([
				"the answer for the human",
			]);
		} finally {
			page.close();
		}

		expect(delivered(await recv(port, beta)).body).toBe("coordination chatter");
	});

	it("acks on delivery, so an expired lease does not redeliver it", async () => {
		const { port, alpha, beta } = await bootFleet({
			DG_CLAIM_LEASE_MS: "150",
		});

		await send(port, alpha, ["--to", "beta", "exactly once"]);
		expect(delivered(await recv(port, beta)).body).toBe("exactly once");
		await new Promise((wake) => setTimeout(wake, 300));

		expect(outcomeOf(await recv(port, beta)).outcome).toBe("empty");
	});

	it("hands the human's message over first when both are waiting", async () => {
		const { port, alpha, beta } = await bootFleet();

		await send(port, alpha, ["--to", "beta", "from another agent"]);
		await deliverUserMessage(port, beta, "from the human");

		expect(delivered(await recv(port, beta)).body).toBe("from the human");
		expect(delivered(await recv(port, beta)).body).toBe("from another agent");
	});

	it("refuses an empty identity rather than queueing a message nobody can claim", async () => {
		const { port, alpha } = await bootFleet();

		await send(port, alpha, ["--to", "   ", "nowhere"]);
		await send(port, alpha, ["--to", "beta", "somewhere"]);
		const recipients = await waitForValue(() => {
			const queued = queuedRecipients();
			return queued.length > 0 ? queued : undefined;
		}, 3000);

		expect(recipients).toEqual(["beta"]);
	});
});
