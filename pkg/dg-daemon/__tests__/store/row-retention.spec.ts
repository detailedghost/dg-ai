import { describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import {
	ChatStore,
	FEED_ITEM_RETENTION_ROW_LIMIT,
	MESSAGE_RETENTION_ROW_LIMIT,
} from "../../src/store";
import {
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
} from "../utils/daemon-harness";

const SESSION_ID = "session-retention";

describe("ChatStore.pruneMessages", () => {
	it("keeps exactly the newest MESSAGE_RETENTION_ROW_LIMIT messages for a session over the cap, in the right order", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			const overflow = 5;
			const total = MESSAGE_RETENTION_ROW_LIMIT + overflow;
			for (let i = 0; i < total; i++) {
				store.insertMessage({
					sessionId: SESSION_ID,
					id: `msg-${i}`,
					role: "agent",
					body: `body-${i}`,
				});
			}

			const removed = store.pruneMessages();
			expect(removed).toBe(overflow);

			const all = store.peekAll(SESSION_ID);
			expect(all).toHaveLength(MESSAGE_RETENTION_ROW_LIMIT);
			expect(all[0].id).toBe(`msg-${overflow}`);
			expect(all[all.length - 1].id).toBe(`msg-${total - 1}`);

			const tail = store.peekTail(SESSION_ID, MESSAGE_RETENTION_ROW_LIMIT);
			expect(tail).toEqual(all);
			for (let i = 1; i < tail.length; i++) {
				expect(tail[i].seq).toBeGreaterThan(tail[i - 1].seq);
			}
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	}, 20_000);

	it("a session below the cap loses nothing", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			for (let i = 0; i < 50; i++) {
				store.insertMessage({
					sessionId: SESSION_ID,
					id: `msg-${i}`,
					role: i % 2 === 0 ? "user" : "agent",
					body: `body-${i}`,
				});
			}

			const removed = store.pruneMessages();
			expect(removed).toBe(0);
			expect(store.peekAll(SESSION_ID)).toHaveLength(50);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("does not drop an unclaimed user message even when its session is over the cap", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			store.insertMessage({
				sessionId: SESSION_ID,
				id: "old-unclaimed",
				role: "user",
				body: "never claimed",
			});
			for (let i = 0; i < MESSAGE_RETENTION_ROW_LIMIT; i++) {
				store.insertMessage({
					sessionId: SESSION_ID,
					id: `filler-${i}`,
					role: "agent",
					body: `filler-${i}`,
				});
			}

			const removed = store.pruneMessages();
			expect(removed).toBe(0);

			const all = store.peekAll(SESSION_ID);
			expect(all).toHaveLength(MESSAGE_RETENTION_ROW_LIMIT + 1);
			expect(all[0].id).toBe("old-unclaimed");

			const claim = store.claimNext(SESSION_ID);
			expect(claim?.id).toBe("old-unclaimed");
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	}, 20_000);
});

describe("ChatStore.pruneFeedItems", () => {
	function jobInput() {
		return {
			label: "retention-job",
			argv: ["echo", "hi"],
			cwd: "/tmp",
			intervalMs: 60_000,
		};
	}

	it("keeps exactly the newest FEED_ITEM_RETENTION_ROW_LIMIT items for a job over the cap", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			const job = store.insertJob(jobInput());
			const overflow = 5;
			const total = FEED_ITEM_RETENTION_ROW_LIMIT + overflow;
			const items = Array.from({ length: total }, (_, i) => ({
				fingerprint: `fp-${i}`,
				title: `title-${i}`,
			}));
			store.insertFeedItems(job.id, items);

			const removed = store.pruneFeedItems();
			expect(removed).toBe(overflow);

			const kept = store.listFeedItems({
				jobId: job.id,
				limit: FEED_ITEM_RETENTION_ROW_LIMIT,
			});
			expect(kept).toHaveLength(FEED_ITEM_RETENTION_ROW_LIMIT);
			expect(kept[0].title).toBe(`title-${total - 1}`);
			expect(kept[kept.length - 1].title).toBe(`title-${overflow}`);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("a job below the cap loses nothing", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			const job = store.insertJob(jobInput());
			const items = Array.from({ length: 10 }, (_, i) => ({
				fingerprint: `fp-${i}`,
				title: `title-${i}`,
			}));
			store.insertFeedItems(job.id, items);

			const removed = store.pruneFeedItems();
			expect(removed).toBe(0);
			expect(store.listFeedItems({ jobId: job.id })).toHaveLength(10);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});
