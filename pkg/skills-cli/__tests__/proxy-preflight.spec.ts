import { describe, expect, test } from "bun:test";
import type { Backend } from "../src/proxy/backends/types";
import { checkPreflight } from "../src/proxy/preflight";

// checkPreflight only consults PATH via Bun.which — no process is spawned,
// so real (but harmless) binary names are safe fixtures here.
const REAL_BIN = "sh";
const MISSING_BIN = "definitely-not-a-real-binary-xyz123";

function makeBackend(overrides: Partial<Backend> = {}): Backend {
	return {
		bin: MISSING_BIN,
		buildArgs: () => [],
		parseEvents: () => ({ sessionId: null, message: "" }),
		install: {
			hint: "install it",
			command: "brew install thing",
			url: "https://example.com/install",
		},
		...overrides,
	};
}

describe("checkPreflight", () => {
	test("reports available when the backend bin resolves on PATH", () => {
		const result = checkPreflight("mybackend", makeBackend({ bin: REAL_BIN }));
		expect(result).toEqual({ available: true });
	});

	test("reports unavailable with missing details when the bin is not on PATH", () => {
		const backend = makeBackend({ bin: MISSING_BIN });
		const result = checkPreflight("mybackend", backend);

		expect(result.available).toBe(false);
		expect(result.missing).toEqual({
			backend: "mybackend",
			bin: MISSING_BIN,
			installHint: backend.install.hint,
			installCommand: backend.install.command,
			installUrl: backend.install.url,
		});
	});

	test("omits installUrl when the backend has no install.url", () => {
		const backend = makeBackend({
			bin: MISSING_BIN,
			install: { hint: "install it", command: "brew install thing" },
		});
		const result = checkPreflight("mybackend", backend);

		expect(result.missing?.installUrl).toBeUndefined();
	});

	test("threads the given backendName into the missing report untouched", () => {
		const result = checkPreflight("some-other-name", makeBackend({ bin: MISSING_BIN }));
		expect(result.missing?.backend).toBe("some-other-name");
	});
});
