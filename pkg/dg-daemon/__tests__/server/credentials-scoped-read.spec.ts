import { describe, expect, it } from "bun:test";
import {
	hasCredentialGrant,
	NOT_ALLOWED,
	scopedRead,
} from "../../src/server/credentials";

type Entry = { name: string; meta: Record<string, unknown>; updatedAt: string };

function storeOf(entries: Record<string, string>) {
	const stamp = "2030-01-01T00:00:00.000Z";
	return {
		listCredentials: (): Entry[] =>
			Object.keys(entries).map((name) => ({
				name,
				meta: {},
				updatedAt: stamp,
			})),
		getCredential: (name: string) =>
			name in entries
				? { value: entries[name], meta: {}, updatedAt: stamp }
				: undefined,
	};
}

const STORE = storeOf({
	"a/x": "value-a-x",
	"a/y": "value-a-y",
	"ab/x": "value-ab-x",
	"b/z": "value-b-z",
});

describe("scopedRead", () => {
	it("lists only the names below the prefix and never a value", () => {
		const answer = scopedRead({ operation: "list" }, "a", STORE);
		expect(answer.ok).toBe(true);
		const names = (answer as { value: Entry[] }).value.map((e) => e.name);
		expect(names).toEqual(["a/x", "a/y"]);
		expect(JSON.stringify(answer)).not.toContain("value-");
	});

	it("lists an empty array when nothing sits below the prefix", () => {
		expect(scopedRead({ operation: "list" }, "none", STORE)).toEqual({
			ok: true,
			value: [],
		});
	});

	it("gets a stored name below the prefix", () => {
		expect(
			scopedRead({ operation: "get", name: "a/x" }, "a", STORE),
		).toMatchObject({ ok: true, value: { value: "value-a-x" } });
	});

	it("gets null for an absent name below the prefix", () => {
		expect(
			scopedRead({ operation: "get", name: "a/missing" }, "a", STORE),
		).toEqual({ ok: true, value: null });
	});

	it("refuses a name outside the prefix with the shared NOT_ALLOWED text", () => {
		for (const name of ["ab/x", "b/z", "a"])
			expect(scopedRead({ operation: "get", name }, "a", STORE)).toEqual({
				ok: false,
				error: NOT_ALLOWED,
			});
		expect(NOT_ALLOWED).toBe("Credential request not allowed for this caller.");
	});
});

describe("hasCredentialGrant", () => {
	const store = {
		verifyCredentialGrant: (prefix: string, token: string) =>
			prefix === "a" && token === "good-token",
	};
	const request = (headers: Record<string, string>) =>
		new Request("http://127.0.0.1/x", { headers });

	it("accepts a verified prefix and token pair", () => {
		expect(
			hasCredentialGrant(
				request({ "X-Dg-Grant-Prefix": "a", "X-Dg-Grant-Token": "good-token" }),
				store as never,
			),
		).toBe(true);
	});

	it("refuses a missing header, a wrong token and a request that also carries a session id", () => {
		const refused: Record<string, string>[] = [
			{ "X-Dg-Grant-Prefix": "a" },
			{ "X-Dg-Grant-Token": "good-token" },
			{ "X-Dg-Grant-Prefix": "a", "X-Dg-Grant-Token": "bad" },
			{
				"X-Dg-Grant-Prefix": "a",
				"X-Dg-Grant-Token": "good-token",
				"X-Dg-Session-Id": "s",
			},
		];
		for (const headers of refused)
			expect(hasCredentialGrant(request(headers), store as never)).toBe(false);
	});
});

describe("sealed pw/ names", () => {
	it("refuses a grant-scoped read of a pw/ value, also for a grant on pw, with no value in the error", () => {
		const store = storeOf({ "pw/live.com/owa-auth": "fake-marker-value-for-tests" });
		const answer = scopedRead({ operation: "get", name: "pw/live.com/owa-auth" }, "pw", store);
		expect(answer).toMatchObject({ ok: false });
		expect(JSON.stringify(answer)).not.toContain("fake-marker-value-for-tests");
		expect(JSON.stringify(scopedRead({ operation: "list" }, "pw", store))).not.toContain("fake-marker-value-for-tests");
	});
});
