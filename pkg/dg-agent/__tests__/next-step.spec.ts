import { describe, expect, it } from "bun:test";
import { cliNextStep } from "../src/next-step";

const SESSION = "11111111-1111-1111-1111-111111111111";
const TOKEN = "session-token-must-not-appear";

describe("cliNextStep", () => {
	it("tells a new session to pair from the DeeGee popup", () => {
		const line = cliNextStep(SESSION);
		expect(line).toContain(`session ${SESSION} is ready`);
		expect(line).toContain("open the DeeGee popup and run dg-agent pair <code>");
		expect(line).not.toContain("side panel");
		expect(line).not.toContain(TOKEN);
	});
});
