import { afterEach, describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import { SessionRegistry } from "../../src/session/registry";
import {
	cleanupDgHome,
	freshDgHome,
	freshTempDir,
} from "../utils/daemon-harness";

let dgHome: string;

afterEach(() => {
	cleanupDgHome(dgHome);
});

function makeRegistry(): SessionRegistry {
	dgHome = freshDgHome();
	return new SessionRegistry(resolveDgPaths({ env: { DG_HOME: dgHome } }));
}

function createSession(registry: SessionRegistry) {
	return registry.create({
		cwd: freshTempDir("dg-live-cwd"),
		agentIdentity: "test-agent",
		role: "agent",
	});
}

describe("SessionRegistry.tokenIsLive", () => {
	it("is true for the token of an active session", () => {
		const registry = makeRegistry();
		const session = createSession(registry);

		expect(registry.tokenIsLive(session.token)).toBe(true);
	});

	it("turns false once the session closes", () => {
		const registry = makeRegistry();
		const session = createSession(registry);

		registry.close(session.sessionId, "cli");

		expect(registry.tokenIsLive(session.token)).toBe(false);
	});

	it("stays true for a second session after the first one closes", () => {
		const registry = makeRegistry();
		const first = createSession(registry);
		const second = createSession(registry);

		registry.close(first.sessionId, "cli");

		expect(registry.tokenIsLive(first.token)).toBe(false);
		expect(registry.tokenIsLive(second.token)).toBe(true);
	});

	it("is false for an empty token", () => {
		const registry = makeRegistry();
		createSession(registry);

		expect(registry.tokenIsLive("")).toBe(false);
	});

	it("is false, without throwing, for tokens of a different length", () => {
		const registry = makeRegistry();
		const session = createSession(registry);

		expect(registry.tokenIsLive(session.token.slice(0, -1))).toBe(false);
		expect(registry.tokenIsLive(`${session.token}x`)).toBe(false);
	});
});
