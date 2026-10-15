import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { channelReviewPaths } from "../src/paths";
import { loadConfig } from "../src/config";
import { type captureEmoji, registerEmojis, showSlots } from "../src/emojis";
import { type TempHome, createTempHome, minimalConfigJson } from "./support/fakes";

type CaptureArgs = Parameters<typeof captureEmoji>[0];

const HEX = "0123456789abcdef0123456789abcdef";
const FORMAT = "name;0-<region>-d<digits>-<32hex>";

let home: TempHome;
let configPath: string;

beforeEach(() => {
	home = createTempHome();
	configPath = channelReviewPaths("dev", { env: home.env }).configPath;
	mkdirSync(join(home.dir, "channel-review"), { recursive: true });
});

afterEach(() => {
	home.cleanup();
});

function writeConfig(body: Record<string, unknown> = minimalConfigJson()): void {
	writeFileSync(configPath, `${JSON.stringify(body, null, "\t")}\n`);
}

function setup(options: { daemonRunning?: boolean } = {}) {
	const out: string[] = [];
	const err: string[] = [];
	const captures: CaptureArgs[] = [];
	const exits: number[] = [];
	const command = registerEmojis({
		io: { out: (line) => out.push(line), err: (line) => err.push(line) },
		system: { env: home.env },
		capture: async (args) => {
			captures.push(args);
			return 0;
		},
		daemonRunning: async () => options.daemonRunning ?? false,
		exit: (code) => exits.push(code),
	});
	command.exitOverride();
	const parent = new Command().exitOverride();
	parent.addCommand(command);
	const parse = (...args: string[]) => parent.parseAsync(["node", "x", "emojis", ...args]);
	return { parse, out, err, captures, exits };
}

const savedReactions = () => JSON.parse(readFileSync(configPath, "utf8")).reactions;

describe("registerEmojis structure", () => {
	test("returns the emojis command with capture, set, and show", () => {
		const command = registerEmojis({ io: { out() {}, err() {} } });
		expect(command.name()).toBe("emojis");
		expect(command.commands.map((sub) => sub.name()).sort()).toEqual(["capture", "set", "show"]);
	});
});

describe("emojis set", () => {
	test.each([
		["lowercase hex", `blob;0-cus-d3-${HEX}`],
		["uppercase hex", `blob;0-cus-d12-${HEX.toUpperCase()}`],
	])("accepts %s and saves it", async (_name, id) => {
		writeConfig();
		const s = setup();
		await s.parse("set", "approved", id);
		expect(savedReactions().approved).toBe(id);
		expect(s.out.join("\n")).toContain(id);
	});

	test("saves the progress slot under reactions.inProgress", async () => {
		writeConfig();
		const id = `blob;0-cus-d3-${HEX}`;
		await setup().parse("set", "progress", id);
		expect(savedReactions().inProgress).toBe(id);
	});

	test("rejects a hash that is too short, names the expected format, and leaves the config", async () => {
		writeConfig();
		const before = readFileSync(configPath, "utf8");
		await expect(setup().parse("set", "progress", "progress;0-cus-d4-abc")).rejects.toThrow(FORMAT);
		expect(readFileSync(configPath, "utf8")).toBe(before);
	});

	test("rejects a non-hex hash of the wrong length", async () => {
		writeConfig();
		const before = readFileSync(configPath, "utf8");
		await expect(setup().parse("set", "approved", "blob;0-cus-d9-xyz")).rejects.toThrow(FORMAT);
		expect(readFileSync(configPath, "utf8")).toBe(before);
	});

	test("rejects a slot named pending", async () => {
		writeConfig();
		const before = readFileSync(configPath, "utf8");
		await expect(setup().parse("set", "pending", `blob;0-cus-d3-${HEX}`)).rejects.toThrow();
		expect(readFileSync(configPath, "utf8")).toBe(before);
	});

	test("needs only a readable config.json, not a loadable one", async () => {
		writeFileSync(configPath, `${JSON.stringify({ chat: { topic: "x" } }, null, "\t")}\n`);
		const id = `blob;0-cus-d3-${HEX}`;
		await setup().parse("set", "approved", id);
		expect(savedReactions().approved).toBe(id);
	});

	test("fails naming the path when config.json is missing", async () => {
		await expect(setup().parse("set", "approved", `blob;0-cus-d3-${HEX}`)).rejects.toThrow(configPath);
	});

	test("prints restart the daemon to apply when a daemon runs", async () => {
		writeConfig();
		const s = setup({ daemonRunning: true });
		await s.parse("set", "approved", `blob;0-cus-d3-${HEX}`);
		expect(s.out.join("\n")).toContain("restart the daemon to apply");
	});

	test("prints no restart notice when no daemon runs", async () => {
		writeConfig();
		const s = setup({ daemonRunning: false });
		await s.parse("set", "approved", `blob;0-cus-d3-${HEX}`);
		expect(s.out.join("\n")).not.toContain("restart the daemon");
	});
});

describe("emojis show and showSlots", () => {
	test("lists both slots and marks the built-in fallback when the keys are absent", async () => {
		writeConfig();
		const s = setup();
		await s.parse("show");
		const defaults = loadConfig(configPath).reactions;
		const lines = s.out.join("\n").split("\n");
		const progress = lines.find((line) => line.includes("progress"));
		const approved = lines.find((line) => line.includes("approved"));
		expect(progress).toContain(defaults.inProgress);
		expect(progress).toContain("fallback");
		expect(approved).toContain(defaults.approved);
		expect(approved).toContain("fallback");
	});

	test("shows a saved id without the fallback mark and keeps the fallback mark on the other slot", async () => {
		const id = `blob;0-cus-d3-${HEX}`;
		writeConfig(minimalConfigJson({ reactions: { inProgress: id } }));
		const s = setup();
		await s.parse("show");
		const lines = s.out.join("\n").split("\n");
		const progress = lines.find((line) => line.includes("progress"));
		const approved = lines.find((line) => line.includes("approved"));
		expect(progress).toContain(id);
		expect(progress).not.toContain("fallback");
		expect(approved).toContain("fallback");
	});

	test("fails naming the field when the config does not load", async () => {
		writeConfig({
			chats: [{ topic: "Team Reviews" }],
			owner: { token: "!owner", email: "owner@example.com" },
			relay: {},
			runner: { default: "nope" },
		});
		await expect(setup().parse("show")).rejects.toThrow("relay.appName");
	});

	test("showSlots prints one line per slot through io", () => {
		writeConfig();
		const out: string[] = [];
		showSlots(loadConfig(configPath), { out: (line) => out.push(line), err() {} });
		expect(out.filter((line) => /progress|approved/.test(line))).toHaveLength(2);
	});
});

describe("emojis capture", () => {
	test("converts --timeout 5 to 5000 ms and passes slot, chat id, and the resolved env", async () => {
		writeConfig();
		const s = setup();
		await s.parse("capture", "--slot", "approved", "--timeout", "5", "--chat-id", "19:x@thread.v2", "--env", "prod");
		expect(s.captures).toHaveLength(1);
		expect(s.captures[0]).toMatchObject({
			slot: "approved",
			timeoutMs: 5000,
			chatId: "19:x@thread.v2",
			configPath,
		});
		expect(s.captures[0]?.env.name).toBe("prod");
	});

	test("defaults to the saved env and a 120 second timeout", async () => {
		writeConfig();
		const s = setup();
		await s.parse("capture", "--slot", "progress");
		expect(s.captures[0]?.env.name).toBe("dev");
		expect(s.captures[0]?.timeoutMs).toBe(120_000);
	});

	test("requires --slot", async () => {
		writeConfig();
		const s = setup();
		await expect(s.parse("capture")).rejects.toThrow(/slot/);
		expect(s.captures).toHaveLength(0);
	});

	test("rejects a slot other than progress or approved", async () => {
		writeConfig();
		const s = setup();
		await expect(s.parse("capture", "--slot", "pending")).rejects.toThrow();
		expect(s.captures).toHaveLength(0);
	});

	test("rejects a non-numeric --timeout", async () => {
		writeConfig();
		const s = setup();
		await expect(s.parse("capture", "--slot", "progress", "--timeout", "soon")).rejects.toThrow();
		expect(s.captures).toHaveLength(0);
	});

	test("hands the capture exit code to the exit seam", async () => {
		writeConfig();
		const s = setup();
		await s.parse("capture", "--slot", "progress");
		expect(s.exits).toEqual([0]);
	});
});
