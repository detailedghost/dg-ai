import { describe, expect, it } from "bun:test";
import { cliNextStep } from "../src/next-step";

const SESSION = "11111111-1111-1111-1111-111111111111";
const TOKEN = "session-token-must-not-appear";

describe("cliNextStep", () => {
	it("tells a new session to connect from the side panel", () => {
		const line = cliNextStep("registered", SESSION);
		expect(line).toBe(
			`dg-agent: session ${SESSION} is ready. Next: open the extension side panel and choose Connect.`,
		);
		expect(line).not.toContain(TOKEN);
	});

	it("tells a claimed waiting session to recv", () => {
		expect(cliNextStep("claimed", SESSION)).toBe(
			`dg-agent: attached to the session the extension is waiting on (${SESSION}). Next: dg-agent recv --block.`,
		);
	});

	it("tells an attach to recv and to connect in the panel", () => {
		expect(cliNextStep("attached", SESSION)).toContain("dg-agent recv --block");
		expect(cliNextStep("attached", SESSION)).toContain("choose Connect");
		expect(cliNextStep("attached", SESSION)).not.toContain(TOKEN);
	});
});
