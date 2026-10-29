import { describe, expect, test } from "bun:test";
import { parseManifest, type VerifyManifest } from "../src/verify/manifest";
import { looksSecret } from "../src/verify/urls";

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "review",
		stackUrl: "http://127.0.0.1:3000/",
		items: [
			{
				id: "home",
				title: "Home",
				owner: "dg:implementer",
				beforeUrl: "http://127.0.0.1:4001/",
				afterUrl: "http://127.0.0.1:4002/",
				roles: [{ id: "admin", headers: { "x-seed-role": "admin" } }],
			},
		],
		...overrides,
	};
}

describe("parse manifest", () => {
	test("fills the default menu selector and keeps seed headers", () => {
		const manifest = parseManifest(raw());
		expect(manifest.name).toBe("review");
		expect(manifest.items[0]?.menuSelector).toBe("[data-verify-menu]");
		expect(manifest.items[0]?.roles[0]?.headers).toEqual({ "x-seed-role": "admin" });
		expect(manifest.items[0]?.roles[0]?.cookies).toEqual([]);
	});

	test("accepts a loopback https url and an optional prototype target", () => {
		const manifest = parseManifest(
			raw({
				stackUrl: "https://localhost:8443/app",
				items: [
					{
						...(raw().items as Record<string, unknown>[])[0],
						targetUrl: "http://[::1]:4321/?variant=A",
						beforeRef: "master",
						afterRef: "feat/home",
					},
				],
			}),
		);
		expect(manifest.stackUrl).toBe("https://localhost:8443/app");
		expect(manifest.items[0]?.targetUrl).toContain("[::1]:4321");
		expect(manifest.items[0]?.afterRef).toBe("feat/home");
	});

	test("requires the command name to match the manifest", () => {
		expect(() => parseManifest(raw(), "other")).toThrow(/does not match/);
	});

	test("rejects a non-loopback url, userinfo, and a file url", () => {
		expect(() => parseManifest(raw({ stackUrl: "https://example.com" }))).toThrow(/loopback/);
		expect(() => parseManifest(raw({ stackUrl: "http://user:pass@127.0.0.1/" }))).toThrow(/userinfo/);
		expect(() => parseManifest(raw({ stackUrl: "file:///tmp/page.html" }))).toThrow(/http or https/);
	});

	test("rejects an empty item list, a duplicate item, and a duplicate role", () => {
		expect(() => parseManifest(raw({ items: [] }))).toThrow(/at least one item/);
		const item = (raw().items as unknown[])[0];
		expect(() => parseManifest(raw({ items: [item, item] }))).toThrow(/duplicate item/);
		expect(() =>
			parseManifest(
				raw({
					items: [
						{
							...(item as object),
							roles: [
								{ id: "admin" },
								{ id: "admin" },
							],
						},
					],
				}),
			),
		).toThrow(/duplicate role/);
	});

	test("rejects an unknown field and a path-like name", () => {
		expect(() => parseManifest(raw({ extra: true }))).toThrow(/unknown field/);
		expect(() => parseManifest(raw({ name: "../review" }))).toThrow(/invalid verify name/);
		expect(() => parseManifest(raw({ name: "" }))).toThrow(/empty/);
	});

	test("rejects an authorization header and a token-shaped seed", () => {
		const item = {
			...(raw().items as Record<string, unknown>[])[0],
			roles: [{ id: "admin", headers: { Authorization: "Bearer supersecret" } }],
		};
		expect(() => parseManifest(raw({ items: [item] }))).toThrow(/not allowed/);
		const cooked = {
			...(raw().items as Record<string, unknown>[])[0],
			roles: [{ id: "admin", cookies: [{ name: "sid", value: "ghp_abcdefghijklmnopqrst" }] }],
		};
		expect(() => parseManifest(raw({ items: [cooked] }))).toThrow(/looks like a secret/);
	});

	test("rejects a role with no id and an item with no owner", () => {
		expect(() =>
			parseManifest(
				raw({
					items: [
						{
							id: "home",
							title: "Home",
							owner: "dg:implementer",
							beforeUrl: "http://127.0.0.1:1/",
							afterUrl: "http://127.0.0.1:2/",
							roles: [],
						},
					],
				}),
			),
		).toThrow(/at least one role/);
		expect(() =>
			parseManifest(
				raw({
					items: [
						{
							id: "home",
							title: "Home",
							beforeUrl: "http://127.0.0.1:1/",
							afterUrl: "http://127.0.0.1:2/",
							roles: [{ id: "admin" }],
						},
					],
				}),
			),
		).toThrow(/owner/);
	});

	test("accepts a supplied test summary and rejects a test object with neither cmd nor summary", () => {
		const manifest: VerifyManifest = parseManifest(raw({ tests: { summary: "4 passed", passed: 4, failed: 0 } }));
		expect(manifest.tests).toEqual({ summary: "4 passed", passed: 4, failed: 0 });
		expect(() => parseManifest(raw({ tests: { passed: 1 } }))).toThrow(/cmd or summary/);
		expect(() => parseManifest(raw({ tests: { failed: -1, summary: "x" } }))).toThrow(/non-negative/);
	});
});

describe("secret shapes", () => {
	test("matches bearer and access-key shapes and ignores a seed role", () => {
		expect(looksSecret("Bearer supersecret")).toBe(true);
		expect(looksSecret(`AKIA${"ABCDEFGHIJKLMNOP"}`)).toBe(true);
		expect(looksSecret("admin")).toBe(false);
		expect(looksSecret("member")).toBe(false);
	});
});
