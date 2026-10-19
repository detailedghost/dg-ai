import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialMeta } from "@dg/common";
import {
	type MigrateFlags,
	runMigrateEnv,
} from "../src/commands/channel-review-migrate";

const RELAY = "fixture-relay-dev-91c0";
const DATADOG = "ddpat_fixtureMigrateDatadog0123456789";
const SENTRY = "fixture-sentry-token-77ab";
const API_KEY = "fixture-datadog-api-key";

const ENV_FILE = [
	"# local settings",
	"DG_HOME=/fixture/dg",
	`CHANNEL_REVIEW_RELAY_SECRET_DEV="${RELAY}"`,
	"CHANNEL_REVIEW_RELAY_SECRET_PROD=",
	`export DATADOG_ACCESS_TOKEN=${DATADOG}`,
	"DATADOG_SITE=us5.datadoghq.com",
	`DATADOG_API_KEY=${API_KEY}`,
	`SENTRY_AUTH_TOKEN='${SENTRY}'`,
	"SENTRY_ORG=example-org",
	"CR_ENV=dev",
	"",
].join("\n");

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-migrate-env-"));
	mkdirSync(join(dir, ".mise"));
	writeFileSync(join(dir, ".mise", "config.toml"), "[tools]\n");
	writeFileSync(join(dir, ".env"), ENV_FILE, { mode: 0o600 });
	chmodSync(join(dir, ".env"), 0o600);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function harness(
	grants: string[] = [],
	options: { failSet?: boolean; failGrant?: boolean; onSet?: () => void } = {},
) {
	const lines: string[] = [];
	const sets: { name: string; value: string; meta?: CredentialMeta }[] = [];
	const granted: string[] = [];
	let closed = 0;
	const run = (flags: MigrateFlags = {}) =>
		runMigrateEnv(flags, {
			createClient: () => ({
				set: async (name, value, meta) => {
					if (options.failSet) throw new Error("store unavailable");
					sets.push({ name, value, meta });
					options.onSet?.();
				},
				listGrants: async () =>
					grants.map((prefix) => ({
						prefix,
						createdAt: "2026-01-01T00:00:00Z",
						lastUsedAt: null,
					})),
				grant: async (prefix) => {
					if (options.failGrant) throw new Error("grant unavailable");
					granted.push(prefix);
					return { prefix, path: `/fixture/${prefix}.token` };
				},
				close: () => {
					closed++;
				},
			}),
			write: (line) => lines.push(line),
			now: () => new Date("2026-10-16T12:34:56.789Z"),
			cwd: () => dir,
		});
	return { run, lines, sets, granted, closed: () => closed };
}

function backups(): string[] {
	return readdirSync(dir).filter((name) => name.startsWith(".env.bak-"));
}

describe("channel-review migrate-env", () => {
	test("moves the effective duplicate value and removes every assignment to it", async () => {
		writeFileSync(
			join(dir, ".env"),
			[
				`DATADOG_ACCESS_TOKEN=older`,
				`export DATADOG_ACCESS_TOKEN="${DATADOG}" # current token`,
				"DATADOG_SITE=datadoghq.eu # region",
				"UNCHANGED=value # keep this comment",
				"",
			].join("\r\n"),
		);
		const h = harness();
		await h.run();
		expect(h.sets).toMatchObject([
			{
				name: "channel-review/datadog",
				value: DATADOG,
				meta: { site: "datadoghq.eu" },
			},
		]);
		expect(readFileSync(join(dir, ".env"), "utf8")).toBe(
			"UNCHANGED=value # keep this comment\r\n",
		);
	});

	test("leaves a secret disabled by a final empty assignment intact", async () => {
		const original = `DATADOG_ACCESS_TOKEN=${DATADOG}\nDATADOG_ACCESS_TOKEN=\n`;
		writeFileSync(join(dir, ".env"), original);
		const h = harness();
		await h.run();
		expect(h.sets).toEqual([]);
		expect(readFileSync(join(dir, ".env"), "utf8")).toBe(original);
	});

	test("leaves empty optional metadata lines for provider defaults", async () => {
		writeFileSync(
			join(dir, ".env"),
			`DATADOG_ACCESS_TOKEN=${DATADOG}\nDATADOG_SITE=\n`,
		);
		const h = harness();
		await h.run();
		expect(h.sets).toEqual([
			{
				name: "channel-review/datadog",
				value: DATADOG,
				meta: { provider: "datadog", createdBy: "migrate-env" },
			},
		]);
		expect(readFileSync(join(dir, ".env"), "utf8")).toBe("DATADOG_SITE=\n");
	});

	test("preserves unrelated multiline values and moves quoted secrets including hashes", async () => {
		const unrelated =
			'OTHER="first\nDATADOG_ACCESS_TOKEN=inside-another-value\nlast"\n';
		const relay = `${RELAY} # suffix`;
		writeFileSync(
			join(dir, ".env"),
			`${unrelated}CHANNEL_REVIEW_RELAY_SECRET_DEV='${relay}' # comment\n`,
		);
		const h = harness();
		await h.run();
		expect(h.sets).toMatchObject([
			{ name: "channel-review/relay/dev", value: relay },
		]);
		expect(readFileSync(join(dir, ".env"), "utf8")).toBe(unrelated);
	});

	test.each(["failSet", "failGrant"] as const)(
		"leaves the env file intact on %s",
		async (failure) => {
			const h = harness([], { [failure]: true });
			await expect(h.run()).rejects.toThrow("unavailable");
			expect(h.closed()).toBe(1);
			expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ENV_FILE);
			expect(backups()).toEqual([]);
		},
	);

	test("preserves edits made while credentials are being stored", async () => {
		const edited = `${ENV_FILE}EXTRA=keep\n`;
		const h = harness([], {
			onSet: () => writeFileSync(join(dir, ".env"), edited),
		});
		await expect(h.run()).rejects.toThrow("changed during migration");
		expect(readFileSync(join(dir, ".env"), "utf8")).toBe(edited);
		expect(backups()).toEqual([]);
	});

	test("refuses a symlink without modifying its target", async () => {
		const link = join(dir, "linked.env");
		symlinkSync(join(dir, ".env"), link);
		const h = harness();
		await expect(h.run({ file: link })).rejects.toThrow("regular file");
		expect(h.sets).toEqual([]);
		expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ENV_FILE);
	});

	test("stores each known secret with its meta and removes only those lines", async () => {
		const h = harness();
		await h.run();
		expect(h.sets).toEqual([
			{
				name: "channel-review/relay/dev",
				value: RELAY,
				meta: { provider: "relay", createdBy: "migrate-env" },
			},
			{
				name: "channel-review/datadog",
				value: DATADOG,
				meta: {
					provider: "datadog",
					createdBy: "migrate-env",
					site: "us5.datadoghq.com",
				},
			},
			{
				name: "channel-review/sentry",
				value: SENTRY,
				meta: {
					provider: "sentry",
					createdBy: "migrate-env",
					org: "example-org",
				},
			},
		]);
		expect(readFileSync(join(dir, ".env"), "utf8")).toBe(
			[
				"# local settings",
				"DG_HOME=/fixture/dg",
				"CHANNEL_REVIEW_RELAY_SECRET_PROD=",
				`DATADOG_API_KEY=${API_KEY}`,
				"CR_ENV=dev",
				"",
			].join("\n"),
		);
		expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
		expect(h.granted).toEqual(["channel-review"]);
	});

	test("deletes the backup by default once the file is rewritten", async () => {
		const h = harness(["channel-review"]);
		await h.run();
		expect(backups()).toEqual([]);
		expect(h.lines.join("\n")).not.toContain(".env.bak-");
	});

	test("keeps a 0600 backup with the original values under --keep-backup", async () => {
		const h = harness(["channel-review"]);
		await h.run({ keepBackup: true });
		expect(backups()).toEqual([".env.bak-20261016T123456Z"]);
		const backup = join(dir, ".env.bak-20261016T123456Z");
		expect(readFileSync(backup, "utf8")).toBe(ENV_FILE);
		expect(statSync(backup).mode & 0o777).toBe(0o600);
		expect(h.lines.join("\n")).toContain(`backup kept at ${backup}`);
	});

	test("never writes a backup file without --keep-backup", async () => {
		const h = harness(["channel-review"]);
		const before = new Set(readdirSync(dir));
		await h.run();
		expect(new Set(readdirSync(dir))).toEqual(before);
	});

	test("restores the original and leaves no backup when the rewrite fails", async () => {
		const h = harness(["channel-review"], {
			onSet: () => chmodSync(dir, 0o500),
		});
		try {
			await expect(h.run()).rejects.toThrow();
		} finally {
			chmodSync(dir, 0o700);
		}
		expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ENV_FILE);
		expect(backups()).toEqual([]);
	});

	test("leaves no backup when the store write fails", async () => {
		await expect(
			harness([], { failSet: true }).run({ keepBackup: true }),
		).rejects.toThrow("store unavailable");
		expect(backups()).toEqual([]);
		expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ENV_FILE);
	});

	test("prints variable names and never values", async () => {
		const h = harness();
		await h.run();
		const printed = h.lines.join("\n");
		expect(printed).toContain(
			"CHANNEL_REVIEW_RELAY_SECRET_DEV to channel-review/relay/dev",
		);
		expect(printed).toContain(
			"DATADOG_ACCESS_TOKEN, DATADOG_SITE to channel-review/datadog",
		);
		expect(printed).toContain(
			"SENTRY_AUTH_TOKEN, SENTRY_ORG to channel-review/sentry",
		);
		for (const value of [
			RELAY,
			DATADOG,
			SENTRY,
			API_KEY,
			"us5.datadoghq.com",
			"example-org",
		]) {
			expect(printed).not.toContain(value);
		}
	});

	test("dry run lists names and changes nothing", async () => {
		const h = harness();
		await h.run({ dryRun: true });
		expect(h.sets).toEqual([]);
		expect(readFileSync(join(dir, ".env"), "utf8")).toBe(ENV_FILE);
		expect(backups()).toEqual([]);
		expect(h.lines).toEqual([
			"would move CHANNEL_REVIEW_RELAY_SECRET_DEV to channel-review/relay/dev",
			"would move DATADOG_ACCESS_TOKEN, DATADOG_SITE to channel-review/datadog",
			"would move SENTRY_AUTH_TOKEN, SENTRY_ORG to channel-review/sentry",
		]);
	});

	test("reads --file when given and needs it when the folder has no mise config", async () => {
		rmSync(join(dir, ".mise"), { recursive: true });
		await expect(harness().run()).rejects.toThrow("Pass --file <path>");
		const other = join(dir, "other.env");
		writeFileSync(other, `SENTRY_AUTH_TOKEN=${SENTRY}\n`, { mode: 0o600 });
		const h = harness(["channel-review"]);
		await h.run({ file: other });
		expect(h.sets.map((entry) => entry.name)).toEqual([
			"channel-review/sentry",
		]);
		expect(readFileSync(other, "utf8")).toBe("");
		expect(existsSync(join(dir, ".env"))).toBe(true);
	});
});
