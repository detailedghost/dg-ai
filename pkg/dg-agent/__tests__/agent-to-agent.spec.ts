import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHAT_PROTOCOL_VERSION, type SessionBootstrap } from "@dg/common";
import {
	applyConnectionPragmas,
	DEFAULT_BUSY_TIMEOUT_MS,
	resolveDgPaths,
} from "@dg/common/node";
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

/**
 * Opens the daemon's live database. `busy_timeout` is per connection and
 * defaults to 0, so a statement issued while the daemon is writing the session
 * row fails immediately with SQLITE_BUSY unless this connection waits.
 */
function openDaemonDb(readonly = false): Database {
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	const raw = new Database(paths.dbPath, {
		strict: true,
		...(readonly ? { readonly: true } : {}),
	});
	applyConnectionPragmas(raw);
	return raw;
}

function tamperDb(sql: string): void {
	const raw = openDaemonDb();
	raw.run(sql);
	raw.close(true);
}

function queuedRecipients(): string[] {
	const raw = openDaemonDb(true);
	const rows = raw
		.query("SELECT recipient_identity FROM agent_messages ORDER BY seq")
		.all() as { recipient_identity: string }[];
	raw.close(true);
	return rows.map((row) => row.recipient_identity);
}

/** How long the extra writer keeps the reserved lock. Long enough that the tamper cannot sneak in after COMMIT. */
const LOCK_HELD_MS = 800;
/** Floor for the tamper call. Below this, the UPDATE did not wait on the lock. */
const LOCK_WAIT_FLOOR_MS = 200;

function writeLockScript(): string {
	return `
import { writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
const db = new Database(process.env.DG_LOCK_DB, { strict: true });
db.run("PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}");
db.run("BEGIN IMMEDIATE");
writeFileSync(process.env.DG_LOCK_SIGNAL, "locked");
await Bun.sleep(${LOCK_HELD_MS});
db.run("COMMIT");
db.close(true);
`;
}

function spawnWriteLock(dbPath: string, signalPath: string) {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	env.DG_LOCK_DB = dbPath;
	env.DG_LOCK_SIGNAL = signalPath;
	return Bun.spawn([process.execPath, "-e", writeLockScript()], {
		env,
		stdout: "ignore",
		stderr: "pipe",
	});
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

	it("drops a tampered message and keeps serving, rather than taking the daemon down", async () => {
		const { port, alpha, beta } = await bootFleet();

		await send(port, alpha, ["--to", "beta", "will be corrupted"]);
		await waitForValue(
			() => (queuedRecipients().length > 0 ? true : undefined),
			3000,
		);

		// Session persistence writes on CLI attach, touch, and socket close, so
		// this UPDATE overlaps a live writer. Hold one explicitly: a connection
		// with no busy timeout throws SQLITE_BUSY here and never forges the row.
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const signal = join(dgHome, "write-lock-signal");
		const holder = spawnWriteLock(paths.dbPath, signal);
		try {
			await waitForValue(
				() => (existsSync(signal) ? true : undefined),
				3000,
				"write lock",
			);
			const started = Date.now();
			tamperDb("UPDATE agent_messages SET sender_identity = 'forged'");
			expect(Date.now() - started).toBeGreaterThanOrEqual(LOCK_WAIT_FLOOR_MS);
		} finally {
			const code = await holder.exited;
			if (code !== 0) {
				const stderr = await new Response(holder.stderr).text();
				throw new Error(`write-lock holder exited ${code}: ${stderr}`);
			}
		}

		expect(outcomeOf(await recv(port, beta)).outcome).toBe("empty");

		await send(port, alpha, ["--to", "beta", "and this one still arrives"]);
		expect(delivered(await recv(port, beta)).body).toBe(
			"and this one still arrives",
		);
	}, 20_000);

	it("trims the identity it was handed, so a padded --to still reaches its agent", async () => {
		const { port, alpha, beta } = await bootFleet();

		await send(port, alpha, ["--to", " beta ", "padded but deliverable"]);

		expect(delivered(await recv(port, beta)).body).toBe(
			"padded but deliverable",
		);
	});

	it("trims the identity a session registered under, so the two ends still meet", async () => {
		const { port, alpha } = await bootFleet();
		const delta = await registerSession(port, { agentIdentity: " delta " });

		await send(port, alpha, ["--to", "delta", "for delta"]);

		expect(delivered(await recv(port, delta)).body).toBe("for delta");
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
