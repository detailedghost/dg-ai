import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_IDLE_TTL_MS } from "../../src/server/idle-ttl";

describe("the idle window a daemon shuts itself down after", () => {
	it("is 24 hours, so one daemon outlives a working day of agents coming and going", () => {
		expect(DEFAULT_IDLE_TTL_MS).toBe(24 * 60 * 60 * 1000);
	});

	it("is still the fallback bootstrap reads DG_IDLE_TTL_MS against", () => {
		const bootstrap = readFileSync(
			join(import.meta.dir, "../../src/server/bootstrap.ts"),
			"utf8",
		);

		expect(bootstrap).toContain(
			'readEnvNumber(process.env, "DG_IDLE_TTL_MS", DEFAULT_IDLE_TTL_MS)',
		);
	});
});
