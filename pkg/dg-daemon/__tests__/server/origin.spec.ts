import { afterEach, describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import {
	checkPinnedOrigin,
	clearPinnedOrigin,
	getPinnedOrigin,
	pinOriginIfUnset,
} from "../../src/server/origin";
import { cleanupDgHome, freshDgHome } from "../utils/daemon-harness";

let dgHome: string;

afterEach(() => {
	cleanupDgHome(dgHome);
});

function freshPaths() {
	dgHome = freshDgHome();
	return resolveDgPaths({ env: { DG_HOME: dgHome } });
}

describe("pinned-origin lifecycle", () => {
	it("has nothing pinned on a fresh install, and admits any origin", () => {
		const paths = freshPaths();
		expect(getPinnedOrigin(paths)).toBeUndefined();
		expect(checkPinnedOrigin(paths, "chrome-extension://aaaa")).toBe(true);
	});

	it("pins the first origin seen and refuses a later mismatch", () => {
		const paths = freshPaths();
		pinOriginIfUnset(paths, "chrome-extension://aaaa");
		expect(getPinnedOrigin(paths)).toBe("chrome-extension://aaaa");
		expect(checkPinnedOrigin(paths, "chrome-extension://aaaa")).toBe(true);
		expect(checkPinnedOrigin(paths, "chrome-extension://bbbb")).toBe(false);
	});

	it("never overwrites an existing pin with a later origin", () => {
		const paths = freshPaths();
		pinOriginIfUnset(paths, "chrome-extension://aaaa");
		pinOriginIfUnset(paths, "chrome-extension://bbbb");
		expect(getPinnedOrigin(paths)).toBe("chrome-extension://aaaa");
	});

	it("clearing the pin lets a new origin pin, closing the reload/lockout gap", () => {
		const paths = freshPaths();
		pinOriginIfUnset(paths, "chrome-extension://aaaa");

		clearPinnedOrigin(paths);

		expect(getPinnedOrigin(paths)).toBeUndefined();
		expect(checkPinnedOrigin(paths, "chrome-extension://bbbb")).toBe(true);
		pinOriginIfUnset(paths, "chrome-extension://bbbb");
		expect(getPinnedOrigin(paths)).toBe("chrome-extension://bbbb");
	});

	it("clearing an already-unpinned config is a harmless no-op", () => {
		const paths = freshPaths();
		expect(() => clearPinnedOrigin(paths)).not.toThrow();
		expect(getPinnedOrigin(paths)).toBeUndefined();
	});
});
