import { describe, expect, it } from "bun:test";
import {
	BATCH_MAX_AGE_MS,
	BATCH_MAX_SKEW_MS,
	batchIssuedAt,
	DEMO_MARKER_KEY,
	EDIT_MARKER_KEY,
	isBatchFresh,
	MARKER_BATCH_KEY,
	MARKER_KEY,
	MARKER_POS_KEY,
	newBatchId,
	PROTO_MARKER_KEY,
} from "../src/index";

describe("URL-fragment marker keys", () => {
	it("are the fixed keys the CLI writes and the extension reads", () => {
		expect(MARKER_KEY).toBe("_tab_group");
		expect(MARKER_POS_KEY).toBe("_tab_group_pos");
		expect(MARKER_BATCH_KEY).toBe("_tab_group_batch");
		expect(DEMO_MARKER_KEY).toBe("_demo");
		expect(EDIT_MARKER_KEY).toBe("_edit");
		expect(PROTO_MARKER_KEY).toBe("_proto");
	});
});

describe("batch ids", () => {
	const now = Date.parse("2026-10-29T12:00:00Z");

	it("round-trips the issue time", () => {
		expect(batchIssuedAt(newBatchId(now))).toBe(now);
	});

	it("returns undefined for a missing or malformed id", () => {
		expect(batchIssuedAt(undefined)).toBeUndefined();
		expect(batchIssuedAt("b1")).toBeUndefined();
		expect(batchIssuedAt("NOT-A-BATCH")).toBeUndefined();
	});

	it("is fresh up to the window edge and stale one millisecond past it", () => {
		const batch = newBatchId(now);
		expect(isBatchFresh(batch, now + BATCH_MAX_AGE_MS)).toBe(true);
		expect(isBatchFresh(batch, now + BATCH_MAX_AGE_MS + 1)).toBe(false);
	});

	it("allows a future issue time only within the clock-skew allowance", () => {
		const batch = newBatchId(now + BATCH_MAX_SKEW_MS);
		expect(isBatchFresh(batch, now)).toBe(true);
		expect(isBatchFresh(newBatchId(now + BATCH_MAX_SKEW_MS + 1), now)).toBe(
			false,
		);
		expect(isBatchFresh(newBatchId(now + BATCH_MAX_AGE_MS), now)).toBe(false);
	});

	it("is stale when missing or unparseable", () => {
		expect(isBatchFresh(undefined, now)).toBe(false);
		expect(isBatchFresh("b1", now)).toBe(false);
	});
});
