import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DgCliError } from "../src/errors";
import { readDgToml, setting, writeDgToml } from "../src/node/dg-toml";

const FAKE_TOKEN = `ghp_${"Fake0".repeat(7)}x`;

let home: string;
let file: string;
let env: Record<string, string>;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-toml-"));
	mkdirSync(join(home, "config"));
	file = join(home, "config", "config.toml");
	env = { DG_HOME: home };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function caught(fn: () => unknown): DgCliError {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(DgCliError);
		return error as DgCliError;
	}
	throw new Error("expected a DgCliError");
}

describe("readDgToml", () => {
	test("returns defaults for a missing file", () => {
		const doc = readDgToml(env);

		expect(doc.install.cli_only).toBe(false);
		expect(doc.hooks).toEqual({});
		expect(doc.refs.aliases).toEqual({});
		expect(doc.plugins).toEqual({});
	});

	test("reads each section from config.toml", () => {
		writeFileSync(
			file,
			[
				"[hooks.spelling]",
				'locale = "en-GB"',
				"[install]",
				"cli_only = true",
				"[refs]",
				'default_repo = "acme/app"',
				"[refs.aliases]",
				'app = "acme/app"',
				"[plugins.foo]",
				"enabled = false",
				'source = "github:acme/foo"',
				"[plugins.foo.settings]",
				"depth = 3",
				"",
			].join("\n"),
		);

		const doc = readDgToml(env);

		expect(doc.hooks).toEqual({ spelling: { locale: "en-GB" } });
		expect(doc.install.cli_only).toBe(true);
		expect(doc.refs).toEqual({ default_repo: "acme/app", aliases: { app: "acme/app" } });
		expect(doc.plugins.foo).toEqual({ enabled: false, allow_remote: false, fail_closed: false, source: "github:acme/foo", settings: { depth: 3 } });
	});

	test("throws a DgCliError with file, line, key and a next step for a wrong type", () => {
		writeFileSync(file, ["[hooks.spelling]", 'locale = "en-US"', "", "[install]", 'cli_only = "yes"', ""].join("\n"));

		const error = caught(() => readDgToml(env));

		expect(error.message).toBe(
			`dg config: ${file}:5: install.cli_only must be a boolean, got "yes". Next: run dg config edit, or dg config set install.cli_only <value>.`,
		);
	});

	test("throws a DgCliError with the line of a TOML syntax error", () => {
		writeFileSync(file, ["[install]", "cli_only = ", ""].join("\n"));

		const error = caught(() => readDgToml(env));

		expect(error.message).toStartWith(`dg config: ${file}:2: `);
		expect(error.message).toContain("Next: run dg config edit");
	});

	test("refuses an unknown section", () => {
		writeFileSync(file, ["[nope]", "x = 1", ""].join("\n"));

		expect(caught(() => readDgToml(env)).message).toContain(`${file}:1: nope is not a dg config section`);
	});

	test("refuses a plain token in plugin settings without printing it", () => {
		writeFileSync(file, ["[plugins.foo.settings]", `token = "${FAKE_TOKEN}"`, ""].join("\n"));

		const error = caught(() => readDgToml(env));

		expect(error.message).toContain(`${file}:2: plugins.foo.settings.token must be a credential reference`);
		expect(error.message).toContain("dg credentials set");
		expect(error.message).not.toContain(FAKE_TOKEN);
	});

	test("refuses a token-like value under a plain plugin key without printing it", () => {
		writeFileSync(file, ["[plugins.foo.settings]", `endpoint = "${FAKE_TOKEN}"`, ""].join("\n"));

		const error = caught(() => readDgToml(env));

		expect(error.message).toContain("plugins.foo.settings.endpoint must be a credential reference");
		expect(error.message).not.toContain(FAKE_TOKEN);
	});

	test("accepts a credential reference in plugin settings", () => {
		writeFileSync(file, ["[plugins.foo.settings]", 'token = { credential = "foo-token" }', ""].join("\n"));

		expect(readDgToml(env).plugins.foo?.settings).toEqual({ token: { credential: "foo-token" } });
	});

	test("refuses a plain inbox client secret without printing it", () => {
		writeFileSync(file, ["[inbox.gmail]", 'clientSecret = "fake-client-secret-value"', ""].join("\n"));

		const error = caught(() => readDgToml(env));

		expect(error.message).toContain("inbox.gmail.clientSecret must be a credential reference");
		expect(error.message).not.toContain("fake-client-secret-value");
	});

	test("refuses a resolve placeholder anywhere", () => {
		writeFileSync(file, ["[refs.aliases]", 'app = "{{resolve:secretsmanager:x}}"', ""].join("\n"));

		expect(caught(() => readDgToml(env)).message).toContain("refs.aliases.app must not hold a {{resolve:...}} placeholder");
	});

	test("refuses a credential reference with a bad name", () => {
		writeFileSync(file, ["[plugins.foo.settings]", 'token = { credential = "Bad Name" }', ""].join("\n"));

		expect(caught(() => readDgToml(env)).message).toContain("plugins.foo.settings.token must be a credential reference");
	});

	test("allows a number under a secret-named plugin key and a plain path", () => {
		writeFileSync(
			file,
			["[plugins.foo.settings]", "max_tokens = 1000", "token_count = 4", 'data = "/srv/data/some-long-directory-name-2"', ""].join("\n"),
		);

		expect(readDgToml(env).plugins.foo?.settings).toEqual({ max_tokens: 1000, token_count: 4, data: "/srv/data/some-long-directory-name-2" });
	});

	test("checks a token inside an array of plugin settings", () => {
		writeFileSync(file, ["[plugins.foo.settings]", `accounts = [{ token = "${FAKE_TOKEN}" }]`, ""].join("\n"));

		const error = caught(() => readDgToml(env));

		expect(error.message).toContain("plugins.foo.settings.accounts.0.token must be a credential reference");
		expect(error.message).not.toContain(FAKE_TOKEN);
	});

	test("refuses an array of plain values under a secret-named key", () => {
		writeFileSync(file, ["[plugins.foo.settings]", 'token = ["plain-value"]', ""].join("\n"));

		expect(caught(() => readDgToml(env)).message).toContain("plugins.foo.settings.token must be a credential reference");
	});

	test("refuses a plugin name with a dot", () => {
		writeFileSync(file, ['[plugins."a.b".settings]', 'token = "x"', ""].join("\n"));

		expect(() => readDgToml(env)).toThrow(DgCliError);
	});

	test("reads only the DG_HOME file, never the XDG one", () => {
		const xdg = mkdtempSync(join(tmpdir(), "dg-toml-xdg-"));
		try {
			mkdirSync(join(xdg, "dg"));
			writeFileSync(join(xdg, "dg", "config.toml"), "[install]\ncli_only = true\n");

			expect(readDgToml({ ...env, XDG_CONFIG_HOME: xdg }).install.cli_only).toBe(false);
		} finally {
			rmSync(xdg, { recursive: true, force: true });
		}
	});
});

describe("setting", () => {
	test("returns the default when nothing sets the key", () => {
		expect(setting<boolean>("install.cli_only", { env })).toBe(false);
	});

	test("prefers TOML over the default", () => {
		writeFileSync(file, "[install]\ncli_only = true\n");

		expect(setting<boolean>("install.cli_only", { env })).toBe(true);
	});

	test("prefers env over TOML", () => {
		writeFileSync(file, "[install]\ncli_only = true\n");

		expect(setting<boolean>("install.cli_only", { envVar: "DG_CLI_ONLY", env: { ...env, DG_CLI_ONLY: "false" } })).toBe(false);
	});

	test("prefers the flag over env", () => {
		expect(
			setting<boolean>("install.cli_only", { flag: true, envVar: "DG_CLI_ONLY", env: { ...env, DG_CLI_ONLY: "0" } }),
		).toBe(true);
	});

	test("reads a nested TOML value", () => {
		writeFileSync(file, '[refs.aliases]\napp = "acme/app"\n');

		expect(setting<string>("refs.aliases.app", { env })).toBe("acme/app");
	});
});

describe("setting env values", () => {
	test("refuses a number env var that does not parse, and an empty one", () => {
		writeFileSync(file, "[plugins.foo.settings]\ndepth = 3\n");

		for (const raw of ["abc", ""])
			expect(() => setting<number>("plugins.foo.settings.depth", { envVar: "DG_DEPTH", env: { ...env, DG_DEPTH: raw } })).toThrow(
				"DG_DEPTH must be a number",
			);
	});

	test("refuses a boolean env var that does not parse", () => {
		expect(() => setting<boolean>("install.cli_only", { envVar: "DG_CLI_ONLY", env: { ...env, DG_CLI_ONLY: "flase" } })).toThrow(
			"DG_CLI_ONLY must be true or false",
		);
	});
});

describe("writeDgToml", () => {
	test("writes a value with mode 0600 and reads it back", () => {
		writeDgToml("refs.aliases.app", "acme/app", env);

		expect(readDgToml(env).refs.aliases).toEqual({ app: "acme/app" });
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	test("keeps the other values in the file", () => {
		writeDgToml("install.cli_only", true, env);
		writeDgToml("hooks.spelling.locale", "en-GB", env);

		const doc = readDgToml(env);
		expect(doc.install.cli_only).toBe(true);
		expect(doc.hooks.spelling).toEqual({ locale: "en-GB" });
	});

	test("validates before it writes and leaves the file unchanged on failure", () => {
		writeDgToml("install.cli_only", true, env);
		const before = readFileSync(file, "utf8");

		expect(() => writeDgToml("install.cli_only", "yes", env)).toThrow(DgCliError);
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	test("never writes a secret value", () => {
		const error = caught(() => writeDgToml("plugins.foo.settings.token", FAKE_TOKEN, env));

		expect(error.message).not.toContain(FAKE_TOKEN);
		expect(() => statSync(file)).toThrow();
	});

	test("writes a credential reference to a secret field", () => {
		writeDgToml("plugins.foo.settings.token", { credential: "foo-token" }, env);

		expect(readFileSync(file, "utf8")).toContain('credential = "foo-token"');
		expect(readDgToml(env).plugins.foo?.settings.token).toEqual({ credential: "foo-token" });
	});

	test("refuses an unknown section", () => {
		expect(() => writeDgToml("nope.x", 1, env)).toThrow(DgCliError);
	});
});

describe("pw and front keys", () => {
	test("default pw.mode to auto, pw.phi_sites to empty and front.enabled to true", () => {
		expect(setting<string>("pw.mode", { env })).toBe("auto");
		expect(setting<string[]>("pw.phi_sites", { env })).toEqual([]);
		expect(setting<boolean>("front.enabled", { env })).toBe(true);
		expect(readDgToml(env).pw).toEqual({ mode: "auto", phi_sites: [] });
		expect(readDgToml(env).front.enabled).toBe(true);
	});

	test("reads the pw and front keys from config.toml", () => {
		writeFileSync(
			file,
			["[pw]", 'mode = "local"', 'phi_sites = ["https://ehr.example.org", "http://localhost:8080"]', "[front]", "enabled = false", ""].join("\n"),
		);

		expect(readDgToml(env).pw).toEqual({ mode: "local", phi_sites: ["https://ehr.example.org", "http://localhost:8080"] });
		expect(readDgToml(env).front.enabled).toBe(false);
	});

	test("rejects a pw.mode outside ext, local and auto", () => {
		writeFileSync(file, ["[pw]", 'mode = "both"', ""].join("\n"));

		expect(caught(() => readDgToml(env)).message).toBe(
			`dg config: ${file}:2: pw.mode must be ext, local or auto, got "both". Next: run dg config edit, or dg config set pw.mode <value>.`,
		);
	});

	test("rejects a config that still sets browser.mode and names pw.mode", () => {
		writeFileSync(file, ["[browser]", 'mode = "ext"', ""].join("\n"));

		expect(caught(() => readDgToml(env)).message).toBe(
			`dg config: ${file}:2: browser.mode moved to pw.mode. Next: run dg config edit, or dg config set pw.mode <value>.`,
		);
	});

	test("rejects pw.phi_sites that is not a list of site keys", () => {
		writeFileSync(file, ["[pw]", 'phi_sites = "https://a.org"', ""].join("\n"));
		expect(caught(() => readDgToml(env)).message).toBe(
			`dg config: ${file}:2: pw.phi_sites must be a list of site keys such as "https://example.org", got "https://a.org". Next: run dg config edit, or dg config set pw.phi_sites <value>.`,
		);
		writeFileSync(file, ["[pw]", 'phi_sites = ["example.org"]', ""].join("\n"));
		expect(caught(() => readDgToml(env)).message).toBe(
			`dg config: ${file}:2: pw.phi_sites.0 must be a site key such as "https://example.org", got "example.org". Next: run dg config edit, or dg config set pw.phi_sites.0 <value>.`,
		);
	});

	test("rejects an unknown pw key", () => {
		writeFileSync(file, ["[pw]", "speed = 1", ""].join("\n"));

		expect(caught(() => readDgToml(env)).message).toContain("pw.speed is not a dg config key");
	});

	test("rejects a front.enabled that is not a boolean", () => {
		writeFileSync(file, ["[front]", 'enabled = "no"', ""].join("\n"));

		expect(caught(() => readDgToml(env)).message).toBe(
			`dg config: ${file}:2: front.enabled must be a boolean, got "no". Next: run dg config edit, or dg config set front.enabled <value>.`,
		);
	});

	test("rejects an unknown key in either section", () => {
		writeFileSync(file, ["[front]", "speed = 1", ""].join("\n"));

		expect(caught(() => readDgToml(env)).message).toContain("front.speed is not a dg config key");
	});
});

describe("plugins fail_closed", () => {
	test("defaults to false and reads true from config.toml", () => {
		writeFileSync(file, ["[plugins.foo]", "enabled = true", "[plugins.bar]", "fail_closed = true", ""].join("\n"));

		const { plugins } = readDgToml(env);

		expect(plugins.foo?.fail_closed).toBe(false);
		expect(plugins.bar?.fail_closed).toBe(true);
	});

	test("rejects a value that is not a boolean", () => {
		writeFileSync(file, ["[plugins.foo]", 'fail_closed = "yes"', ""].join("\n"));

		expect(caught(() => readDgToml(env)).message).toBe(
			`dg config: ${file}:2: plugins.foo.fail_closed must be a boolean, got "yes". Next: run dg config edit, or dg config set plugins.foo.fail_closed <value>.`,
		);
	});
});

describe("plugins allow_remote", () => {
	test("defaults to false and reads true from config.toml", () => {
		writeFileSync(file, ["[plugins.foo]", "enabled = true", "[plugins.bar]", "allow_remote = true", ""].join("\n"));

		const { plugins } = readDgToml(env);

		expect(plugins.foo?.allow_remote).toBe(false);
		expect(plugins.bar?.allow_remote).toBe(true);
	});

	test("rejects a value that is not a boolean", () => {
		writeFileSync(file, ["[plugins.foo]", 'allow_remote = "yes"', ""].join("\n"));

		expect(caught(() => readDgToml(env)).message).toBe(
			`dg config: ${file}:2: plugins.foo.allow_remote must be a boolean, got "yes". Next: run dg config edit, or dg config set plugins.foo.allow_remote <value>.`,
		);
	});
});
