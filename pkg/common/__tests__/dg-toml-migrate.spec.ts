import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DgCliError } from "../src/errors";
import { resolveDgPaths, type DgPaths } from "../src/node/dg-paths";
import { readDgToml } from "../src/node/dg-toml";
import { migrateToToml, type SecretStore } from "../src/node/dg-toml-migrate";

const FAKE_SECRET = "fake-client-secret-7f3a9c";

let home: string;
let env: Record<string, string | undefined>;
let paths: DgPaths;
let stored: Map<string, string>;
let store: SecretStore;

const configJson = () => paths.configPath;
const browserBatch = () => join(home, ".config", "browser-batch", "config.json");
const inboxJson = () => join(paths.stateDir, "inbox", "config", "organizer.config.json");
const ssmsYaml = () => join(paths.configDir, "ssms", "config.yaml");

function put(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

function seedAll(): void {
	put(configJson(), JSON.stringify({ hooks: { spelling: { locale: "en-GB" }, "strip-ai-coauthors": { mode: "strip" } } }));
	put(paths.cliOnlyMarker, "");
	put(browserBatch(), JSON.stringify({ defaultRepo: "acme/app", aliases: { app: "acme/app", web: "acme/web" } }));
	put(
		inboxJson(),
		JSON.stringify({
			provider: "gmail",
			gmail: { clientId: "fake-client-id", clientSecret: FAKE_SECRET, pageSize: 50 },
			classifier: { mode: "rules-only" },
		}),
	);
	put(ssmsYaml(), "allow_send: true\ngoogle:\n  send_enabled: false\n");
}

function snapshot(): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (!entry.name.startsWith(".install.lock")) out[relative(home, path)] = readFileSync(path, "utf8");
		}
	};
	walk(home);
	return out;
}

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const migrate = (options: { store?: SecretStore } = { store }) => migrateToToml(paths, { homeDir: home, env, ...options });

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-toml-migrate-"));
	env = { DG_HOME: join(home, "dg"), DG_PATH_FENCE: tmpdir() };
	paths = resolveDgPaths({ env, homeDir: home });
	stored = new Map();
	store = { set: async (name, value) => void stored.set(name, value) };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("migrateToToml", () => {
	test("folds every source into config.toml with the same values", async () => {
		seedAll();

		const result = await migrate();

		expect(result.wrote).toBe(true);
		const doc = readDgToml(env);
		expect(doc.hooks).toEqual({ spelling: { locale: "en-GB" }, "strip-ai-coauthors": { mode: "strip" } });
		expect(doc.install.cli_only).toBe(true);
		expect(doc.refs).toEqual({ default_repo: "acme/app", aliases: { app: "acme/app", web: "acme/web" } });
		expect(doc.inbox).toEqual({
			provider: "gmail",
			gmail: { clientId: "fake-client-id", clientSecret: { credential: "dg-config/inbox-gmail-client-secret" }, pageSize: 50 },
			classifier: { mode: "rules-only" },
		});
		expect(doc.ssms).toEqual({ allow_send: true, google: { send_enabled: false } });
	});

	test("moves a secret into the credential store and keeps it out of the TOML", async () => {
		seedAll();

		await migrate();

		expect(stored.get("dg-config/inbox-gmail-client-secret")).toBe(FAKE_SECRET);
		expect(readFileSync(paths.configTomlPath, "utf8")).not.toContain(FAKE_SECRET);
		expect(statSync(paths.configTomlPath).mode & 0o777).toBe(0o600);
	});

	test("backs up each source as .pre-toml with mode 0600 and leaves the source in place", async () => {
		seedAll();
		const sources = [configJson(), paths.cliOnlyMarker, browserBatch(), inboxJson(), ssmsYaml()];
		const before = sources.map((path) => readFileSync(path, "utf8"));

		const result = await migrate();

		expect(result.sources.toSorted()).toEqual(sources.toSorted());
		expect(result.backups.toSorted()).toEqual(sources.map((path) => `${path}.pre-toml`).toSorted());
		for (const [index, path] of sources.entries()) {
			expect(readFileSync(path, "utf8")).toBe(before[index] as string);
			expect(readFileSync(`${path}.pre-toml`, "utf8")).toBe(before[index] as string);
			expect(statSync(`${path}.pre-toml`).mode & 0o777).toBe(0o600);
		}
	});

	test("records each source and its sha256 in meta.migrated", async () => {
		seedAll();

		await migrate();

		const migrated = readDgToml(env).meta.migrated;
		expect(migrated[configJson()]).toBe(sha256(configJson()));
		expect(migrated[inboxJson()]).toBe(sha256(inboxJson()));
		expect(Object.keys(migrated)).toHaveLength(5);
	});

	test("is idempotent: a second run changes nothing and writes no second backup", async () => {
		seedAll();
		await migrate();
		const after = snapshot();

		const second = await migrate();

		expect(second).toEqual({ wrote: false, sources: [], backups: [] });
		expect(snapshot()).toEqual(after);
	});

	test("writes nothing when no source exists", async () => {
		const result = await migrate();

		expect(result).toEqual({ wrote: false, sources: [], backups: [] });
		expect(existsSync(paths.configTomlPath)).toBe(false);
	});

	test("a broken JSON source leaves every file as it was and names a next step", async () => {
		seedAll();
		put(browserBatch(), "{ not json");
		const before = snapshot();

		const error = await migrate().catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(DgCliError);
		expect((error as Error).message).toContain(browserBatch());
		expect((error as Error).message).toContain("Next:");
		expect(snapshot()).toEqual(before);
		expect(stored.size).toBe(0);
	});

	test("a secret with no credential store writes nothing", async () => {
		seedAll();
		const before = snapshot();

		const error = await migrate({}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(DgCliError);
		expect((error as Error).message).toContain("dg-daemon");
		expect((error as Error).message).not.toContain(FAKE_SECRET);
		expect(snapshot()).toEqual(before);
	});

	test("a failed credential store write stops and writes nothing", async () => {
		seedAll();
		const before = snapshot();
		const failing: SecretStore = {
			set: async () => {
				throw new Error(`store down while holding ${FAKE_SECRET}`);
			},
		};

		const error = await migrate({ store: failing }).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(DgCliError);
		expect((error as Error).message).not.toContain(FAKE_SECRET);
		expect(snapshot()).toEqual(before);
	});

	test("an existing .pre-toml that differs stops the run and survives", async () => {
		seedAll();
		put(`${configJson()}.pre-toml`, "older backup");
		const before = snapshot();

		const error = await migrate().catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(DgCliError);
		expect((error as Error).message).toContain(`${configJson()}.pre-toml`);
		expect(snapshot()).toEqual(before);
	});

	test("a browser-batch file outside DG_PATH_FENCE is not read", async () => {
		env = { ...env, DG_PATH_FENCE: join(home, "dg") };
		paths = resolveDgPaths({ env, homeDir: home });
		put(browserBatch(), JSON.stringify({ aliases: { app: "acme/app" } }));
		put(configJson(), JSON.stringify({ hooks: { spelling: { locale: "en-GB" } } }));

		const result = await migrate();

		expect(result.sources).toEqual([configJson()]);
		expect(readDgToml(env).refs.aliases).toEqual({});
	});

	test("a source with a bad value fails validation and writes nothing", async () => {
		put(browserBatch(), JSON.stringify({ aliases: { app: 7 } }));
		const before = snapshot();

		const error = await migrate().catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(DgCliError);
		expect((error as Error).message).toContain("refs.aliases.app must be a string");
		expect(snapshot()).toEqual(before);
	});
});

describe("readDgToml before migration", () => {
	test("reads the old sources with no write and drops secret values", () => {
		seedAll();
		const before = snapshot();

		const doc = readDgToml(env);

		expect(doc.hooks.spelling).toEqual({ locale: "en-GB" });
		expect(doc.install.cli_only).toBe(true);
		expect(doc.inbox.gmail).toEqual({ clientId: "fake-client-id", pageSize: 50 });
		expect(snapshot()).toEqual(before);
	});
});
