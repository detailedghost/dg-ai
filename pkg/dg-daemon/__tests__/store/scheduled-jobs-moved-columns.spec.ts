import { afterEach, describe, expect, it } from "bun:test";
import { CURRENT_SCHEMA_VERSION, SCHEMA_STEPS } from "../../src/store/schema";
import { cleanupDgHome } from "../utils/daemon-harness";
import {
	openStoreAt,
	rawRun,
	seedHome,
	type RawJob,
} from "../jobs/scheduled-fixtures";
import type { Database } from "bun:sqlite";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) cleanupDgHome(home);
});

describe("scheduled_jobs schema step 14", () => {
	it("is step 14 and adds moved_at and renamed_from", async () => {
		const { dgHome } = await seedHome();
		homes.push(dgHome);
		const store = await openStoreAt(dgHome);
		try {
			expect(SCHEMA_STEPS.map((step) => step.version)).toContain(14);
			expect(store.userVersion()).toBe(CURRENT_SCHEMA_VERSION);
			const db = (store as unknown as { db: Database }).db;
			const columns = db
				.query("PRAGMA table_info(scheduled_jobs)")
				.all() as Array<{ name: string; type: string }>;
			const byName = new Map(columns.map((column) => [column.name, column]));
			expect(byName.has("moved_at")).toBe(true);
			expect(byName.get("renamed_from")?.type).toBe("TEXT");
		} finally {
			store.close();
		}
	});

	it("leaves moved_at and renamed_from empty on a new row", async () => {
		const { dgHome, ids } = await seedHome({
			rows: [
				{ label: "fresh", argv: ["x"], cwd: process.cwd(), intervalMs: 60_000 },
			],
		});
		homes.push(dgHome);
		const store = await openStoreAt(dgHome);
		try {
			const db = (store as unknown as { db: Database }).db;
			const row = db
				.query("SELECT * FROM scheduled_jobs WHERE id = ?")
				.get(ids[0]) as RawJob;
			expect(row.moved_at).toBeNull();
			expect(row.renamed_from).toBeNull();
			rawRun(store, "UPDATE scheduled_jobs SET renamed_from = ? WHERE id = ?", "Old", ids[0]);
			expect(
				(db.query("SELECT renamed_from FROM scheduled_jobs").get() as RawJob)
					.renamed_from,
			).toBe("Old");
		} finally {
			store.close();
		}
	});
});
