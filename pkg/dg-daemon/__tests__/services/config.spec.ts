import { describe, expect, it } from "bun:test";
import { parseJobs } from "../../src/jobs/config";

const declared = (jobs: unknown) => parseJobs({ jobs });

describe("parseJobs", () => {
	it("returns nothing when the config declares no services", () => {
		expect(parseJobs({})).toEqual([]);
	});

	it("accepts a valid entry and defaults enabled to false", () => {
		expect(
			declared({
				"teams-bot": { argv: ["bun", "run", "bot.ts"], cwd: "/srv/bot", continuous: true },
			}),
		).toMatchObject([
			{
				ok: true,
				name: "teams-bot",
				argv: ["bun", "run", "bot.ts"],
				cwd: "/srv/bot",
				enabled: false,
				passEnv: [],
				stopTimeoutMs: 5000,
			},
		]);
	});

	it("keeps an absolute envFile and an explicit enabled", () => {
		const [entry] = declared({
			bot: {
				argv: ["bot"],
				cwd: "/srv",
				continuous: true,
				envFile: "/srv/.env",
				enabled: true,
			},
		});
		expect(entry).toMatchObject({
			ok: true,
			envFile: "/srv/.env",
			enabled: true,
		});
	});

	it.each([
		["a path traversal label", "../evil"],
		["an uppercase label", "Bot"],
		["a label with a slash", "a/b"],
		["an empty label", ""],
	])("rejects %s", (_name, label) => {
		const [entry] = declared({ [label]: { argv: ["bot"], cwd: "/srv", continuous: true } });
		expect(entry.ok).toBe(false);
	});

	it.each([
		["a missing argv", { cwd: "/srv", continuous: true }, '"argv"'],
		["an empty argv", { argv: [], cwd: "/srv", continuous: true }, '"argv"'],
		["a non-string argv element", { argv: ["bot", 1], cwd: "/srv", continuous: true }, '"argv"'],
		["an empty argv element", { argv: [""], cwd: "/srv", continuous: true }, '"argv"'],
		["a NUL byte in argv", { argv: ["bo\0t"], cwd: "/srv", continuous: true }, '"argv"'],
		["a shell string instead of argv", { argv: "bot --run", cwd: "/srv", continuous: true }, '"argv"'],
		["a relative cwd", { argv: ["bot"], cwd: "srv", continuous: true }, '"cwd"'],
		["a missing cwd", { argv: ["bot"], continuous: true }, '"cwd"'],
		["a relative envFile", { argv: ["bot"], cwd: "/srv", envFile: ".env", continuous: true }, '"envFile"'],
		["a non-boolean enabled", { argv: ["bot"], cwd: "/srv", enabled: "yes", continuous: true }, '"enabled"'],
		["an unknown key", { argv: ["bot"], cwd: "/srv", shell: true, continuous: true }, "unknown key(s): shell"],
		["a non-object entry", "bot", "must be an object"],
	])("rejects %s without dropping its siblings", (_name, entry, reason) => {
		const parsed = declared({
			bad: entry,
			good: { argv: ["bot"], cwd: "/srv", continuous: true },
		});
		expect(parsed.map((item) => item.ok)).toEqual([false, true]);
		expect(parsed[0]).toMatchObject({ error: expect.stringContaining(reason) });
	});

	it("reports a jobs value that is not an object", () => {
		const [entry] = declared(["bot"]);
		expect(entry.ok).toBe(false);
	});
});
