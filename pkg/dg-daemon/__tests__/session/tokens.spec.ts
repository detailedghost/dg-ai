import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	readSessionToken,
	removeSessionToken,
	resolveDgPaths,
	writeSessionToken,
} from "@dg/common/node";
import { cleanupDgHome, freshDgHome } from "../utils/daemon-harness";

let dgHome: string;
const SESSION_ID = "session-tokens-1";

beforeEach(() => {
	dgHome = freshDgHome();
});

afterEach(() => {
	delete process.env.DG_SESSION_TOKEN;
	cleanupDgHome(dgHome);
});

describe("writeSessionToken / readSessionToken", () => {
	it("reads back the exact token just written, with no override set", () => {
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		writeSessionToken(paths, SESSION_ID, {
			sessionId: SESSION_ID,
			token: "on-disk-token-abc",
			cwd: "/tmp/some/repo",
			agentIdentity: "agent-1",
		});

		expect(readSessionToken(paths, SESSION_ID)).toBe("on-disk-token-abc");
	});

	it("DG_SESSION_TOKEN overrides the on-disk file when both are present", () => {
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		writeSessionToken(paths, SESSION_ID, {
			sessionId: SESSION_ID,
			token: "on-disk-token-xyz",
			cwd: "/tmp/some/repo",
			agentIdentity: "agent-1",
		});
		process.env.DG_SESSION_TOKEN = "override-token-123";

		expect(readSessionToken(paths, SESSION_ID)).toBe("override-token-123");
	});

	it("DG_SESSION_TOKEN is honored even with no on-disk file at all", () => {
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		process.env.DG_SESSION_TOKEN = "override-only-token";

		expect(readSessionToken(paths, SESSION_ID)).toBe("override-only-token");
	});

	it("the on-disk JSON shape matches exactly what writeSessionToken emitted — the object the CLI must parse", () => {
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const record = {
			sessionId: SESSION_ID,
			token: "shape-check-token",
			cwd: "/tmp/shape/repo",
			agentIdentity: "agent-shape",
		};
		writeSessionToken(paths, SESSION_ID, record);

		const onDisk = JSON.parse(
			readFileSync(`${paths.sessionsDir}/${SESSION_ID}.json`, "utf8"),
		);
		expect(onDisk).toEqual(record);
	});

	it("readSessionToken throws once the record has been removed and no override is set", () => {
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		writeSessionToken(paths, SESSION_ID, {
			sessionId: SESSION_ID,
			token: "will-be-removed",
			cwd: "/tmp/some/repo",
			agentIdentity: "agent-1",
		});
		removeSessionToken(paths, SESSION_ID);

		expect(() => readSessionToken(paths, SESSION_ID)).toThrow();
	});
});
