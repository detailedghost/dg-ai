import { describe, expect, test } from "bun:test";
import path from "node:path";
import { scratchRoot, stateRoot } from "@dg/common/node";
import {
	defaultOutputDir,
	logPathFor,
	recordPath,
	runtimeDir,
	socketPathFor,
} from "../../src/pw/core/registry";
import { statesDir } from "../../src/pw/core/states";
import { useTempEnv, useTempScratch } from "../../src/pw/test-support";

const scratch = useTempScratch();
const state = useTempEnv("AI_STATE_DIR");

describe("runtimeDir", () => {
	test.each(["sessions", "sock", "log"] as const)(
		"keeps %s under the shared pw scratch directory",
		(kind) => {
			expect(runtimeDir(kind)).toBe(path.join(scratchRoot(), "pw", kind));
			expect(runtimeDir(kind).startsWith(scratch.dir)).toBe(true);
		},
	);
});

describe("defaultOutputDir", () => {
	test("is a per-cwd directory directly under the pw scratch directory", () => {
		const dir = defaultOutputDir();
		expect(path.dirname(dir)).toBe(path.join(scratchRoot(), "pw"));
		expect(path.basename(dir)).not.toBe("sessions");
	});
});

describe("statesDir", () => {
	test("keeps saved states under the shared pw state directory", () => {
		expect(statesDir()).toBe(path.join(stateRoot(), "pw", "states"));
		expect(statesDir().startsWith(state.dir)).toBe(true);
	});
});

describe("session key paths", () => {
	test.each(["../x", "a/b", "..", "a..b/c", "", "-x"])(
		"reject the key %p",
		(key) => {
			expect(() => recordPath(key)).toThrow("Invalid session key");
			expect(() => socketPathFor(key)).toThrow("Invalid session key");
			expect(() => logPathFor(key)).toThrow("Invalid session key");
		},
	);

	test("accept a scratch-scoped key", () => {
		expect(path.basename(recordPath("gh@1a2b"))).toBe("gh@1a2b.json");
	});
});
