import { describe, expect, test } from "bun:test";
import { protoCliHarness } from "./proto-cli-harness";

describe("proto --ext connect error", () => {
	test("tells the agent to start a session and install the extension, with no /start URL", async () => {
		const h = protoCliHarness();
		try {
			const result = await h.run(
				["scrape", "https://example.test/account", "--session", "no-such-session"],
				{},
				{ timeoutMs: 5000 },
			);

			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("Run dg-agent start.");
			expect(result.stderr).not.toContain("/start");
			expect(result.stderr).not.toContain("#_chat=");
		} finally {
			h.cleanup();
		}
	}, 8000);
});
