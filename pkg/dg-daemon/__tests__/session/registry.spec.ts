import { afterEach, describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import { SessionRegistry } from "../../src/session/registry";
import {
	cleanupDgHome,
	freshDgHome,
	freshTempDir,
	removeScratchDirs,
} from "../utils/daemon-harness";

let dgHome: string;

afterEach(() => {
	removeScratchDirs();
	cleanupDgHome(dgHome);
});

function setup() {
	dgHome = freshDgHome();
	const registry = new SessionRegistry(
		resolveDgPaths({ env: { DG_HOME: dgHome } }),
	);
	const session = registry.create({
		cwd: freshTempDir("dg-registry-cwd"),
		agentIdentity: "test-agent",
		role: "agent",
	});
	const changed: { sessionId: string }[] = [];
	registry.on("changed", (event) => changed.push(event));
	return { registry, session, changed };
}

describe("SessionRegistry presence changes emit changed", () => {
	it("emits one changed event per noteCliAttached call on an active session", () => {
		const { registry, session, changed } = setup();

		registry.noteCliAttached(session.sessionId);

		expect(changed).toEqual([{ sessionId: session.sessionId }]);
	});

	it("emits nothing from noteCliAttached for an unknown session", () => {
		const { registry, changed } = setup();

		registry.noteCliAttached("no-such-session");

		expect(changed).toEqual([]);
	});

	it("emits nothing from noteCliAttached once the session is closed", () => {
		const { registry, session, changed } = setup();
		registry.close(session.sessionId, "cli");
		changed.length = 0;

		registry.noteCliAttached(session.sessionId);

		expect(changed).toEqual([]);
	});

	it("emits one changed event when the last CLI socket goes quiet", () => {
		const { registry, session, changed } = setup();
		registry.noteCliAttached(session.sessionId);
		changed.length = 0;

		registry.noteCliQuiet(session.sessionId);

		expect(changed).toEqual([{ sessionId: session.sessionId }]);
	});

	it("emits nothing from noteCliQuiet when the session is already quiet", () => {
		const { registry, session, changed } = setup();
		registry.noteCliAttached(session.sessionId);
		registry.noteCliQuiet(session.sessionId);
		changed.length = 0;

		registry.noteCliQuiet(session.sessionId);

		expect(changed).toEqual([]);
	});

	it("emits nothing from noteCliQuiet when no CLI ever attached", () => {
		const { registry, session, changed } = setup();

		registry.noteCliQuiet(session.sessionId);

		expect(changed).toEqual([]);
	});

	it("emits nothing from noteCliQuiet for an unknown or closed session", () => {
		const { registry, session, changed } = setup();
		registry.noteCliAttached(session.sessionId);
		registry.close(session.sessionId, "cli");
		changed.length = 0;

		registry.noteCliQuiet(session.sessionId);
		registry.noteCliQuiet("no-such-session");

		expect(changed).toEqual([]);
	});

	it("emits one changed event when the CLI detaches", () => {
		const { registry, session, changed } = setup();
		registry.noteCliAttached(session.sessionId);
		changed.length = 0;

		registry.noteCliDetached(session.sessionId);

		expect(changed).toEqual([{ sessionId: session.sessionId }]);
	});

	it("emits nothing from noteCliDetached when no CLI is attached or the session is unknown", () => {
		const { registry, session, changed } = setup();

		registry.noteCliDetached(session.sessionId);
		registry.noteCliDetached("no-such-session");

		expect(changed).toEqual([]);
	});

	it("emits nothing from noteCliDetached a second time after the CLI already detached", () => {
		const { registry, session, changed } = setup();
		registry.noteCliAttached(session.sessionId);
		registry.noteCliDetached(session.sessionId);
		changed.length = 0;

		registry.noteCliDetached(session.sessionId);

		expect(changed).toEqual([]);
	});
});
