import { describe, expect, test } from "bun:test";
import { list } from "../../../src/pw/core/registry";
import { argsFor, clientEnv, startFakeDaemon, useTempScratch } from "../../../src/pw/test-support";
import handler from "../../../src/pw/commands/close-all/run";
import spec from "../../../src/pw/commands/close-all/spec";

useTempScratch();

describe("close-all", () => {
	test("reports when nothing is open", async () => {
		const env = clientEnv();
		expect(await handler(argsFor(spec), env)).toBe(0);
		expect(env.stdout).toEqual(["### No open browsers."]);
	});

	test("stops every daemon and empties the registry", async () => {
		const a = await startFakeDaemon("alpha");
		const b = await startFakeDaemon("beta@abc12345");
		const env = clientEnv();
		try {
			expect(await handler(argsFor(spec), env)).toBe(0);
			expect(env.stdout[0]).toBe("### Browser `alpha` closed.\n### Browser `beta@abc12345` closed.");
			expect(list()).toEqual([]);
		} finally {
			a.dispose();
			b.dispose();
		}
	});
});
