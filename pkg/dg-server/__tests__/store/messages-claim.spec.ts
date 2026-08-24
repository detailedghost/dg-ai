import { describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import { ChatStore } from "../../src/store";
import {
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
} from "../utils/daemon-harness";

const SESSION_ID = "session-claims-1";

describe("ChatStore claimNext / ack / peekAll", () => {
	it("claims messages in seq order, and a second claim (before acking the first) gets a DIFFERENT row", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			store.insertMessage({
				sessionId: SESSION_ID,
				id: "m1",
				role: "user",
				body: "first",
			});
			store.insertMessage({
				sessionId: SESSION_ID,
				id: "m2",
				role: "user",
				body: "second",
			});

			const claim1 = store.claimNext(SESSION_ID);
			const claim2 = store.claimNext(SESSION_ID);

			expect(claim1?.id).toBe("m1");
			expect(claim2?.id).toBe("m2");
			expect(claim1?.claimId).not.toBe(claim2?.claimId);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("returns undefined once every message has been claimed", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			store.insertMessage({
				sessionId: SESSION_ID,
				id: "only",
				role: "user",
				body: "solo",
			});

			store.claimNext(SESSION_ID);
			expect(store.claimNext(SESSION_ID)).toBeUndefined();
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("ack requires the matching claimId — a wrong claimId does not ack", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			store.insertMessage({
				sessionId: SESSION_ID,
				id: "m1",
				role: "user",
				body: "first",
			});
			const claim = store.claimNext(SESSION_ID);

			expect(store.ack(SESSION_ID, "not-the-real-claim-id")).toBe(false);
			expect(store.ack(SESSION_ID, claim?.claimId as string)).toBe(true);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("an acked message is excluded from further claims, exposing the next unclaimed one", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			store.insertMessage({
				sessionId: SESSION_ID,
				id: "m1",
				role: "user",
				body: "first",
			});
			store.insertMessage({
				sessionId: SESSION_ID,
				id: "m2",
				role: "user",
				body: "second",
			});

			const claim1 = store.claimNext(SESSION_ID);
			store.ack(SESSION_ID, claim1?.claimId as string);
			const claim2 = store.claimNext(SESSION_ID);

			expect(claim2?.id).toBe("m2");
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("reclaims an unacked claim once DG_CLAIM_LEASE_MS elapses, with no reopen involved", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const LEASE_MS = 200;
			const store = await ChatStore.open(paths, {
				env: { DG_KEY_SOURCE: "file", DG_CLAIM_LEASE_MS: String(LEASE_MS) },
			});
			store.insertMessage({
				sessionId: SESSION_ID,
				id: "m1",
				role: "user",
				body: "first",
			});

			const claimed = store.claimNext(SESSION_ID);
			expect(claimed?.id).toBe("m1");

			expect(store.claimNext(SESSION_ID)).toBeUndefined();

			await new Promise((r) => setTimeout(r, LEASE_MS * 4));

			const reclaimed = store.claimNext(SESSION_ID);
			expect(reclaimed?.id).toBe("m1");

			expect(store.ack(SESSION_ID, claimed?.claimId as string)).toBe(false);
			expect(store.ack(SESSION_ID, reclaimed?.claimId as string)).toBe(true);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("never claims an agent-authored row, so the agent's own reply is transcript and not something recv hands back to it", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			store.insertMessage({
				sessionId: SESSION_ID,
				id: "human-1",
				role: "user",
				body: "question",
			});
			const claim = store.claimNext(SESSION_ID);
			store.ack(SESSION_ID, claim?.claimId as string);

			store.insertMessage({
				sessionId: SESSION_ID,
				id: "agent-1",
				role: "agent",
				body: "answer",
			});

			expect(store.claimNext(SESSION_ID)).toBeUndefined();
			expect(store.peekAll(SESSION_ID).map((m) => m.id)).toEqual([
				"human-1",
				"agent-1",
			]);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("peekAll returns every message for a session in seq order, decrypted, regardless of claim state", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			store.insertMessage({
				sessionId: SESSION_ID,
				id: "m1",
				role: "user",
				body: "alpha",
			});
			store.insertMessage({
				sessionId: SESSION_ID,
				id: "m2",
				role: "agent",
				body: "beta",
			});
			store.insertMessage({
				sessionId: SESSION_ID,
				id: "m3",
				role: "user",
				body: "gamma",
			});

			const claim1 = store.claimNext(SESSION_ID);
			store.ack(SESSION_ID, claim1?.claimId as string);
			store.claimNext(SESSION_ID);

			const all = store.peekAll(SESSION_ID);

			expect(all.map((m) => m.body)).toEqual(["alpha", "beta", "gamma"]);
			expect(all.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("peekAll's item shape matches the history-response projection: seq, id, role, body, createdAt, optional attachmentId", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			store.insertMessage({
				sessionId: SESSION_ID,
				id: "m1",
				role: "user",
				body: "hi",
			});
			store.insertMessage({
				sessionId: SESSION_ID,
				id: "m2",
				role: "agent",
				body: "hello",
			});

			const [first, second] = store.peekAll(SESSION_ID);

			expect(typeof first?.seq).toBe("number");
			expect(second?.seq as number).toBeGreaterThan(first?.seq as number);
			expect(first?.role).toBe("user");
			expect(second?.role).toBe("agent");
			expect(typeof first?.createdAt).toBe("string");
			expect(Number.isNaN(Date.parse(first?.createdAt as string))).toBe(false);
			expect(first?.attachmentId).toBeUndefined();
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});
