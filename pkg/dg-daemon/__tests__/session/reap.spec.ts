import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { SessionRegistry } from "../../src/session/registry";
import {
	cleanupDgHome,
	freshDgHome,
	freshTempDir,
} from "../utils/daemon-harness";

const CLOSED_RECORD_RETENTION_MS = 10 * 60 * 1000;

let dgHome: string;

afterEach(() => {
	cleanupDgHome(dgHome);
});

function makeRegistry(now: () => number): {
	paths: DgPaths;
	registry: SessionRegistry;
} {
	dgHome = freshDgHome();
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	return { paths, registry: new SessionRegistry(paths, { now }) };
}

function createSession(registry: SessionRegistry) {
	return registry.create({
		cwd: freshTempDir("dg-reap-cwd"),
		agentIdentity: "test-agent",
		role: "agent",
	});
}

function tokenFilePath(paths: DgPaths, sessionId: string): string {
	return `${paths.sessionsDir}/${sessionId}.json`;
}

describe("SessionRegistry activity tracking", () => {
	it("stamps a freshly created session's lastActivityAt to createdAt via the injected now seam", () => {
		const clock = { at: 1_000 };
		const { registry } = makeRegistry(() => clock.at);
		const session = createSession(registry);
		expect(session.createdAt).toBe(1_000);
		expect(session.lastActivityAt).toBe(1_000);
	});

	it("touch() refreshes lastActivityAt on an active session", () => {
		const clock = { at: 0 };
		const { registry } = makeRegistry(() => clock.at);
		const session = createSession(registry);
		clock.at = 5_000;
		registry.touch(session.sessionId);
		expect(registry.get(session.sessionId)?.lastActivityAt).toBe(5_000);
	});

	it("touch() is a no-op for a sessionId the registry has never seen", () => {
		const { registry } = makeRegistry(() => 0);
		expect(() => registry.touch("session-never-registered")).not.toThrow();
	});

	it("touch() does not revive a closed session's lastActivityAt", () => {
		const clock = { at: 0 };
		const { registry } = makeRegistry(() => clock.at);
		const session = createSession(registry);
		registry.close(session.sessionId, "cli");
		clock.at = 9_000;
		registry.touch(session.sessionId);
		expect(registry.get(session.sessionId)?.lastActivityAt).toBe(0);
	});
});

describe("SessionRegistry#reapExpired", () => {
	it("closes an active session once its last activity is at least ttlMs old", () => {
		const clock = { at: 0 };
		const { registry } = makeRegistry(() => clock.at);
		const session = createSession(registry);
		clock.at = 1_000;

		const reaped = registry.reapExpired(1_000, () => false);

		expect(reaped).toEqual([session.sessionId]);
		expect(registry.get(session.sessionId)?.state).toBe("closed");
		expect(registry.activeCount()).toBe(0);
	});

	it("leaves a session below the TTL threshold untouched", () => {
		const clock = { at: 0 };
		const { registry } = makeRegistry(() => clock.at);
		const session = createSession(registry);
		clock.at = 999;

		const reaped = registry.reapExpired(1_000, () => false);

		expect(reaped).toEqual([]);
		expect(registry.get(session.sessionId)?.state).toBe("active");
		expect(registry.activeCount()).toBe(1);
	});

	it("does not reap a session the isExempt predicate names, e.g. one with a live page socket", () => {
		const clock = { at: 0 };
		const { registry } = makeRegistry(() => clock.at);
		const session = createSession(registry);
		clock.at = 10_000;

		const reaped = registry.reapExpired(
			1_000,
			(sessionId) => sessionId === session.sessionId,
		);

		expect(reaped).toEqual([]);
		expect(registry.get(session.sessionId)?.state).toBe("active");
	});

	it("a fresh touch() postpones reaping past the original TTL window", () => {
		const clock = { at: 0 };
		const { registry } = makeRegistry(() => clock.at);
		const session = createSession(registry);
		clock.at = 900;
		registry.touch(session.sessionId);
		clock.at = 1_500;

		const reaped = registry.reapExpired(1_000, () => false);

		expect(reaped).toEqual([]);
		expect(registry.get(session.sessionId)?.state).toBe("active");
	});

	it("removes the on-disk session token file for a reaped session, exactly like an explicit close", () => {
		const clock = { at: 0 };
		const { paths, registry } = makeRegistry(() => clock.at);
		const session = createSession(registry);
		expect(existsSync(tokenFilePath(paths, session.sessionId))).toBe(true);
		clock.at = 10_000;

		registry.reapExpired(1_000, () => false);

		expect(existsSync(tokenFilePath(paths, session.sessionId))).toBe(false);
	});

	it("invalidates a reaped session's capability token", () => {
		const clock = { at: 0 };
		const { registry } = makeRegistry(() => clock.at);
		const session = createSession(registry);
		clock.at = 10_000;

		registry.reapExpired(1_000, () => false);

		expect(registry.validate(session.sessionId, session.token)).toBe(false);
	});

	it("unblocks activeCount() once the only session is reaped", () => {
		const clock = { at: 0 };
		const { registry } = makeRegistry(() => clock.at);
		createSession(registry);
		expect(registry.activeCount()).toBe(1);
		clock.at = 10_000;

		registry.reapExpired(1_000, () => false);

		expect(registry.activeCount()).toBe(0);
	});

	it("still resolves a just-reaped session via get(), distinguishable from an unknown sessionId", () => {
		const clock = { at: 0 };
		const { registry } = makeRegistry(() => clock.at);
		const session = createSession(registry);
		clock.at = 1_000;

		registry.reapExpired(1_000, () => false);

		expect(registry.get(session.sessionId)?.state).toBe("closed");
		expect(registry.get("session-never-registered")).toBeUndefined();
	});

	it("does not evict a closed record before the retention window elapses", () => {
		const clock = { at: 0 };
		const { registry } = makeRegistry(() => clock.at);
		const session = createSession(registry);
		registry.close(session.sessionId, "cli");
		clock.at = CLOSED_RECORD_RETENTION_MS - 1;

		registry.reapExpired(24 * 60 * 60 * 1000, () => false);

		expect(registry.get(session.sessionId)).toBeDefined();
	});

	it("keeps a claimed session through a quiet gap and releases the claim once", () => {
		const clock = { at: 0 };
		const { registry } = makeRegistry(() => clock.at);
		const session = createSession(registry);
		const gone: string[] = [];
		registry.on("agent-gone", (event: { sessionId: string }) => {
			gone.push(event.sessionId);
		});
		registry.noteCliAttached(session.sessionId);
		registry.noteCliQuiet(session.sessionId);
		clock.at = 999;

		expect(
			registry.reapExpired(60_000, () => false, {
				reattachGraceMs: 1_000,
				agentGoneMs: 400,
			}),
		).toEqual([]);
		expect(registry.get(session.sessionId)?.cliAttached).toBe(true);
		expect(gone).toEqual([]);

		clock.at = 1_000;
		expect(
			registry.reapExpired(60_000, () => false, {
				reattachGraceMs: 1_000,
				agentGoneMs: 400,
			}),
		).toEqual([]);
		expect(registry.get(session.sessionId)?.cliAttached).toBe(false);
		expect(registry.get(session.sessionId)?.state).toBe("active");
		expect(gone).toEqual([session.sessionId]);

		clock.at = 1_399;
		registry.reapExpired(60_000, () => false, {
			reattachGraceMs: 1_000,
			agentGoneMs: 400,
		});
		expect(registry.get(session.sessionId)?.state).toBe("active");
		expect(gone).toEqual([session.sessionId]);

		clock.at = 1_400;
		expect(
			registry.reapExpired(60_000, () => false, {
				reattachGraceMs: 1_000,
				agentGoneMs: 400,
			}),
		).toEqual([session.sessionId]);
		expect(gone).toEqual([session.sessionId]);
	});

	it("clears the quiet clock when the CLI reattaches, so the gap does not accumulate", () => {
		const clock = { at: 0 };
		const { registry } = makeRegistry(() => clock.at);
		const session = createSession(registry);
		registry.noteCliAttached(session.sessionId);
		registry.noteCliQuiet(session.sessionId);
		clock.at = 900;
		registry.noteCliAttached(session.sessionId);
		clock.at = 5_000;

		registry.reapExpired(60_000, () => false, {
			reattachGraceMs: 1_000,
			agentGoneMs: 0,
		});

		expect(registry.get(session.sessionId)?.state).toBe("active");
		expect(registry.get(session.sessionId)?.cliAttached).toBe(true);
		expect(registry.get(session.sessionId)?.cliQuietSince).toBeUndefined();
	});

	it("does not release a claim while a CLI socket is still open", () => {
		const clock = { at: 0 };
		const { registry } = makeRegistry(() => clock.at);
		const session = createSession(registry);
		registry.noteCliAttached(session.sessionId);
		registry.noteCliQuiet(session.sessionId);
		clock.at = 5_000;

		registry.reapExpired(60_000, () => true, {
			reattachGraceMs: 1_000,
			agentGoneMs: 0,
		});

		expect(registry.get(session.sessionId)?.cliAttached).toBe(true);
	});

	it("evicts a closed record once a later sweep finds it past the retention window", () => {
		const clock = { at: 0 };
		const { registry } = makeRegistry(() => clock.at);
		const session = createSession(registry);
		registry.close(session.sessionId, "cli");
		clock.at = CLOSED_RECORD_RETENTION_MS + 1;

		registry.reapExpired(24 * 60 * 60 * 1000, () => false);

		expect(registry.get(session.sessionId)).toBeUndefined();
	});
});
