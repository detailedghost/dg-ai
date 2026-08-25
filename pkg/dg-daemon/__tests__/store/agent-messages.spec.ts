import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { ChatStore } from "../../src/store";
import {
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
	scanFileForBytes,
} from "../utils/daemon-harness";

const ALPHA_SESSION = "session-alpha";
const BETA_SESSION = "session-beta";
const ALPHA_SECOND_SESSION = "session-alpha-2";

let dgHome: string;
let paths: DgPaths;
let store: ChatStore;

function sendToBeta(id: string, body: string): void {
	store.insertAgentMessage({
		senderSessionId: ALPHA_SESSION,
		senderIdentity: "alpha",
		recipientIdentity: "beta",
		id,
		body,
	});
}

beforeEach(async () => {
	dgHome = freshDgHome();
	paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
});

afterEach(() => {
	store.close();
	cleanupDgHome(dgHome);
});

describe("a message addressed to an agent identity", () => {
	it("waits until a session for that identity asks for it", () => {
		sendToBeta("m1", "run the migration");

		expect(
			store.claimNextAgentMessage("gamma", "session-gamma"),
		).toBeUndefined();

		const claimed = store.claimNextAgentMessage("beta", BETA_SESSION);
		expect(claimed?.body).toBe("run the migration");
		expect(claimed?.from).toBe("alpha");
		expect(claimed?.to).toBe("beta");
		expect(claimed?.role).toBe("agent");
	});

	it("survives the daemon that took it, because it is a row and not a socket", async () => {
		sendToBeta("m1", "run the migration");
		store.close();

		store = await ChatStore.open(paths, FILE_ONLY_SEAMS);

		expect(store.claimNextAgentMessage("beta", BETA_SESSION)?.body).toBe(
			"run the migration",
		);
	});

	it("arrives in the order it was sent", () => {
		sendToBeta("m1", "first");
		sendToBeta("m2", "second");

		expect(store.claimNextAgentMessage("beta", BETA_SESSION)?.id).toBe("m1");
		expect(store.claimNextAgentMessage("beta", BETA_SESSION)?.id).toBe("m2");
	});

	it("goes to one consumer only, so a second claim finds nothing left", () => {
		sendToBeta("m1", "only");

		expect(store.claimNextAgentMessage("beta", BETA_SESSION)).toBeDefined();
		expect(store.claimNextAgentMessage("beta", BETA_SESSION)).toBeUndefined();
	});

	it("stays claimed after the ack, so nothing re-delivers it", () => {
		sendToBeta("m1", "only");
		const claimed = store.claimNextAgentMessage("beta", BETA_SESSION);

		expect(store.ackAgentMessage("beta", claimed?.claimId ?? "")).toBe(true);
		expect(store.ackAgentMessage("beta", claimed?.claimId ?? "")).toBe(false);
		expect(store.claimNextAgentMessage("beta", BETA_SESSION)).toBeUndefined();
	});

	it("cannot be acked by an identity it was never addressed to", () => {
		sendToBeta("m1", "only");
		const claimed = store.claimNextAgentMessage("beta", BETA_SESSION);

		expect(store.ackAgentMessage("gamma", claimed?.claimId ?? "")).toBe(false);
		expect(store.ackAgentMessage("beta", claimed?.claimId ?? "")).toBe(true);
	});
});

describe("the sender", () => {
	it("never receives its own message back as a queue item", () => {
		store.insertAgentMessage({
			senderSessionId: ALPHA_SESSION,
			senderIdentity: "alpha",
			recipientIdentity: "alpha",
			id: "m1",
			body: "a note to myself",
		});

		expect(store.claimNextAgentMessage("alpha", ALPHA_SESSION)).toBeUndefined();
	});

	it("reaches its other session, which is a different consumer", () => {
		store.insertAgentMessage({
			senderSessionId: ALPHA_SESSION,
			senderIdentity: "alpha",
			recipientIdentity: "alpha",
			id: "m1",
			body: "a note to my other session",
		});

		expect(
			store.claimNextAgentMessage("alpha", ALPHA_SECOND_SESSION)?.body,
		).toBe("a note to my other session");
	});

	it("does not see a reply it addressed to someone else", () => {
		store.insertAgentMessage({
			senderSessionId: BETA_SESSION,
			senderIdentity: "beta",
			recipientIdentity: "alpha",
			id: "reply",
			body: "done",
		});

		expect(store.claimNextAgentMessage("beta", BETA_SESSION)).toBeUndefined();
		expect(store.claimNextAgentMessage("alpha", ALPHA_SESSION)?.body).toBe(
			"done",
		);
	});
});

describe("the human queue", () => {
	it("never hands an agent-to-agent message to claimNext", () => {
		sendToBeta("m1", "for beta only");
		store.insertMessage({
			sessionId: BETA_SESSION,
			id: "h1",
			role: "user",
			body: "from the human",
		});

		expect(store.claimNext(BETA_SESSION)?.id).toBe("h1");
		expect(store.claimNext(BETA_SESSION)).toBeUndefined();
	});

	it("keeps agent-to-agent traffic out of the transcript the canvas renders", () => {
		sendToBeta("m1", "for beta only");

		expect(store.peekAll(ALPHA_SESSION)).toEqual([]);
		expect(store.peekAll(BETA_SESSION)).toEqual([]);
	});

	it("cannot ack an agent-message claim by mistake", () => {
		sendToBeta("m1", "for beta only");
		const claimed = store.claimNextAgentMessage("beta", BETA_SESSION);

		expect(store.ack(BETA_SESSION, claimed?.claimId ?? "")).toBe(false);
	});
});

describe("recovery and encryption at rest", () => {
	it("releases a claim the boot step finds still held", () => {
		sendToBeta("m1", "only");
		store.insertMessage({
			sessionId: BETA_SESSION,
			id: "h1",
			role: "user",
			body: "from the human",
		});
		store.claimNextAgentMessage("beta", BETA_SESSION);
		store.claimNext(BETA_SESSION);

		expect(store.recoverStaleClaims()).toBe(2);
		expect(store.claimNextAgentMessage("beta", BETA_SESSION)?.id).toBe("m1");
		expect(store.claimNext(BETA_SESSION)?.id).toBe("h1");
	});

	it("leaves no plaintext body in the database file", async () => {
		sendToBeta("m1", "a-very-distinctive-agent-body");
		store.close();

		expect(
			scanFileForBytes(paths.dbPath, "a-very-distinctive-agent-body"),
		).toBe(false);

		store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
	});

	it("refuses to decrypt a row someone re-addressed", async () => {
		sendToBeta("m1", "run the migration");
		store.close();

		const raw = new Database(paths.dbPath, { strict: true });
		raw.run(
			"UPDATE agent_messages SET recipient_identity = 'gamma' WHERE id = 'm1'",
		);
		raw.close(true);
		store = await ChatStore.open(paths, FILE_ONLY_SEAMS);

		expect(() =>
			store.claimNextAgentMessage("gamma", "session-gamma"),
		).toThrow();
	});

	it("refuses to decrypt a row whose sender was forged", async () => {
		sendToBeta("m1", "run the migration");
		store.close();

		const raw = new Database(paths.dbPath, { strict: true });
		raw.run(
			"UPDATE agent_messages SET sender_identity = 'orchestrator' WHERE id = 'm1'",
		);
		raw.close(true);
		store = await ChatStore.open(paths, FILE_ONLY_SEAMS);

		expect(() => store.claimNextAgentMessage("beta", BETA_SESSION)).toThrow();
	});
});
