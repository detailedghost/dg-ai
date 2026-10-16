import { describe, expect, it } from "bun:test";
import { emitRedacted } from "@dg/common";

const TOKEN = "agent-log-token-must-stay-out";

describe("dg-agent failure log", () => {
	it("redacts a secret that would otherwise be printed on stderr", () => {
		const lines: string[] = [];
		emitRedacted(
			(line) => lines.push(line),
			`dg-agent: could not start ${TOKEN} DG_SESSION_TOKEN=${TOKEN}`,
			[TOKEN],
		);
		expect(lines[0]).not.toContain(TOKEN);
		expect(lines[0]).toContain("dg-agent:");
		expect(lines[0]).toContain("[redacted]");
	});
});