import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import {
	createLogger,
	LOG_RETENTION_DAYS,
	pruneLogs,
} from "../../src/server/log";
import { cleanupDgHome, freshTempDir } from "../utils/daemon-harness";

const MS_PER_DAY = 86_400_000;

let dgHome: string;

afterEach(() => {
	cleanupDgHome(dgHome);
});

function pathsFor(): ReturnType<typeof resolveDgPaths> {
	dgHome = freshTempDir("dg-log-retention");
	return resolveDgPaths({ env: { DG_HOME: dgHome } });
}

function dayStamp(at: Date): string {
	return at.toISOString().slice(0, 10);
}

function daysBefore(anchor: Date, days: number): Date {
	return new Date(anchor.getTime() - days * MS_PER_DAY);
}

function seedLog(logDir: string, at: Date): string {
	const name = `daemon-${dayStamp(at)}.log`;
	writeFileSync(join(logDir, name), `${dayStamp(at)} seeded\n`);
	return name;
}

describe("daemon log retention", () => {
	it("writes into a file named for today, not one shared file", () => {
		const paths = pathsFor();
		const at = new Date("2026-03-14T09:00:00.000Z");

		const logger = createLogger(paths, { now: () => at });
		logger.info("first line");

		expect(existsSync(join(paths.logDir, "daemon-2026-03-14.log"))).toBe(true);
	});

	it("keeps exactly the retention window and deletes everything older", () => {
		const paths = pathsFor();
		const now = new Date("2026-03-14T09:00:00.000Z");
		createLogger(paths, { now: () => now });

		const kept = Array.from({ length: LOG_RETENTION_DAYS }, (_, i) =>
			seedLog(paths.logDir, daysBefore(now, i)),
		);
		const expired = [LOG_RETENTION_DAYS, LOG_RETENTION_DAYS + 5, 400].map((d) =>
			seedLog(paths.logDir, daysBefore(now, d)),
		);

		expect(pruneLogs(paths.logDir, now).sort()).toEqual(expired.sort());
		expect(readdirSync(paths.logDir).sort()).toEqual(kept.sort());
	});

	it("rolls to a new file when the day turns, leaving yesterday intact", async () => {
		const paths = pathsFor();
		let clock = new Date("2026-03-14T23:59:59.000Z");

		const logger = createLogger(paths, { now: () => clock });
		logger.info("late yesterday");
		clock = new Date("2026-03-15T00:00:01.000Z");
		logger.info("early today");
		await Bun.sleep(50);

		expect(
			readFileSync(join(paths.logDir, "daemon-2026-03-14.log"), "utf8"),
		).toContain("late yesterday");
		expect(
			readFileSync(join(paths.logDir, "daemon-2026-03-15.log"), "utf8"),
		).toContain("early today");
	});

	it("prunes on the day roll, so a long-lived daemon never outgrows the window", () => {
		const paths = pathsFor();
		let clock = new Date("2026-03-14T09:00:00.000Z");
		const logger = createLogger(paths, { now: () => clock });

		const doomed = seedLog(paths.logDir, daysBefore(clock, 6));
		clock = new Date("2026-03-15T09:00:00.000Z");
		logger.info("next day");

		expect(readdirSync(paths.logDir)).not.toContain(doomed);
	});

	it("ignores files that are not dated daemon logs", () => {
		const paths = pathsFor();
		const now = new Date("2026-03-14T09:00:00.000Z");
		createLogger(paths, { now: () => now });
		writeFileSync(join(paths.logDir, "notes.txt"), "keep me");
		writeFileSync(join(paths.logDir, "daemon.log"), "legacy, undated");

		pruneLogs(paths.logDir, now);

		expect(readdirSync(paths.logDir).sort()).toEqual([
			"daemon-2026-03-14.log",
			"daemon.log",
			"notes.txt",
		]);
	});
});
