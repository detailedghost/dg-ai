import { type CredentialRecord, describeError } from "@dg/common";
import {
	type CredentialClient,
	createCredentialClient,
	DG_DAEMON_START_COMMAND,
	resolveDgPaths,
	type SystemSeams,
} from "@dg/common/node";
import { datadogAuthHeaders } from "./sinks/datadog";

export const CREDENTIAL_PREFIX = "channel-review";
export const DATADOG_CREDENTIAL = `${CREDENTIAL_PREFIX}/datadog`;
export const SENTRY_CREDENTIAL = `${CREDENTIAL_PREFIX}/sentry`;

export function relayCredentialName(envName: string): string {
	return `${CREDENTIAL_PREFIX}/relay/${envName}`;
}

export function localSecretName(envName: string): string {
	return `CHANNEL_REVIEW_RELAY_SECRET_${envName.toUpperCase()}`;
}

export type CredentialSource = Pick<CredentialClient, "list" | "get" | "close">;
export type SecretSource = "store" | "env" | "aws" | "missing";
export type SecretStatus = {
	name: string;
	source: SecretSource;
	expiresAt?: string;
	expired?: true;
};
export type SecretKind = "relay" | "datadog" | "sentry";
export type ResolvedSecrets = {
	env: Record<string, string | undefined>;
	secrets: Record<SecretKind, SecretStatus>;
	warning?: string;
};

const SINK_ENV_NAMES = [
	"DATADOG_ACCESS_TOKEN",
	"DATADOG_API_KEY",
	"DATADOG_APP_KEY",
	"DATADOG_SITE",
	"SENTRY_AUTH_TOKEN",
	"SENTRY_ORG",
	"SENTRY_BASE_URL",
];

export function createGrantCredentialSource(
	system: SystemSeams = {},
): CredentialSource {
	return createCredentialClient({
		paths: resolveDgPaths(system),
		grant: { prefix: CREDENTIAL_PREFIX },
	});
}

function metaText(
	record: CredentialRecord | undefined,
	key: string,
): string | undefined {
	const value = record?.meta[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}

async function readStore(
	source: CredentialSource,
	names: string[],
): Promise<{ records: Map<string, CredentialRecord>; warning?: string }> {
	const records = new Map<string, CredentialRecord>();
	try {
		const listed = new Set((await source.list()).map((entry) => entry.name));
		for (const name of names) {
			if (!listed.has(name)) continue;
			const record = await source.get(name);
			if (record) records.set(name, record);
		}
		return { records };
	} catch (error) {
		return {
			records,
			warning: [
				`credential store unavailable (${describeError(error)}); using environment variables.`,
				`To fix: run ${DG_DAEMON_START_COMMAND}, then dg-skills credentials grant ${CREDENTIAL_PREFIX}.`,
			].join(" "),
		};
	} finally {
		source.close();
	}
}

function isExpired(record: CredentialRecord, now: Date): boolean {
	const expiresAt = metaText(record, "expiresAt");
	return expiresAt !== undefined && Date.parse(expiresAt) < now.getTime();
}

function status(
	name: string,
	record: CredentialRecord | undefined,
	fallback: SecretSource,
	expired: boolean,
): SecretStatus {
	if (!record) return { name, source: fallback };
	const expiresAt = metaText(record, "expiresAt");
	return {
		name,
		source: expired ? fallback : "store",
		...(expiresAt ? { expiresAt } : {}),
		...(expired ? { expired: true as const } : {}),
	};
}

/** Env-like map for sinks and relay connect: unexpired store records first, then env. */
export async function resolveSecrets({
	envName,
	env,
	source,
	now = () => new Date(),
}: {
	envName: string;
	env: Record<string, string | undefined>;
	source: CredentialSource;
	now?: () => Date;
}): Promise<ResolvedSecrets> {
	const relayName = relayCredentialName(envName);
	const relayEnv = localSecretName(envName);
	const { records, warning } = await readStore(source, [
		relayName,
		DATADOG_CREDENTIAL,
		SENTRY_CREDENTIAL,
	]);
	const resolved: Record<string, string | undefined> = Object.fromEntries(
		[relayEnv, ...SINK_ENV_NAMES].map((key) => [
			key,
			env[key]?.trim() || undefined,
		]),
	);
	const at = now();
	const expiredNames = new Set<string>();
	const usable = (name: string): CredentialRecord | undefined => {
		const record = records.get(name);
		if (!record || !isExpired(record, at)) return record;
		expiredNames.add(name);
		return undefined;
	};
	const relay = usable(relayName);
	const datadog = usable(DATADOG_CREDENTIAL);
	const sentry = usable(SENTRY_CREDENTIAL);
	const relayFallback = resolved[relayEnv] ? "env" : "aws";
	const datadogFallback =
		"headers" in datadogAuthHeaders(resolved) ? "env" : "missing";
	const sentryFallback = resolved.SENTRY_AUTH_TOKEN ? "env" : "missing";
	if (relay) resolved[relayEnv] = relay.value;
	if (datadog) {
		resolved.DATADOG_ACCESS_TOKEN = datadog.value;
		resolved.DATADOG_SITE = metaText(datadog, "site") ?? resolved.DATADOG_SITE;
	}
	if (sentry) {
		resolved.SENTRY_AUTH_TOKEN = sentry.value;
		resolved.SENTRY_BASE_URL =
			metaText(sentry, "site") ?? resolved.SENTRY_BASE_URL;
		resolved.SENTRY_ORG = metaText(sentry, "org") ?? resolved.SENTRY_ORG;
	}
	const expiredWarning =
		expiredNames.size > 0
			? `expired credentials skipped: ${[...expiredNames].join(", ")}; run dg-skills channel-review connect to renew.`
			: undefined;
	const allWarnings = [warning, expiredWarning].filter(Boolean).join(" ");
	return {
		env: resolved,
		secrets: {
			relay: status(relayName, records.get(relayName), relayFallback, expiredNames.has(relayName)),
			datadog: status(DATADOG_CREDENTIAL, records.get(DATADOG_CREDENTIAL), datadogFallback, expiredNames.has(DATADOG_CREDENTIAL)),
			sentry: status(SENTRY_CREDENTIAL, records.get(SENTRY_CREDENTIAL), sentryFallback, expiredNames.has(SENTRY_CREDENTIAL)),
		},
		...(allWarnings ? { warning: allWarnings } : {}),
	};
}
