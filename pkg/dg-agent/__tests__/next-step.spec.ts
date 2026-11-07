import { describe, expect, it } from "bun:test";
import { startNotice } from "../src/next-step";

const SESSION = "11111111-1111-1111-1111-111111111111";

describe("startNotice", () => {
	it("names the paired agent and the first eight characters of the session id", () => {
		expect(startNotice({ agentIdentity: "claude-js", sessionId: SESSION }, true)).toBe(
			"Paired claude-js (11111111) with the browser extension.",
		);
	});

	it("points at the installer when no extension is linked", () => {
		expect(startNotice({ agentIdentity: "claude-js", sessionId: SESSION }, false)).toBe(
			"No browser extension is connected. Install it with: dg-skills install",
		);
	});
});
