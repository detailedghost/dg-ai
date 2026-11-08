import { describe, expect, it } from "bun:test";
import {
	DEFAULT_AGENT_GONE_MS,
	DEFAULT_CLI_REATTACH_GRACE_MS,
	isManuallyClearable,
	shouldReapSession,
	shouldReleaseClaim,
	type ClaimSnapshot,
	type ReapSnapshot,
} from "../../src/session/liveness";

const limits = { sessionTtlMs: 1_000, agentGoneMs: 400 };

function snapshot(overrides: Partial<ReapSnapshot> = {}): ReapSnapshot {
	return {
		state: "active",
		createdAt: 0,
		lastActivityAt: 0,
		cliAttached: false,
		exempt: false,
		...overrides,
	};
}

describe("shouldReapSession", () => {
	it("reaps an idle session once last activity is exactly ttl old", () => {
		expect(shouldReapSession(snapshot(), 1_000, limits)).toBe(true);
	});

	it("keeps an idle session one millisecond inside the ttl", () => {
		expect(shouldReapSession(snapshot(), 999, limits)).toBe(false);
		expect(
			shouldReapSession(snapshot({ lastActivityAt: 500 }), 1_499, limits),
		).toBe(false);
	});

	it("uses a one minute agent-gone grace", () => {
		expect(DEFAULT_AGENT_GONE_MS).toBe(60_000);
		expect(DEFAULT_CLI_REATTACH_GRACE_MS).toBe(24 * 60 * 60 * 1000);
	});

	it("does not reap a closed session", () => {
		expect(shouldReapSession(snapshot({ state: "closed" }), 10_000, limits)).toBe(
			false,
		);
	});

	it("does not reap a session with a live CLI or an explicit exemption", () => {
		expect(
			shouldReapSession(snapshot({ cliAttached: true }), 10_000, limits),
		).toBe(false);
		expect(shouldReapSession(snapshot({ exempt: true }), 10_000, limits)).toBe(
			false,
		);
	});

	it("reaps a detached CLI at the grace boundary even if activity was just touched", () => {
		expect(
			shouldReapSession(
				snapshot({ cliDetachedAt: 1_000, lastActivityAt: 1_400 }),
				1_400,
				limits,
			),
		).toBe(true);
		expect(
			shouldReapSession(
				snapshot({ cliDetachedAt: 1_000, lastActivityAt: 1_400 }),
				1_399,
				limits,
			),
		).toBe(false);
	});
});

function claim(overrides: Partial<ClaimSnapshot> = {}): ClaimSnapshot {
	return {
		cliAttached: true,
		cliQuietSince: 500,
		socketOpen: false,
		...overrides,
	};
}

describe("shouldReleaseClaim", () => {
	const graceMs = 1_000;

	it("keeps a claim that still has an open socket or was never quiet", () => {
		expect(shouldReleaseClaim(claim({ socketOpen: true }), 10_000, graceMs)).toBe(
			false,
		);
		expect(shouldReleaseClaim(claim({ cliAttached: false }), 10_000, graceMs)).toBe(
			false,
		);
		expect(
			shouldReleaseClaim(claim({ cliQuietSince: undefined }), 10_000, graceMs),
		).toBe(false);
	});

	it("releases at the grace boundary measured from the quiet clock", () => {
		expect(shouldReleaseClaim(claim(), 1_499, graceMs)).toBe(false);
		expect(shouldReleaseClaim(claim(), 1_500, graceMs)).toBe(true);
		expect(
			shouldReleaseClaim(claim({ cliQuietSince: 10 }), 10, 0),
		).toBe(true);
	});
});

describe("isManuallyClearable", () => {
	it("clears idle and agent-gone sessions", () => {
		expect(
			isManuallyClearable({
				state: "active",
				cliAttached: false,
			}),
		).toBe(true);
	});

	it("leaves a session a live CLI is driving", () => {
		expect(
			isManuallyClearable({
				state: "active",
				cliAttached: true,
			}),
		).toBe(false);
	});

	it("does not clear a session that is already closed", () => {
		expect(
			isManuallyClearable({
				state: "closed",
				cliAttached: false,
			}),
		).toBe(false);
	});
});
