import type { CredentialMeta, CredentialRecord, CredentialSummary } from "@dg/common";
import {
	type CredentialClient,
	createCredentialClient,
	resolveDgPaths,
} from "@dg/common/node";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";

const CREDENTIAL_PREFIX = "db/";

export interface ConnectionConfig {
	engine: "postgresql" | "snowflake";
	host?: string;
	port?: number;
	database?: string;
	schema?: string;
	user?: string;
	password?: string;
	account?: string;
	warehouse?: string;
	authenticator?: string;
	privateKeyPath?: string;
	passphrase?: string;
	role?: string;
	clientStoreTemporaryCredential?: boolean;
	browserActionTimeout?: number;
	ssl?: boolean;
}

export type DbCredentialClient = Pick<CredentialClient, "get" | "list" | "close">;

export function createDbCredentialClient(): DbCredentialClient {
	return createCredentialClient({ paths: resolveDgPaths() });
}

function optionalString(
	meta: CredentialMeta,
	key: string,
	connectionName: string,
): string | undefined {
	const value = meta[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string")
		throw new Error(
			`connection "${connectionName}" has invalid ${key} metadata — expected a string`,
		);
	return value;
}

function optionalInteger(
	meta: CredentialMeta,
	key: string,
	connectionName: string,
): number | undefined {
	const value = meta[key];
	if (value === undefined) return undefined;
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim() !== ""
				? Number(value)
				: Number.NaN;
	if (!Number.isSafeInteger(parsed) || parsed <= 0)
		throw new Error(
			`connection "${connectionName}" has invalid ${key} metadata — expected a positive integer`,
		);
	return parsed;
}

function optionalBoolean(
	meta: CredentialMeta,
	key: string,
	connectionName: string,
): boolean | undefined {
	const value = meta[key];
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(
		`connection "${connectionName}" has invalid ${key} metadata — expected true or false`,
	);
}

function requireMetadata(
	value: string | undefined,
	key: string,
	connectionName: string,
): string {
	if (value) return value;
	throw new Error(
		`connection "${connectionName}" is missing required ${key} metadata`,
	);
}

function resolvePrivateKeyPath(path: string): string {
	const expanded = path.replace(/^~(?=$|\/)/, homedir());
	if (!existsSync(expanded)) throw new Error(`private key not found: ${expanded}`);
	if (process.platform === "win32") return expanded;
	const mode = statSync(expanded).mode & 0o777;
	if (mode !== 0o600 && mode !== 0o400)
		throw new Error(
			`private key ${expanded} has permissions ${mode.toString(8)} — expected 600 or 400`,
		);
	return expanded;
}

function connectionFromRecord(
	name: string,
	record: CredentialRecord,
): ConnectionConfig {
	const { meta } = record;
	const engine = optionalString(meta, "engine", name);
	if (engine !== "postgresql" && engine !== "snowflake")
		throw new Error(
			`connection "${name}" has invalid engine "${engine}" — must be postgresql or snowflake`,
		);

	const secret = record.value; // external_browser stores a non-secret placeholder that must never reach the SDK.
	const config: ConnectionConfig = {
		engine,
		host: optionalString(meta, "host", name),
		port: optionalInteger(meta, "port", name),
		database: optionalString(meta, "database", name),
		schema: optionalString(meta, "schema", name),
		user: optionalString(meta, "user", name),
		account: optionalString(meta, "account", name),
		warehouse: optionalString(meta, "warehouse", name),
		role: optionalString(meta, "role", name),
		authenticator: optionalString(meta, "authenticator", name),
		ssl: optionalBoolean(meta, "ssl", name),
		clientStoreTemporaryCredential: optionalBoolean(
			meta,
			"clientStoreTemporaryCredential",
			name,
		),
		browserActionTimeout: optionalInteger(meta, "browserActionTimeout", name),
	};

	if (engine === "postgresql") {
		config.database = requireMetadata(config.database, "database", name);
		config.user = requireMetadata(config.user, "user", name);
		config.password = secret;
		return config;
	}

	config.account = requireMetadata(config.account, "account", name);
	config.user = requireMetadata(config.user, "user", name);
	const auth = config.authenticator?.toLowerCase();
	if (auth === "external_browser" || auth === "externalbrowser") return config;

	const privateKeyPath = optionalString(meta, "privateKeyPath", name);
	if (auth === "snowflake_jwt" || privateKeyPath) {
		if (!privateKeyPath)
			throw new Error(
				`connection "${name}" is missing required privateKeyPath metadata`,
			);
		config.privateKeyPath = resolvePrivateKeyPath(privateKeyPath);
		config.passphrase = secret;
		return config;
	}

	config.password = secret;
	return config;
}

function names(entries: CredentialSummary[]): string[] {
	return entries
		.filter((entry) => entry.name.startsWith(CREDENTIAL_PREFIX))
		.map((entry) => entry.name.slice(CREDENTIAL_PREFIX.length));
}

export async function getConnection(
	client: DbCredentialClient,
	name: string,
): Promise<ConnectionConfig> {
	const record = await client.get(`${CREDENTIAL_PREFIX}${name}`);
	if (!record) {
		const available = names(await client.list()).join(", ");
		throw new Error(
			`connection "${name}" not found — available: ${available || "(none)"}`,
		);
	}
	return connectionFromRecord(name, record);
}

export async function listConnections(
	client: DbCredentialClient,
): Promise<Array<{ name: string; engine: string; target: string }>> {
	return (await client.list())
		.filter((entry) => entry.name.startsWith(CREDENTIAL_PREFIX))
		.map((entry) => {
			const name = entry.name.slice(CREDENTIAL_PREFIX.length);
			const engine =
				typeof entry.meta.engine === "string" ? entry.meta.engine : "unknown";
			let target = "unknown";
			if (engine === "postgresql") {
				const host =
					typeof entry.meta.host === "string" ? entry.meta.host : "localhost";
				const port =
					typeof entry.meta.port === "string" ||
					typeof entry.meta.port === "number"
						? entry.meta.port
						: 5432;
				const database =
					typeof entry.meta.database === "string" ? entry.meta.database : "";
				target = `${host}:${port}/${database}`;
			} else if (engine === "snowflake") {
				const account =
					typeof entry.meta.account === "string" ? entry.meta.account : "?";
				const database =
					typeof entry.meta.database === "string" ? entry.meta.database : "";
				target = `${account}/${database}`;
			}
			return { name, engine, target };
		});
}
