import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import {
	loadConfig,
	resolveEnv,
	rewriteConfigKey,
	saveDefaultEnv,
} from "../src/config";
import {
	type TempHome,
	completeFunPool,
	createTempHome,
	ENVS,
	minimalConfigJson,
	writeConfigFile,
} from "./support/fakes";

let home: TempHome;
beforeEach(() => {
	home = createTempHome();
});
afterEach(() => {
	home.cleanup();
});

const load = (extra: Record<string, unknown> = {}) =>
	loadConfig(writeConfigFile(home.dir, minimalConfigJson(extra)));

const minimalWithout = (key: string): Record<string, unknown> => {
	const { [key]: _, ...rest } = minimalConfigJson();
	return rest;
};

const loadFailure = (body: Record<string, unknown>): DgCliError => {
	const path = writeConfigFile(home.dir, body);
	try {
		loadConfig(path);
	} catch (err) {
		expect(err).toBeInstanceOf(DgCliError);
		expect((err as Error).message).toContain(path);
		return err as DgCliError;
	}
	throw new Error("loadConfig did not throw");
};

describe("loadConfig defaults", () => {
	test("fills every default from a config with only the required keys", () => {
		const config = load();
		expect(config).toMatchObject({
			provider: "teams-relay",
			env: { default: "dev" },
			chats: [{ topic: "Team Reviews" }],
			owner: { token: "!owner", email: "owner@example.com", senderIds: [] },
			runner: { default: "claude", timeoutMinutes: 30 },
			reactions: {
				pending: "1f440_eyes",
				inProgress: "23f1_stopwatch",
				changesRequested: "1f6a7_constructionsign",
				approved: "2705_whiteheavycheckmark",
				comment: "speechbubble",
				failure: "26a0_warningsign",
			},
			relay: {
				appName: "review-bot",
				secret: {
					id: "relay/chat",
					key: "RELAY__CHAT__SECRET",
					region: "us-east-1",
				},
			},
			rereview: {
				phrases: [
					"ready",
					"fixed",
					"addressed",
					"updated",
					"ptal",
					"re-review",
					"good to go",
				],
			},
			hosts: { github: [], gitlab: [] },
		});
	});

	test("lowercases and trims configured hosts", () => {
		expect(
			load({ hosts: { github: [" GHE.Corp.Example "], gitlab: ["Git.Corp.Example"] } }).hosts,
		).toEqual({ github: ["ghe.corp.example"], gitlab: ["git.corp.example"] });
	});

	test("builds the claude allowedTools default from the home directory", () => {
		const scratch = process.env.AI_SCRATCH_DIR ?? "/tmp/ai";
		expect(load().runner.claude.allowedTools).toEqual([
			`Bash(${homedir()}/scripts/bin/thrash-helper:*)`,
			"Agent",
			`Read(/${scratch}/thrash/**)`,
			"Read(~/.claude/skills/thrash/**)",
			`Grep(/${scratch}/thrash/**)`,
			`Glob(/${scratch}/thrash/**)`,
			`Edit(/${scratch}/thrash/**)`,
		]);
	});

	test("does not allow arbitrary scripts or unscoped Read by default", () => {
		const tools = load().runner.claude.allowedTools;
		expect(tools.filter((tool) => tool.includes("/scripts/**"))).toEqual([]);
		for (const bare of ["Read", "Grep", "Glob", "Edit"]) {
			expect(tools).not.toContain(bare);
		}
	});

	test("puts the thrash scratch Edit rule under AI_SCRATCH_DIR", () => {
		const saved = process.env.AI_SCRATCH_DIR;
		process.env.AI_SCRATCH_DIR = "/var/scratch";
		try {
			expect(load().runner.claude.allowedTools).toEqual(
				expect.arrayContaining([
					"Read(//var/scratch/thrash/**)",
					"Grep(//var/scratch/thrash/**)",
					"Glob(//var/scratch/thrash/**)",
					"Edit(//var/scratch/thrash/**)",
				]),
			);
		} finally {
			if (saved === undefined) delete process.env.AI_SCRATCH_DIR;
			else process.env.AI_SCRATCH_DIR = saved;
		}
	});

	test("leaves the chat id and runner binary paths unset by default", () => {
		const config = load();
		expect(config.chats[0]?.id).toBeUndefined();
		expect(config.runner.codex?.path).toBeUndefined();
	});

	test("keeps explicit values over defaults", () => {
		const config = load({
			chat: { topic: "Other", id: "19:abc@thread.v2" },
			owner: { token: "!bob", email: "owner@example.com" },
			runner: {
				default: "codex",
				timeoutMinutes: 10,
				codex: { path: "/opt/codex" },
			},
			reactions: { approved: "custom;0-cus-d3-abc" },
			rereview: { phrases: ["go"] },
			env: { default: "prod" },
		});
		expect(config).toMatchObject({
			chats: [{ topic: "Other", id: "19:abc@thread.v2" }],
			owner: { token: "!bob" },
			runner: { default: "codex", timeoutMinutes: 10, codex: { path: "/opt/codex" } },
			reactions: { approved: "custom;0-cus-d3-abc", pending: "1f440_eyes" },
			rereview: { phrases: ["go"] },
			env: { default: "prod" },
		});
	});
});

describe("loadConfig chats", () => {
	test("normalizes the old chat object to a one-entry chats list", () => {
		const config = load({ chat: { topic: "Other", id: "19:abc@thread.v2" } });
		expect(config.chats).toEqual([{ topic: "Other", id: "19:abc@thread.v2" }]);
		expect("chat" in config).toBe(false);
	});

	test("reads several chats by topic or id", () => {
		const config = load({
			chats: [{ topic: "Team Reviews" }, { id: "19:b@thread.v2" }],
		});
		expect(config.chats).toEqual([
			{ topic: "Team Reviews", id: undefined },
			{ topic: undefined, id: "19:b@thread.v2" },
		]);
	});

	test("rejects chat and chats together", () => {
		const error = loadFailure(
			minimalConfigJson({ chat: { topic: "A" }, chats: [{ topic: "B" }] }),
		);
		expect(error.message).toContain("chat and chats");
	});

	test("rejects an empty chats list", () => {
		const error = loadFailure(minimalConfigJson({ chats: [] }));
		expect(error.message).toContain("chats must not be empty");
	});

	test("rejects a chats entry with neither topic nor id", () => {
		const error = loadFailure(minimalConfigJson({ chats: [{}] }));
		expect(error.message).toContain("chats[0] needs a topic or an id");
	});

	test("rejects duplicate chat ids", () => {
		const error = loadFailure(
			minimalConfigJson({ chats: [{ id: "19:a" }, { topic: "X" }, { id: "19:a" }] }),
		);
		expect(error.message).toContain("duplicate id 19:a");
	});

	test("rejects an unknown key inside a chats entry", () => {
		const error = loadFailure(minimalConfigJson({ chats: [{ topic: "A", name: "x" }] }));
		expect(error.message).toContain("chats[0].name");
	});

	test("rejects chats that is not an array", () => {
		const error = loadFailure(minimalConfigJson({ chats: { topic: "A" } }));
		expect(error.message).toContain("chats must be an array");
	});
});

describe("loadConfig rejections", () => {
	test("rejects a missing owner.email naming the file and the field", () => {
		const error = loadFailure(minimalConfigJson({ owner: { token: "!owner" } }));
		expect(error.message).toContain("owner.email");
	});

	test("rejects a missing owner.token naming the field", () => {
		const error = loadFailure(minimalConfigJson({ owner: { email: "owner@example.com" } }));
		expect(error.message).toContain("owner.token is required");
	});

	test("rejects a config without chats", () => {
		expect(loadFailure(minimalWithout("chats")).message).toContain("chats is required");
	});

	test("rejects a chat object with neither topic nor id", () => {
		expect(loadFailure(minimalConfigJson({ chat: {} })).message).toContain(
			"chat needs a topic or an id",
		);
	});

	test("rejects a missing relay.appName naming the field", () => {
		const error = loadFailure(minimalWithout("relay"));
		expect(error.message).toContain("relay.appName is required");
	});

	test("rejects a missing relay.secret naming the field", () => {
		const error = loadFailure(minimalConfigJson({ relay: { appName: "review-bot" } }));
		expect(error.message).toContain("relay.secret is required");
	});

	test.each(["id", "key", "region"])("rejects a missing relay.secret.%s", (key) => {
		const { [key]: _, ...secret } = { id: "relay/chat", key: "RELAY__CHAT__SECRET", region: "us-east-1" };
		const error = loadFailure(minimalConfigJson({ relay: { appName: "review-bot", secret } }));
		expect(error.message).toContain(`relay.secret.${key} is required`);
	});

	test("rejects an unknown top-level key by field path", () => {
		const error = loadFailure(minimalConfigJson({ stray: "x" }));
		expect(error.message).toContain("stray");
	});

	test("rejects an unknown nested key by full field path", () => {
		const error = loadFailure(
			minimalConfigJson({
				relay: { appName: "review-bot", secretValue: "pasted" },
			}),
		);
		expect(error.message).toContain("relay.secretValue");
		expect(error.message).not.toContain("pasted");
	});

	test("rejects a pasted secret under a stray key inside relay.secret", () => {
		const error = loadFailure(
			minimalConfigJson({
				relay: { appName: "review-bot", secret: { value: "hunter2" } },
			}),
		);
		expect(error.message).toContain("relay.secret.value");
	});

	test.each([
		["runner.default", { runner: { default: "gemini" } }],
		["runner.timeoutMinutes", { runner: { timeoutMinutes: "soon" } }],
		["env.default", { env: { default: "staging" } }],
		["provider", { provider: "slack" }],
		["rereview.phrases", { rereview: { phrases: [""] } }],
		["hosts.github", { hosts: { github: "ghe.example" } }],
		["hosts.gitlab[0]", { hosts: { gitlab: [" "] } }],
		["hosts.other", { hosts: { other: [] } }],
	])("rejects an invalid %s naming the field", (field, extra) => {
		const error = loadFailure(minimalConfigJson(extra));
		expect(error.message).toContain(field);
	});

	test.each([[0], [-5], [-0.5]])(
		"rejects runner.timeoutMinutes of %p naming the field",
		(timeoutMinutes) => {
			const error = loadFailure(minimalConfigJson({ runner: { timeoutMinutes } }));
			expect(error.message).toContain("runner.timeoutMinutes");
		},
	);

	test("rejects a file that is not valid JSON naming the path", () => {
		const path = join(home.dir, "config.json");
		writeFileSync(path, "{not json");
		expect(() => loadConfig(path)).toThrow(DgCliError);
		expect(() => loadConfig(path)).toThrow(path);
	});

	test("rejects a missing file naming the path", () => {
		const path = join(home.dir, "absent.json");
		expect(() => loadConfig(path)).toThrow(DgCliError);
		expect(() => loadConfig(path)).toThrow(path);
	});
});

describe("loadConfig address", () => {
	test("defaults the clone root, the timeout, and the sender gate", () => {
		const config = load();
		expect(config.address).toEqual({
			cloneRoot: join(homedir(), "code", "bot"),
			allowAnySender: false,
		});
		expect(config.runner.addressTimeoutMinutes).toBe(60);
		expect(config.owner.senderIds).toEqual([]);
	});

	test("builds the address allowlist from the clone root and the home directory", () => {
		const tools = load({ address: { cloneRoot: "/srv/clones" } }).runner.claude.addressAllowedTools;
		expect(tools).toEqual([
			"Agent",
			"Edit(//srv/clones/**)",
			"Read(//srv/clones/**)",
			"Grep(//srv/clones/**)",
			"Glob(//srv/clones/**)",
			"Read(~/.claude/skills/address/**)",
			"Bash(git:*)",
			"Bash(gh:*)",
			"Bash(glab:*)",
			`Bash(${homedir()}/scripts/bin/address-helper:*)`,
			"Bash(bun:*)",
			"Bash(npm:*)",
			"Bash(npx:*)",
			"Bash(dotnet:*)",
			"Bash(python:*)",
			"Bash(pytest:*)",
		]);
	});

	test("keeps a configured address allowlist apart from the review allowlist", () => {
		const config = load({ runner: { claude: { addressAllowedTools: ["Bash(git:*)"] } } });
		expect(config.runner.claude.addressAllowedTools).toEqual(["Bash(git:*)"]);
		expect(config.runner.claude.allowedTools).not.toEqual(["Bash(git:*)"]);
	});

	test("trims sender ids", () => {
		expect(
			load({ owner: { token: "!owner", email: "owner@example.com", senderIds: [" u-owner "] } }).owner.senderIds,
		).toEqual(["u-owner"]);
	});

	test.each([
		["a relative clone root", { address: { cloneRoot: "code/bot" } }, "address.cloneRoot"],
		["a non-boolean allowAnySender", { address: { allowAnySender: "yes" } }, "address.allowAnySender"],
		["an unknown address key", { address: { repos: {} } }, "address.repos"],
		["a zero address timeout", { runner: { addressTimeoutMinutes: 0 } }, "runner.addressTimeoutMinutes"],
		["an empty sender id", { owner: { token: "!owner", email: "owner@example.com", senderIds: [" "] } }, "owner.senderIds[0]"],
		["a non-array senderIds", { owner: { token: "!owner", email: "owner@example.com", senderIds: "u-owner" } }, "owner.senderIds"],
	])("rejects %s", (_name, extra, key) => {
		expect(loadFailure(minimalConfigJson(extra)).message).toContain(key);
	});
});

describe("loadConfig fun.pool override", () => {
	test("accepts an override that covers every verdict with both kinds", () => {
		expect(load({ fun: { pool: completeFunPool() } }).fun?.pool).toEqual(
			completeFunPool(),
		);
	});
});

describe("loadConfig fun.pool validation", () => {
	test("rejects an override that lacks every entry for a verdict, naming fun.pool", () => {
		const pool = completeFunPool().filter((entry) => entry.verdict !== "failed");
		expect(loadFailure(minimalConfigJson({ fun: { pool } })).message).toContain(
			"fun.pool",
		);
	});

	test("rejects an override with a non-https gif url, naming fun.pool", () => {
		const pool = completeFunPool().map((entry) =>
			entry.kind === "gif" && entry.verdict === "approved"
				? { ...entry, url: "http://img.example.com/a.gif" }
				: entry,
		);
		expect(loadFailure(minimalConfigJson({ fun: { pool } })).message).toContain(
			"fun.pool",
		);
	});

	test("rejects an override with a duplicate gif url, naming fun.pool", () => {
		const pool = completeFunPool();
		const first = pool.find((entry) => entry.kind === "gif");
		const duplicated = pool.map((entry) =>
			entry.kind === "gif" && entry !== first
				? { ...entry, url: (first as { url: string }).url }
				: entry,
		);
		expect(
			loadFailure(minimalConfigJson({ fun: { pool: duplicated } })).message,
		).toContain("fun.pool");
	});
});

describe("resolveEnv", () => {
	test("returns the dev settings when the config sets nothing else", () => {
		expect(resolveEnv(load())).toEqual({ name: "dev", ...ENVS.dev });
	});

	test("returns the prod settings for an override of prod", () => {
		expect(resolveEnv(load(), "prod")).toEqual({ name: "prod", ...ENVS.prod });
	});

	test("returns the prod settings when env.default is prod and there is no override", () => {
		expect(resolveEnv(load({ env: { default: "prod" } }))).toEqual({ name: "prod", ...ENVS.prod });
	});

	test("prefers the override over env.default", () => {
		expect(
			resolveEnv(load({ env: { default: "prod" } }), "dev").name,
		).toBe("dev");
	});

	test("does not need settings for an env that is not used", () => {
		const config = load({ envs: { dev: ENVS.dev } });
		expect(resolveEnv(config)).toEqual({ name: "dev", ...ENVS.dev });
	});

	test.each(["baseUrl", "awsProfile", "botName"])(
		"throws a config error naming envs.prod.%s when it is missing",
		(key) => {
			const { [key]: _, ...prod } = ENVS.prod;
			const config = load({ envs: { dev: ENVS.dev, prod } });
			expect(() => resolveEnv(config, "prod")).toThrow(
				new DgCliError(`envs.prod.${key} is required`),
			);
		},
	);

	test("throws a config error when the env has no settings", () => {
		const config = load({ envs: { dev: ENVS.dev } });
		expect(() => resolveEnv(config, "prod")).toThrow("envs.prod.baseUrl is required");
	});

	test("rejects an unknown env name", () => {
		expect(() => resolveEnv(load(), "staging")).toThrow();
	});
});

const TAB_FIXTURE = [
	"{",
	'\t"env": {',
	'\t\t"default": "dev"',
	"\t},",
	'\t"owner": {',
	'\t\t"email": "owner@example.com"',
	"\t},",
	'\t"relay": {',
	'\t\t"appName": "review-bot"',
	"\t}",
	"}",
	"",
].join("\n");

describe("rewriteConfigKey", () => {
	const write = (content: string): string => {
		const path = join(home.dir, "config.json");
		writeFileSync(path, content);
		return path;
	};

	test("throws DgCliError naming the path and leaves the file untouched when a parent key is not an object", () => {
		const original = `${JSON.stringify({ env: "dev" }, null, "\t")}\n`;
		const path = write(original);
		expect(() => rewriteConfigKey(path, ["env", "default"], "prod")).toThrow(DgCliError);
		expect(() => rewriteConfigKey(path, ["env", "default"], "prod")).toThrow(path);
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	test("leaves every other line of a tab-indented fixture byte-identical", () => {
		const path = write(TAB_FIXTURE);
		rewriteConfigKey(path, ["env", "default"], "prod");
		expect(readFileSync(path, "utf8")).toBe(
			TAB_FIXTURE.replace('"default": "dev"', '"default": "prod"'),
		);
	});

	test("keeps a two-space indent when the file uses two spaces", () => {
		const path = write(`${JSON.stringify({ a: { b: 1 }, c: 2 }, null, 2)}\n`);
		rewriteConfigKey(path, ["a", "b"], 5);
		expect(readFileSync(path, "utf8")).toBe(
			`${JSON.stringify({ a: { b: 5 }, c: 2 }, null, 2)}\n`,
		);
	});

	test("defaults to a tab indent for a single-line file", () => {
		const path = write('{"a":1}');
		rewriteConfigKey(path, ["a"], 2);
		expect(readFileSync(path, "utf8")).toBe('{\n\t"a": 2\n}\n');
	});

	test("keeps key order and ends with exactly one trailing newline", () => {
		const path = write('{\n\t"z": 1,\n\t"a": 2\n}\n\n\n');
		rewriteConfigKey(path, ["a"], 3);
		const text = readFileSync(path, "utf8");
		expect(Object.keys(JSON.parse(text))).toEqual(["z", "a"]);
		expect(text.endsWith("}\n")).toBe(true);
		expect(text.endsWith("\n\n")).toBe(false);
	});

	test("keeps the file mode", () => {
		const path = write(TAB_FIXTURE);
		chmodSync(path, 0o600);
		rewriteConfigKey(path, ["env", "default"], "prod");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("throws DgCliError naming the path when the file is missing", () => {
		const path = join(home.dir, "absent.json");
		expect(() => rewriteConfigKey(path, ["a"], 1)).toThrow(DgCliError);
		expect(() => rewriteConfigKey(path, ["a"], 1)).toThrow(path);
		expect(existsSync(path)).toBe(false);
	});

	test("throws DgCliError naming the path when the file is not valid JSON", () => {
		const path = write("{broken");
		expect(() => rewriteConfigKey(path, ["a"], 1)).toThrow(DgCliError);
		expect(() => rewriteConfigKey(path, ["a"], 1)).toThrow(path);
		expect(readFileSync(path, "utf8")).toBe("{broken");
	});
});

describe("saveDefaultEnv", () => {
	test("changes only env.default in an existing file", () => {
		const path = join(home.dir, "config.json");
		writeFileSync(path, TAB_FIXTURE);
		saveDefaultEnv(path, "prod");
		expect(readFileSync(path, "utf8")).toBe(
			TAB_FIXTURE.replace('"default": "dev"', '"default": "prod"'),
		);
	});

	test("creates the file with only env.default in a 0700 directory when it is absent", () => {
		const dir = join(home.dir, "channel-review");
		const path = join(dir, "config.json");
		saveDefaultEnv(path, "prod");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			env: { default: "prod" },
		});
		expect(statSync(dir).mode & 0o777).toBe(0o700);
	});
});
