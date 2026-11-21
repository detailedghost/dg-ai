import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../load";

let home: string;
let env: Record<string, string | undefined>;

function toml(text: string): void {
	mkdirSync(join(home, "config"), { recursive: true });
	writeFileSync(join(home, "config", "config.toml"), text);
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "inbox-config-"));
	env = { DG_HOME: home, DG_PATH_FENCE: tmpdir() };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("inbox loadConfig", () => {
	test("reads the [inbox] table of config.toml over the defaults", async () => {
		toml('[inbox.classifier]\nmode = "rules-only"\n[inbox.gmail]\npageSize = 25\n');

		const config = await loadConfig(undefined, { env });

		expect(config.classifier.mode).toBe("rules-only");
		expect(config.gmail.pageSize).toBe(25);
		expect(config.gmail.batchSize).toBe(200);
	});

	test("lets an env var win over config.toml", async () => {
		toml('[inbox.classifier]\nmode = "rules-only"\n');

		const config = await loadConfig(undefined, { env: { ...env, CLASSIFIER_MODE: "openai-api" } });

		expect(config.classifier.mode).toBe("openai-api");
	});

	test("lets the --config file win over env", async () => {
		const flagFile = join(home, "flag.json");
		writeFileSync(flagFile, JSON.stringify({ classifier: { mode: "codex-local" } }));

		const config = await loadConfig(flagFile, { env: { ...env, CLASSIFIER_MODE: "openai-api" } });

		expect(config.classifier.mode).toBe("codex-local");
	});

	test("resolves a credential reference through the credential store", async () => {
		toml('[inbox.gmail]\nclientSecret = { credential = "dg-config/inbox-gmail-client-secret" }\n');
		const asked: string[] = [];

		const config = await loadConfig(undefined, {
			env,
			resolveSecret: async (name) => {
				asked.push(name);
				return "fake-resolved-secret";
			},
		});

		expect(asked).toEqual(["dg-config/inbox-gmail-client-secret"]);
		expect(config.gmail.clientSecret).toBe("fake-resolved-secret");
	});

	test("leaves the secret unset and warns when the reference does not resolve", async () => {
		toml('[inbox.outlook]\nclientSecret = { credential = "dg-config/inbox-outlook-client-secret" }\n');
		const warnings: string[] = [];

		const config = await loadConfig(undefined, {
			env,
			resolveSecret: async () => {
				throw new Error("daemon down");
			},
			warn: (line) => void warnings.push(line),
		});

		expect(config.outlook.clientSecret).toBeUndefined();
		expect(warnings.join("")).toContain("inbox.outlook.clientSecret");
	});

	test("does not read organizer.config.json once config.toml exists", async () => {
		toml('[inbox.classifier]\nmode = "rules-only"\n');
		const organizer = join(home, "state", "inbox", "config", "organizer.config.json");
		mkdirSync(join(home, "state", "inbox", "config"), { recursive: true });
		writeFileSync(organizer, "{ broken");

		const config = await loadConfig(undefined, { env });

		expect(config.classifier.mode).toBe("rules-only");
	});
});
