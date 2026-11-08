import { afterEach, describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import {
	checkPinnedOrigin,
	clearPinnedOrigin,
	getPinnedOrigin,
	isLocalPageOrigin,
	pinOriginIfUnset,
	requireLocalPageOrigin,
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
		expect(checkPinnedOrigin(paths, "moz-extension://aaaa")).toBe(true);
	});

	it("pins the first origin seen and refuses a later mismatch", () => {
		const paths = freshPaths();
		pinOriginIfUnset(paths, "moz-extension://aaaa");
		expect(getPinnedOrigin(paths)).toBe("moz-extension://aaaa");
		expect(checkPinnedOrigin(paths, "moz-extension://aaaa")).toBe(true);
		expect(checkPinnedOrigin(paths, "moz-extension://bbbb")).toBe(false);
	});

	it("never overwrites an existing pin with a later origin", () => {
		const paths = freshPaths();
		pinOriginIfUnset(paths, "moz-extension://aaaa");
		pinOriginIfUnset(paths, "moz-extension://bbbb");
		expect(getPinnedOrigin(paths)).toBe("moz-extension://aaaa");
	});

	it("clearing the pin lets a new origin pin, closing the reload/lockout gap", () => {
		const paths = freshPaths();
		pinOriginIfUnset(paths, "moz-extension://aaaa");

		clearPinnedOrigin(paths);

		expect(getPinnedOrigin(paths)).toBeUndefined();
		expect(checkPinnedOrigin(paths, "moz-extension://bbbb")).toBe(true);
		pinOriginIfUnset(paths, "moz-extension://bbbb");
		expect(getPinnedOrigin(paths)).toBe("moz-extension://bbbb");
	});

	it("clearing an already-unpinned config is a harmless no-op", () => {
		const paths = freshPaths();
		expect(() => clearPinnedOrigin(paths)).not.toThrow();
		expect(getPinnedOrigin(paths)).toBeUndefined();
	});
});

describe("isLocalPageOrigin", () => {
	const port = 47823;

	it("accepts http loopback hosts on the daemon port", () => {
		expect(isLocalPageOrigin(`http://127.0.0.1:${port}`, port)).toBe(true);
		expect(isLocalPageOrigin(`http://localhost:${port}`, port)).toBe(true);
	});

	it("refuses 127.0.0.1 and localhost on a mismatched port", () => {
		expect(isLocalPageOrigin(`http://127.0.0.1:${port + 1}`, port)).toBe(false);
		expect(isLocalPageOrigin(`http://localhost:${port + 1}`, port)).toBe(false);
		expect(isLocalPageOrigin("http://127.0.0.1", port)).toBe(false);
	});

	it("refuses a missing, malformed, https or foreign origin", () => {
		expect(isLocalPageOrigin(null, port)).toBe(false);
		expect(isLocalPageOrigin("not a url", port)).toBe(false);
		expect(isLocalPageOrigin(`https://127.0.0.1:${port}`, port)).toBe(false);
		expect(isLocalPageOrigin(`http://evil.example:${port}`, port)).toBe(false);
		expect(
			isLocalPageOrigin(`http://127.0.0.1.evil.example:${port}`, port),
		).toBe(false);
		expect(isLocalPageOrigin(`moz-extension://aaaa`, port)).toBe(false);
	});
});

describe("requireLocalPageOrigin", () => {
	const port = 47823;
	const origin = `http://127.0.0.1:${port}`;

	function gate(
		headers: Record<string, string>,
		query = "",
		live: (token: string) => boolean = (token) => token === "good",
		path = "/overwatch",
	) {
		const url = new URL(`http://127.0.0.1:${port}${path}${query}`);
		const seen: string[] = [];
		const result = requireLocalPageOrigin(
			new Request(url, { headers }),
			url,
			port,
			(token) => {
				seen.push(token);
				return live(token);
			},
		);
		return { result, seen };
	}

	async function expectRefused(result: Response | undefined, status: number) {
		expect(result?.status).toBe(status);
		expect(result?.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(await result?.text()).toBe("refused");
	}

	it("lets a Bearer token win over a different query token", () => {
		const { result, seen } = gate(
			{ origin, authorization: "Bearer good" },
			"?token=bad",
			undefined,
			"/ws",
		);

		expect(result).toBeUndefined();
		expect(seen).toEqual(["good"]);
	});

	it("accepts a query-only token on the WebSocket path", () => {
		const { result } = gate({ origin }, "?token=good", undefined, "/ws");

		expect(result).toBeUndefined();
	});

	it("refuses a query-only token on a fetch route with 403", async () => {
		const { result, seen } = gate({ origin }, "?token=good");

		await expectRefused(result, 403);
		expect(seen).toEqual([]);
	});

	it("accepts a request with no Origin and a live token", () => {
		const { result } = gate({ authorization: "Bearer good" });

		expect(result).toBeUndefined();
	});

	it("refuses a Bearer header with an empty token with 403", async () => {
		const { result } = gate({ origin, authorization: "Bearer " });

		await expectRefused(result, 403);
	});

	it("falls back to the query when Authorization is not Bearer", () => {
		const { result, seen } = gate(
			{ origin, authorization: "Basic good" },
			"?token=good",
			undefined,
			"/ws",
		);

		expect(result).toBeUndefined();
		expect(seen).toEqual(["good"]);
	});

	it("refuses a request with no token with 403", async () => {
		const { result } = gate({ origin });

		await expectRefused(result, 403);
	});

	it("refuses a stale token with 403", async () => {
		const { result } = gate({ origin, authorization: "Bearer stale" });

		await expectRefused(result, 403);
	});

	it("refuses a foreign Origin with 400 and never asks about the token", async () => {
		const { result, seen } = gate({
			origin: "https://evil.example",
			authorization: "Bearer good",
		});

		await expectRefused(result, 400);
		expect(seen).toEqual([]);
	});

	it("refuses a loopback Origin on the wrong port with 400", async () => {
		const { result, seen } = gate({
			origin: `http://127.0.0.1:${port + 1}`,
			authorization: "Bearer good",
		});

		await expectRefused(result, 400);
		expect(seen).toEqual([]);
	});
});
