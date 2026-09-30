import { describe, expect, it } from "bun:test";
import { parseServices } from "../../src/services/config";

const declared = (services: unknown) => parseServices({ services });

describe("parseServices", () => {
	it("returns nothing when the config declares no services", () => {
		expect(parseServices({})).toEqual([]);
	});

	it("accepts a valid entry and defaults autostart to false", () => {
		expect(
			declared({
				"teams-bot": { argv: ["bun", "run", "bot.ts"], cwd: "/srv/bot" },
			}),
		).toEqual([
			{
				ok: true,
				label: "teams-bot",
				argv: ["bun", "run", "bot.ts"],
				cwd: "/srv/bot",
				autostart: false,
			},
		]);
	});

	it("keeps an absolute envFile and an explicit autostart", () => {
		const [entry] = declared({
			bot: {
				argv: ["bot"],
				cwd: "/srv",
				envFile: "/srv/.env",
				autostart: true,
			},
		});
		expect(entry).toMatchObject({
			ok: true,
			envFile: "/srv/.env",
			autostart: true,
		});
	});

	it.each([
		["a path traversal label", "../evil"],
		["an uppercase label", "Bot"],
		["a label with a slash", "a/b"],
		["an empty label", ""],
	])("rejects %s", (_name, label) => {
		const [entry] = declared({ [label]: { argv: ["bot"], cwd: "/srv" } });
		expect(entry.ok).toBe(false);
	});

	it.each([
		["a missing argv", { cwd: "/srv" }],
		["an empty argv", { argv: [], cwd: "/srv" }],
		["a non-string argv element", { argv: ["bot", 1], cwd: "/srv" }],
		["an empty argv element", { argv: [""], cwd: "/srv" }],
		["a NUL byte in argv", { argv: ["bo\0t"], cwd: "/srv" }],
		["a shell string instead of argv", { argv: "bot --run", cwd: "/srv" }],
		["a relative cwd", { argv: ["bot"], cwd: "srv" }],
		["a missing cwd", { argv: ["bot"] }],
		["a relative envFile", { argv: ["bot"], cwd: "/srv", envFile: ".env" }],
		[
			"a non-boolean autostart",
			{ argv: ["bot"], cwd: "/srv", autostart: "yes" },
		],
		["an unknown key", { argv: ["bot"], cwd: "/srv", shell: true }],
		["a non-object entry", "bot"],
	])("rejects %s without dropping its siblings", (_name, entry) => {
		const parsed = declared({
			bad: entry,
			good: { argv: ["bot"], cwd: "/srv" },
		});
		expect(parsed.map((item) => item.ok)).toEqual([false, true]);
	});

	it("reports a services value that is not an object", () => {
		const [entry] = declared(["bot"]);
		expect(entry.ok).toBe(false);
	});
});
