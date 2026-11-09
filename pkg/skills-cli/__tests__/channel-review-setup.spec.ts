import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "@dg/channel-review";
import { type SetupDeps, runSetup } from "../src/channel-review/setup";
import { configCheck } from "../src/channel-review/doctor";
import { createContext } from "../src/doctor/runner";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-channel-review-setup-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const configPath = () => join(dir, "config", "channel-review", "config.json");

function deps(answers: string[], overrides: Partial<SetupDeps> = {}) {
	const lines: string[] = [];
	const questions: string[] = [];
	const relays: string[] = [];
	const queue = [...answers];
	const value: SetupDeps = {
		configPath: configPath(),
		isTTY: true,
		ask: async (question) => {
			questions.push(question);
			const next = queue.shift();
			if (next === undefined) throw new Error(`no answer for: ${question}`);
			return next;
		},
		write: (line) => lines.push(line),
		gitEmail: () => "me@example.com",
		region: () => undefined,
		connectRelay: async (env) => {
			relays.push(env);
		},
		...overrides,
	};
	return { value, lines, questions, relays, queue };
}

const DEV_ANSWERS = [
	"Team Reviews",
	"",
	"https://relay.example.test/api",
	"example-dev",
	"Review Bot",
	"",
	"",
	"",
	"review-bot",
	"relay/chat",
	"RELAY__CHAT__SECRET",
	"",
];

describe("channel-review setup", () => {
	test("writes a valid 0600 config from the answers, with defaults for blank answers", async () => {
		const d = deps([...DEV_ANSWERS, "n"]);
		expect(await runSetup({}, d.value)).toBe(0);
		const config = loadConfig(configPath());
		expect(config.env.default).toBe("dev");
		expect(config.chats).toEqual([{ topic: "Team Reviews", id: undefined }]);
		expect(config.envs.prod).toBeUndefined();
		expect(config.owner).toMatchObject({ token: "!owner", email: "me@example.com" });
		expect(config.relay.secret).toEqual({ id: "relay/chat", key: "RELAY__CHAT__SECRET", region: "us-east-1" });
		expect(statSync(configPath()).mode & 0o777).toBe(0o600);
		expect(d.relays).toEqual([]);
		expect(d.queue).toEqual([]);
	});

	test("a chat id becomes an id target and a yes stores the relay secret for the default env", async () => {
		const answers = [...DEV_ANSWERS, "y"];
		answers[0] = "19:abc@thread.v2";
		const d = deps(answers);
		expect(await runSetup({}, d.value)).toBe(0);
		expect(loadConfig(configPath()).chats).toEqual([{ topic: undefined, id: "19:abc@thread.v2" }]);
		expect(d.relays).toEqual(["dev"]);
	});

	test("asks again for a required field left blank and for an unknown env", async () => {
		const answers = [...DEV_ANSWERS, "n"];
		answers.splice(0, 1, "", "Team Reviews");
		answers.splice(2, 1, "staging", "dev");
		const d = deps(answers);
		expect(await runSetup({}, d.value)).toBe(0);
		expect(d.lines).toContain("Teams chat topic, or chat id (19:...@thread.v2) is required.");
		expect(d.lines).toContain("Default env must be one of: dev, prod.");
	});

	test("a relay connect failure still saves the config and names the next command", async () => {
		const d = deps([...DEV_ANSWERS, "y"], {
			connectRelay: async () => {
				throw new Error("no AWS session");
			},
		});
		expect(await runSetup({}, d.value)).toBe(0);
		expect(existsSync(configPath())).toBe(true);
		expect(d.lines.join("\n")).toContain("no AWS session");
		expect(d.lines.join("\n")).toContain("channel-review connect relay");
	});

	test("refuses to replace an existing config without --force", async () => {
		mkdirSync(dirname(configPath()), { recursive: true });
		writeFileSync(configPath(), "{}");
		await expect(runSetup({}, deps([]).value)).rejects.toThrow("pass --force");
		expect(readFileSync(configPath(), "utf8")).toBe("{}");
	});

	test("without a terminal it writes a template beside the config, asks nothing, and exits 1", async () => {
		const d = deps([], { isTTY: false });
		expect(await runSetup({}, d.value)).toBe(1);
		expect(existsSync(configPath())).toBe(false);
		const template = join(dirname(configPath()), "config.example.json");
		expect(JSON.parse(readFileSync(template, "utf8")).relay.appName).toBe("review-bot");
		expect(d.questions).toEqual([]);
		expect(d.lines.join("\n")).toContain(`rename it to ${configPath()}`);
	});
});

describe("channel-review doctor config check", () => {
	const context = () => createContext({ home: dir, env: { HOME: dir, DG_HOME: dir } });

	test("fails with the setup command when the config is missing", async () => {
		const result = await configCheck.run(context());
		expect(result.status).toBe("fail");
		expect(result.fix).toBe("dg-skills channel-review setup");
	});

	test("fails with the parse error when the config is invalid", async () => {
		mkdirSync(dirname(configPath()), { recursive: true });
		writeFileSync(configPath(), "{}");
		const result = await configCheck.run(context());
		expect(result.status).toBe("fail");
		expect(result.detail).toContain("chats is required");
	});

	test("passes after setup", async () => {
		await runSetup({}, deps([...DEV_ANSWERS, "n"]).value);
		expect((await configCheck.run(context())).status).toBe("ok");
	});
});
