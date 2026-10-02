import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { OverwatchLane } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { ChatStore } from "../../src/store";
import { CURRENT_SCHEMA_VERSION } from "../../src/store/schema";
import {
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
} from "../utils/daemon-harness";

function lane(
	overrides: Partial<Omit<OverwatchLane, "updatedAt">> = {},
): Omit<OverwatchLane, "updatedAt"> {
	return {
		chat: "print",
		task: "Prepare launch collateral",
		stage: "review",
		mr: "!298",
		eta: "20m",
		next: "Approve copy",
		url: "https://claude.ai/code/session-123",
		kind: "chat",
		publisher: "print-agent",
		...overrides,
	};
}

describe("ChatStore overwatch board", () => {
	it("round-trips a lane and launch settings, then removes the lane", async () => {
		const dgHome = freshDgHome();
		try {
			const store = await ChatStore.open(
				resolveDgPaths({ env: { DG_HOME: dgHome } }),
				FILE_ONLY_SEAMS,
			);
			store.upsertLane(lane());
			store.setLaunch({
				goLive: "2026-10-24T14:00:00.000Z",
				goNoGo: "2026-10-17T14:00:00.000Z",
			});

			expect(store.getBoard()).toMatchObject({
				goLive: "2026-10-24T14:00:00.000Z",
				goNoGo: "2026-10-17T14:00:00.000Z",
				lanes: [lane()],
				merges: [],
			});

			expect(store.removeLane("print")).toBe(true);
			expect(store.getBoard().lanes).toEqual([]);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("merges partial updates into an existing lane and clears next explicitly", async () => {
		const dgHome = freshDgHome();
		try {
			const store = await ChatStore.open(
				resolveDgPaths({ env: { DG_HOME: dgHome } }),
				FILE_ONLY_SEAMS,
			);
			store.upsertLane(lane());
			store.upsertLane({ chat: "print", stage: "merge", publisher: "lead" });

			expect(store.getBoard().lanes[0]).toMatchObject({
				...lane(),
				stage: "merge",
				publisher: "lead",
			});

			store.upsertLane({ chat: "print", clearNext: true, publisher: "lead" });
			expect(store.getBoard().lanes[0]?.next).toBeUndefined();
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("requires a stage when creating a lane", async () => {
		const dgHome = freshDgHome();
		try {
			const store = await ChatStore.open(
				resolveDgPaths({ env: { DG_HOME: dgHome } }),
				FILE_ONLY_SEAMS,
			);

			expect(() =>
				store.upsertLane({ chat: "print", publisher: "lead" }),
			).toThrow("stage is required when creating a new overwatch lane");
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("returns only merges from the current local day", async () => {
		const dgHome = freshDgHome();
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		try {
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			store.addMerge({ mr: "!297", title: "Yesterday's merge" });
			store.close();

			const raw = new Database(paths.dbPath);
			raw.run("UPDATE overwatch_merges SET at = ?", [
				"2000-01-01T12:00:00.000Z",
			]);
			raw.close(true);

			const reopened = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			reopened.addMerge({ mr: "!298", title: "Today's merge" });
			expect(reopened.getBoard().merges.map((merge) => merge.title)).toEqual([
				"Today's merge",
			]);
			reopened.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("keeps merge reports idempotent and prunes expired rows", async () => {
		const dgHome = freshDgHome();
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		try {
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			store.addMerge({ mr: "!298", title: "First title" });
			store.close();

			const raw = new Database(paths.dbPath);
			raw.run("UPDATE overwatch_merges SET at = ?", [
				"2000-01-01T12:00:00.000Z",
			]);
			raw.close(true);

			const reopened = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			reopened.addMerge({ mr: "!299", title: "Current title" });
			reopened.addMerge({ mr: "!299", title: "Updated title" });
			expect(reopened.getBoard().merges).toHaveLength(1);
			expect(reopened.getBoard().merges[0]).toMatchObject({
				mr: "!299",
				title: "Updated title",
			});
			reopened.close();

			const probe = new Database(paths.dbPath, { readonly: true });
			const count = probe
				.query("SELECT COUNT(*) AS count FROM overwatch_merges")
				.get() as { count: number };
			expect(count.count).toBe(1);
			probe.close(true);
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("keeps board free text encrypted at rest", async () => {
		const dgHome = freshDgHome();
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		try {
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			store.upsertLane(lane());
			store.addMerge({ mr: "!297", title: "Private merge title" });
			store.close();

			const bytes = await Bun.file(paths.dbPath).arrayBuffer();
			const text = Buffer.from(bytes).toString("utf8");
			const raw = new Database(paths.dbPath, { readonly: true });
			const row = raw.query("SELECT chat_key FROM overwatch_lanes").get() as {
				chat_key: string;
			};
			raw.close(true);
			expect(text).not.toContain("Prepare launch collateral");
			expect(text).not.toContain("Private merge title");
			expect(row.chat_key).not.toBe(
				createHash("sha256").update("print").digest("hex"),
			);
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});

describe("ChatStore migration to schema v9", () => {
	it("migrates a v8 database and creates the reserved overwatch session", async () => {
		const dgHome = freshDgHome();
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		try {
			const initialized = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			initialized.close();

			const raw = new Database(paths.dbPath);
			raw.run("DROP TABLE inbox_auth_caches");
			raw.run("DROP TABLE inbox_profiles");
			raw.run("DROP TABLE overwatch_lanes");
			raw.run("DROP TABLE overwatch_merges");
			raw.run("DROP TABLE overwatch_settings");
			raw.run("DELETE FROM sessions WHERE id = '__overwatch__'");
			raw.run("PRAGMA user_version = 8");
			raw.close(true);

			const migrated = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			expect(migrated.userVersion()).toBe(CURRENT_SCHEMA_VERSION);
			migrated.close();

			const probe = new Database(paths.dbPath, { readonly: true });
			const tables = probe
				.query(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'overwatch_%' ORDER BY name",
				)
				.all() as { name: string }[];
			const session = probe
				.query("SELECT id FROM sessions WHERE id = '__overwatch__'")
				.get() as { id: string } | null;
			expect(tables.map(({ name }) => name)).toEqual([
				"overwatch_lanes",
				"overwatch_merges",
				"overwatch_settings",
			]);
			expect(session?.id).toBe("__overwatch__");
			probe.close(true);
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});
