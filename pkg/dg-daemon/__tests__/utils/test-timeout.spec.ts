import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const HEALTH_BUDGET_MS = 3000;

describe("bunfig test timeout", () => {
	it("outlasts one full daemon boot attempt plus a retry under load", async () => {
		const bunfig = await Bun.file(
			join(import.meta.dir, "../../bunfig.toml"),
		).text();
		const timeout = Number(/^timeout\s*=\s*(\d+)/m.exec(bunfig)?.[1]);
		expect(timeout).toBeGreaterThan(HEALTH_BUDGET_MS * 2);
	});
});
