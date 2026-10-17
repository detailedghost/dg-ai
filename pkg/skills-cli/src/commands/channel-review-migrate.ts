import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv as parseDotEnv } from "node:util";
import {
	DATADOG_CREDENTIAL,
	localSecretName,
	relayCredentialName,
	SENTRY_CREDENTIAL,
} from "@dg/channel-review";
import { type CredentialMeta, DgCliError, REDACTED } from "@dg/common";
import { writeFileAtomic } from "@dg/common/node";
import { type ConnectClient, ensureGrant } from "./channel-review-connect";

const MISE_CONFIGS = [".mise/config.toml", ".mise.toml", "mise.toml"];
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

export type MigrateFlags = {
	file?: string;
	dryRun?: boolean;
	session?: string;
};

export type MigrateDeps = {
	createClient(session?: string): ConnectClient;
	write(line: string): void;
	now(): Date;
	cwd(): string;
};

type Migration = {
	name: string;
	secret: string;
	meta: Record<string, string>;
	extras: Record<string, string>;
};

type Entry = { indices: number[]; value: string };

function parseEnv(lines: string[]): Map<string, Entry> {
	const entries = new Map<string, Entry>();
	for (let index = 0; index < lines.length; index++) {
		const match = lines[index]?.match(ENV_LINE);
		if (!match?.[1]) continue;
		const start = index;
		const raw = match[2] ?? "";
		const quote = raw[0];
		if (quote === '"' || quote === "'" || quote === "`") {
			let tail = raw.slice(1);
			while (!tail.includes(quote)) {
				index++;
				if (index >= lines.length)
					throw new DgCliError(
						`Unterminated quoted env assignment at line ${start + 1}.`,
					);
				tail += `\n${lines[index]}`;
			}
		}
		const value = parseDotEnv(lines.slice(start, index + 1).join("\n"))[
			match[1]
		];
		if (value === undefined) continue;
		const indices = entries.get(match[1])?.indices ?? [];
		for (let line = start; line <= index; line++) indices.push(line);
		entries.set(match[1], { indices, value });
	}
	return entries;
}

function plan(entries: Map<string, Entry>): Migration[] {
	const candidates: Migration[] = [
		...(["dev", "prod"] as const).map((envName) => ({
			name: relayCredentialName(envName),
			secret: localSecretName(envName),
			meta: { provider: "relay" },
			extras: {},
		})),
		{
			name: DATADOG_CREDENTIAL,
			secret: "DATADOG_ACCESS_TOKEN",
			meta: { provider: "datadog" },
			extras: { DATADOG_SITE: "site" },
		},
		{
			name: SENTRY_CREDENTIAL,
			secret: "SENTRY_AUTH_TOKEN",
			meta: { provider: "sentry" },
			extras: { SENTRY_BASE_URL: "site", SENTRY_ORG: "org" },
		},
	];
	return candidates.filter((migration) => entries.get(migration.secret)?.value);
}

function variables(
	migration: Migration,
	entries: Map<string, Entry>,
): string[] {
	return [
		migration.secret,
		...Object.keys(migration.extras).filter((key) => entries.get(key)?.value),
	];
}

function defaultEnvFile(cwd: string): string {
	if (!MISE_CONFIGS.some((name) => existsSync(join(cwd, name))))
		throw new DgCliError(`No mise config in ${cwd}. Pass --file <path>.`);
	return join(cwd, ".env");
}

function stamp(now: Date): string {
	return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
}

function redactAssignment(line: string): string {
	const match = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=/);
	if (!match) return REDACTED;
	return `${match[1] ?? ""}${match[2]}=${REDACTED}`;
}

function redactMovedLines(lines: string[], removed: Set<number>): string {
	return lines
		.map((line, index) => (removed.has(index) ? redactAssignment(line) : line))
		.join("\n");
}

/** Replaces known secret values anywhere they remain, longest first. */
function redactValues(text: string, secrets: readonly string[]): string {
	const unique = [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
		(left, right) => right.length - left.length,
	);
	return unique.reduce(
		(current, secret) => current.split(secret).join(REDACTED),
		text,
	);
}

/** Moves known channel-review secrets from a .env file into the store and deletes only their lines. The backup keeps the file shape with those values redacted. Prints names, never values. */
export async function runMigrateEnv(
	flags: MigrateFlags,
	deps: MigrateDeps,
): Promise<void> {
	const file = flags.file ?? defaultEnvFile(deps.cwd());
	if (!existsSync(file)) throw new DgCliError(`${file} does not exist.`);
	const originalStat = lstatSync(file);
	if (!originalStat.isFile())
		throw new DgCliError("The env file must be a regular file, not a symlink.");
	const original = readFileSync(file, "utf8");
	const lines = original.split("\n");
	const entries = parseEnv(lines);
	const migrations = plan(entries);
	if (migrations.length === 0) {
		deps.write(`No channel-review secrets found in ${file}.`);
		return;
	}
	for (const migration of migrations)
		deps.write(
			`${flags.dryRun ? "would move" : "moving"} ${variables(migration, entries).join(", ")} to ${migration.name}`,
		);
	if (flags.dryRun) return;

	const client = deps.createClient(flags.session);
	try {
		for (const migration of migrations) {
			const meta: CredentialMeta = {
				...migration.meta,
				createdBy: "migrate-env",
			};
			for (const [key, field] of Object.entries(migration.extras)) {
				const entry = entries.get(key);
				if (entry?.value) meta[field] = entry.value;
			}
			await client.set(
				migration.name,
				entries.get(migration.secret)?.value ?? "",
				meta,
			);
		}
		await ensureGrant(client, deps.write);
	} finally {
		client.close();
	}

	const removed = new Set(
		migrations.flatMap((migration) =>
			variables(migration, entries).flatMap(
				(key) => entries.get(key)?.indices ?? [],
			),
		),
	);
	const currentStat = lstatSync(file);
	if (
		!currentStat.isFile() ||
		currentStat.ino !== originalStat.ino ||
		currentStat.mode !== originalStat.mode ||
		readFileSync(file, "utf8") !== original
	)
		throw new DgCliError(
			"The env file changed during migration; its lines were left intact. Run migrate-env again.",
		);
	const movedSecrets = migrations.flatMap((migration) => {
		const value = entries.get(migration.secret)?.value;
		return value ? [value] : [];
	});
	const backup = `${file}.bak-${stamp(deps.now())}`;
	const redacted = redactValues(redactMovedLines(lines, removed), movedSecrets);
	writeFileSync(backup, redacted, { mode: 0o600, flag: "wx" });
	writeFileAtomic(
		file,
		lines.filter((_, index) => !removed.has(index)).join("\n"),
		originalStat.mode & 0o777,
	);
	deps.write(`removed those lines from ${file}; redacted backup at ${backup}`);
}
