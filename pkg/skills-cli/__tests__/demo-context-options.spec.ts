import { describe, expect, test } from "bun:test";
import { contextOptions } from "../src/demo/player-process";
import type { PlayerJob } from "../src/demo/player-job";

const job = (): PlayerJob => ({
	slug: "s",
	planPath: "/tmp/none",
	dir: "/tmp/none",
	startUrl: "https://example.test/",
	script: { title: "t", startUrl: "https://example.test/", steps: [] },
});

describe("contextOptions", () => {
	test("leaves the page CSP alone with and without recording", () => {
		expect(contextOptions(job(), true)).not.toHaveProperty("bypassCSP");
		expect(contextOptions(job(), false)).not.toHaveProperty("bypassCSP");
	});

	test("records video into the job dir only when asked", () => {
		expect(contextOptions(job(), true)).toMatchObject({
			screen: { width: 1440, height: 810 },
			deviceScaleFactor: 1,
			recordVideo: { size: { width: 1440, height: 810 } },
		});
		expect(contextOptions(job(), false)).not.toHaveProperty("recordVideo");
	});
});
