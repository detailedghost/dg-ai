import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node/dg-paths";
import { main } from "../src/main";
import { loadConfig as loadRefs } from "../src/utils/refs";

const FAKE_TOKEN = "ghp_FAKEfakeFAKEfakeFAKEfakeFAKEfake0000";

const realOut = process.stdout.write;
const realErr = process.stderr.write;
const realConsoleError = console.error;
const realExitCode = process.exitCode;
const realHome = process.env.DG_HOME;
const realEditor = process.env.EDITOR;
const realVisual = process.env.VISUAL;
let out: string[];
let err: string[];
let root: string;
let file: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dg-config-command-"));
	process.env.DG_HOME = join(root, "dg");
	delete process.env.VISUAL;
	file = resolveDgPaths().configTomlPath;
	out = [];
	err = [];
	process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
	console.error = (...parts: unknown[]) => void err.push(`${parts.join(" ")}\n`);
	process.exitCode = 0;
});

afterEach(() => {
	process.stdout.write = realOut;
	process.stderr.write = realErr;
	console.error = realConsoleError;
	process.exitCode = realExitCode ?? 0;
	process.env.DG_HOME = realHome;
	if (realEditor === undefined) delete process.env.EDITOR;
	else process.env.EDITOR = realEditor;
	if (realVisual !== undefined) process.env.VISUAL = realVisual;
	rmSync(root, { recursive: true, force: true });
});

const stdout = () => out.join("");
const stderr = () => err.join("");

function seed(text: string): void {
	mkdirSync(join(root, "dg", "config"), { recursive: true });
	writeFileSync(file, text);
}

function editor(script: string): void {
	const path = join(root, "editor.sh");
	writeFileSync(path, `#!/bin/sh\n${script}\n`);
	chmodSync(path, 0o755);
	process.env.EDITOR = path;
}

describe("dg-skills config path", () => {
	test("prints resolveDgPaths().configTomlPath", async () => {
		expect(await main(["config", "path"])).toBe(0);

		expect(stdout()).toBe(`${join(root, "dg", "config", "config.toml")}\n`);
	});
});

describe("dg-skills config get", () => {
	test("prints a set value", async () => {
		seed('[refs.aliases]\napp = "acme/app"\n');

		expect(await main(["config", "get", "refs.aliases.app"])).toBe(0);
		expect(stdout()).toBe("acme/app\n");
	});

	test("prints the default of an unset key and exits 0", async () => {
		expect(await main(["config", "get", "install.cli_only"])).toBe(0);
		expect(stdout()).toBe("false\n");
	});

	test("prints the hook manifest default of an unset hook setting", async () => {
		expect(await main(["config", "get", "hooks.spelling.locale"])).toBe(0);
		expect(stdout()).toBe("en-US\n");
	});

	test("exits 1 for an unknown key", async () => {
		expect(await main(["config", "get", "nope.key"])).toBe(1);
		expect(stderr()).toContain("nope.key is not a dg config key");
	});

	test("prints a credential reference, not a value", async () => {
		seed('[plugins.foo.settings]\ntoken = { credential = "foo-token" }\n');

		expect(await main(["config", "get", "plugins.foo.settings.token"])).toBe(0);
		expect(stdout()).toBe('{ credential = "foo-token" }\n');
	});
});

describe("dg-skills config set", () => {
	test("writes a value that get reads back", async () => {
		expect(await main(["config", "set", "install.cli_only", "true"])).toBe(0);
		out = [];

		expect(await main(["config", "get", "install.cli_only"])).toBe(0);
		expect(stdout()).toBe("true\n");
	});

	test("keeps a string key a string", async () => {
		expect(await main(["config", "set", "refs.aliases.app", "acme/app"])).toBe(0);

		expect(readFileSync(file, "utf8")).toContain('app = "acme/app"');
	});

	test("exits 1 for a secret field with a plain value and names dg credentials", async () => {
		expect(await main(["config", "set", "plugins.foo.settings.token", FAKE_TOKEN])).toBe(1);

		expect(stderr()).toContain("dg credentials set");
		expect(stderr()).not.toContain(FAKE_TOKEN);
		expect(existsSync(file)).toBe(false);
	});

	test("writes a credential reference with --credential", async () => {
		expect(await main(["config", "set", "plugins.foo.settings.token", "--credential", "foo-token"])).toBe(0);

		expect(readFileSync(file, "utf8")).toContain('credential = "foo-token"');
	});

	test("refuses the ssms send switches", async () => {
		expect(await main(["config", "set", "ssms.allow_send", "true"])).toBe(1);

		expect(stderr()).toContain("dg config edit");
		expect(existsSync(file)).toBe(false);
	});

	test("exits 1 for an unknown key and writes nothing", async () => {
		expect(await main(["config", "set", "nope.key", "1"])).toBe(1);
		expect(existsSync(file)).toBe(false);
	});
});

describe("dg-skills config edit", () => {
	test("saves a valid edit", async () => {
		seed("[install]\ncli_only = false\n");
		editor('printf "[install]\\ncli_only = true\\n" > "$1"');

		expect(await main(["config", "edit"])).toBe(0);
		expect(readFileSync(file, "utf8")).toBe("[install]\ncli_only = true\n");
	});

	test("keeps the old file when the edit does not validate", async () => {
		seed("[install]\ncli_only = false\n");
		editor('printf "[install]\\ncli_only = \\"yes\\"\\n" > "$1"');

		expect(await main(["config", "edit"])).toBe(1);
		expect(readFileSync(file, "utf8")).toBe("[install]\ncli_only = false\n");
		expect(stderr()).toContain("install.cli_only must be a boolean");
	});

	test("keeps the old file when the editor fails", async () => {
		seed("[install]\ncli_only = false\n");
		editor('printf "garbage" > "$1"; exit 3');

		expect(await main(["config", "edit"])).toBe(1);
		expect(readFileSync(file, "utf8")).toBe("[install]\ncli_only = false\n");
	});
});

describe("config migration before a command", () => {
	test("moves config.json into config.toml before the command runs", async () => {
		const json = join(root, "dg", "config", "config.json");
		mkdirSync(join(root, "dg", "config"), { recursive: true });
		writeFileSync(json, JSON.stringify({ hooks: { spelling: { locale: "en-GB" } } }));

		expect(await main(["config", "get", "hooks.spelling.locale"])).toBe(0);

		expect(stdout()).toBe("en-GB\n");
		expect(readFileSync(file, "utf8")).toContain('locale = "en-GB"');
		expect(readFileSync(`${json}.pre-toml`, "utf8")).toBe(readFileSync(json, "utf8"));
	});

	test("warns and still runs the command when the move fails", async () => {
		const json = join(root, "dg", "config", "config.json");
		mkdirSync(join(root, "dg", "config"), { recursive: true });
		writeFileSync(json, "{ broken");

		expect(await main(["config", "path"])).toBe(0);

		expect(stderr()).toContain("config.toml was not written");
		expect(existsSync(file)).toBe(false);
	});
});

describe("ref aliases", () => {
	test("come from [refs] in config.toml, not the browser-batch file", () => {
		seed('[refs]\ndefault_repo = "acme/app"\n[refs.aliases]\nweb = "acme/web"\n');

		expect(loadRefs()).toEqual({ defaultRepo: "acme/app", aliases: { web: "acme/web" } });
	});
});
