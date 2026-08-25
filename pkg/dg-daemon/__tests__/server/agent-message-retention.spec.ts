import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import { AGENT_MESSAGE_RETENTION_DAYS, ChatStore } from "../../src/store";
import {
	allocatePort,
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
	killDaemonByPidFile,
	spawnServe,
	waitForHealth,
	waitForValue,
} from "../utils/daemon-harness";

const HOUSEKEEPING_TICK_MS = 150;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

let dgHome: string;

afterEach(() => {
	killDaemonByPidFile(dgHome);
	cleanupDgHome(dgHome);
});

function queuedIds(dbPath: string): string[] {
	const raw = new Database(dbPath, { strict: true, readonly: true });
	const rows = raw
		.query("SELECT id FROM agent_messages ORDER BY seq")
		.all() as { id: string }[];
	raw.close(true);
	return rows.map((row) => row.id);
}

describe("the daemon's housekeeping tick", () => {
	it("prunes an agent message past the retention window, so a long-lived daemon does not hoard rows", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		spawnServe(dgHome, port, {
			DG_SESSION_TTL_MS: String(HOUSEKEEPING_TICK_MS),
			DG_IDLE_TTL_MS: String(60_000),
		});
		await waitForHealth(port);

		const writer = await ChatStore.open(paths, FILE_ONLY_SEAMS);
		writer.insertAgentMessage({
			senderSessionId: "session-alpha",
			senderIdentity: "alpha",
			recipientIdentity: "beta",
			id: "stale",
			body: "nobody ever claimed this",
		});
		writer.insertAgentMessage({
			senderSessionId: "session-alpha",
			senderIdentity: "alpha",
			recipientIdentity: "beta",
			id: "fresh",
			body: "still inside the window",
		});
		writer.close();

		const stamped = new Database(paths.dbPath, { strict: true });
		stamped.run("UPDATE agent_messages SET created_at = ? WHERE id = 'stale'", [
			new Date(
				Date.now() - (AGENT_MESSAGE_RETENTION_DAYS + 1) * MS_PER_DAY,
			).toISOString(),
		]);
		stamped.close(true);

		const remaining = await waitForValue(() => {
			const ids = queuedIds(paths.dbPath);
			return ids.includes("stale") ? undefined : ids;
		}, 5000);

		expect(remaining).toEqual(["fresh"]);
	}, 20_000);
});
