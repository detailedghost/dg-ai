import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as node from "@dg/common/node";
import {
	readSessionFiles,
	removeSessionToken,
	resolveDgPaths,
	writeSessionToken,
} from "@dg/common/node";
import { cleanupDgHome, freshDgHome } from "../utils/daemon-harness";

let dgHome: string;
const SESSION_ID = "session-tokens-1";

function record(token: string) {
	return {
		sessionId: SESSION_ID,
		token,
		cwd: "/tmp/some/repo",
		agentIdentity: "agent-1",
	};
}

beforeEach(() => {
	dgHome = freshDgHome();
});

afterEach(() => {
	cleanupDgHome(dgHome);
});

describe("writeSessionToken / readSessionFiles", () => {
	it("reads back the record just written", () => {
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const written = record("on-disk-token-abc");
		writeSessionToken(paths, SESSION_ID, written);

		expect(readSessionFiles(paths.sessionsDir)).toEqual([written]);
	});

	it("keeps the on-disk JSON shape equal to the record written", () => {
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const written = record("shape-check-token");
		writeSessionToken(paths, SESSION_ID, written);

		const onDisk = JSON.parse(
			readFileSync(`${paths.sessionsDir}/${SESSION_ID}.json`, "utf8"),
		);
		expect(onDisk).toEqual(written);
	});

	it("lists nothing once the record has been removed", () => {
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		writeSessionToken(paths, SESSION_ID, record("will-be-removed"));
		removeSessionToken(paths, SESSION_ID);

		expect(readSessionFiles(paths.sessionsDir)).toEqual([]);
	});

	it("no longer exports a single-token reader", () => {
		expect("readSessionToken" in node).toBe(false);
	});
});
