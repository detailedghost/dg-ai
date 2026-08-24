import { describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import { ChatStore } from "../../src/store";
import {
	allocatePort,
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
	killDaemonByPidFile,
	spawnServe,
	waitForHealth,
} from "../utils/daemon-harness";

const SESSION = "session-second-opener";

async function withClaimedMessage(
	dgHome: string,
): Promise<{ paths: ReturnType<typeof resolveDgPaths>; claimId: string }> {
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
	store.insertMessage({
		sessionId: SESSION,
		id: "message-1",
		role: "user",
		body: "hello",
	});
	const claimed = store.claimNext(SESSION);
	expect(claimed).toBeDefined();
	store.close();
	return { paths, claimId: (claimed as { claimId: string }).claimId };
}

describe("stale-claim recovery is a daemon-boot step, not an open-time side effect", () => {
	it("leaves a live claim alone when a second process opens the same db, so the daemon's un-acked message is not re-delivered", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, claimId } = await withClaimedMessage(dgHome);

			const secondOpener = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			expect(secondOpener.claimNext(SESSION)).toBeUndefined();
			expect(secondOpener.ack(SESSION, claimId)).toBe(true);
			secondOpener.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("recovers the claim once the daemon explicitly asks, keeping crash-during-restart coverage", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths } = await withClaimedMessage(dgHome);

			const restarted = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			expect(restarted.claimNext(SESSION)).toBeUndefined();

			expect(restarted.recoverStaleClaims()).toBe(1);
			expect(restarted.claimNext(SESSION)?.id).toBe("message-1");
			restarted.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("reports zero when nothing was in flight, so a clean boot is distinguishable", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, claimId } = await withClaimedMessage(dgHome);
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			store.ack(SESSION, claimId);

			expect(store.recoverStaleClaims()).toBe(0);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("runs the recovery at real daemon boot, so a restart re-delivers without waiting out the lease", async () => {
		const dgHome = freshDgHome();
		try {
			const firstPort = allocatePort();
			spawnServe(dgHome, firstPort);
			await waitForHealth(firstPort, 8000);

			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const probe = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			probe.insertMessage({
				sessionId: SESSION,
				id: "boot-1",
				role: "user",
				body: "claimed before the crash",
			});
			expect(probe.claimNext(SESSION)?.id).toBe("boot-1");
			probe.close();

			killDaemonByPidFile(dgHome);

			const secondPort = allocatePort();
			spawnServe(dgHome, secondPort);
			await waitForHealth(secondPort, 8000);

			const after = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			expect(after.claimNext(SESSION)?.id).toBe("boot-1");
			after.close();
		} finally {
			killDaemonByPidFile(dgHome);
			cleanupDgHome(dgHome);
		}
	}, 30000);
});
