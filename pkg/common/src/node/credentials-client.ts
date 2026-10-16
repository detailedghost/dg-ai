import {
	type CredentialGrantSummary,
	type CredentialMeta,
	type CredentialRecord,
	type CredentialSummary,
	type CredentialsCliRequest,
	type CredentialsCliResult,
	validateCredentialsCliRequest,
} from "../credentials-format";
import {
	CLI_GRANT_PREFIX_HEADER,
	CLI_GRANT_TOKEN_HEADER,
} from "../cli-wire";
import { DgCliError } from "../errors";
import { CliClient, resolveCliSession } from "./cli-client";
import { readCredentialGrantToken } from "./credential-grants";
import type { DgPaths } from "./paths";
import { isDaemonLive, readPidFile } from "./pidfile";

export const DG_DAEMON_START_COMMAND = "dg-agent start";
const CREDENTIALS_REQUEST_TIMEOUT_MS = 10_000;

export class DaemonNotRunningError extends DgCliError {
	constructor() {
		super(`dg-daemon is not running; start it with ${DG_DAEMON_START_COMMAND}`);
	}
}

export type CredentialClientOptions = {
	paths: DgPaths;
	session?: string;
	/** Authenticates with the service token under `<grantsDir>/<prefix>.token` instead of a session; get and list only. */
	grant?: { prefix: string };
	env?: Record<string, string | undefined>;
};

/** Where resolveCredential found the value; the value itself is never logged. */
export type ResolvedCredential =
	| { value: string; source: "store" }
	| { value: string; source: "env"; envName: string };

export type CredentialClient = {
	set(name: string, value: string, meta?: CredentialMeta): Promise<void>;
	get(name: string): Promise<CredentialRecord | undefined>;
	list(): Promise<CredentialSummary[]>;
	delete(name: string): Promise<boolean>;
	grant(prefix: string): Promise<{ prefix: string; path: string }>;
	revoke(prefix: string): Promise<boolean>;
	listGrants(): Promise<CredentialGrantSummary[]>;
	/** Prefers the store, then the first non-empty named env var; store errors surface only when no env var fills in. */
	resolveCredential(
		name: string,
		options?: { env?: string[] },
	): Promise<ResolvedCredential | undefined>;
	close(): void;
};

type ProtocolError = { type: "error"; sessionId: string };

function isReply(
	value: unknown,
	sessionId: string | undefined,
	requestId: string,
): value is CredentialsCliResult | ProtocolError {
	if (typeof value !== "object" || value === null) return false;
	const frame = value as Record<string, unknown>;
	if (sessionId !== undefined && frame.sessionId !== sessionId) return false;
	if (frame.type === "error") return true;
	return (
		frame.type === "cli-credentials-result" &&
		frame.requestId === requestId &&
		typeof frame.ok === "boolean"
	);
}

function readGrantToken(paths: DgPaths, prefix: string): string {
	try {
		return readCredentialGrantToken(paths, prefix);
	} catch {
		throw new DgCliError(
			`no credential grant for ${prefix}; run dg-skills credentials grant ${prefix}`,
		);
	}
}

/** Talks to the dg-daemon credential store over the authenticated loopback CLI socket. */
export function createCredentialClient(
	options: CredentialClientOptions,
): CredentialClient {
	const env = options.env ?? process.env;
	let connection: Promise<CliClient> | undefined;
	let client: CliClient | undefined;
	let grantAuth: { prefix: string; token: string } | undefined;
	const loadGrant = () => {
		if (!options.grant) return undefined;
		grantAuth ??= {
			prefix: options.grant.prefix,
			token: readGrantToken(options.paths, options.grant.prefix),
		};
		return grantAuth;
	};
	const connect = () =>
		(connection ??= (async () => {
			const handle = readPidFile(options.paths);
			if (!handle) throw new DaemonNotRunningError();
			const grant = loadGrant();
			const session = grant
				? { port: handle.port, sessionId: "", token: "" }
				: resolveCliSession(options.session, options.paths);
			try {
				client = await CliClient.connect(
					session,
					undefined,
					grant && {
						[CLI_GRANT_PREFIX_HEADER]: grant.prefix,
						[CLI_GRANT_TOKEN_HEADER]: grant.token,
					},
				);
				return client;
			} catch {
				if (grant && (await isDaemonLive(handle)))
					throw new DgCliError(
						`dg-daemon refused the credential grant for ${grant.prefix}; run dg-skills credentials grant ${grant.prefix} to rotate it`,
					);
				throw new DaemonNotRunningError();
			}
		})());
	const request = async (
		input: Omit<CredentialsCliRequest, "type" | "requestId">,
	): Promise<unknown> => {
		const requestId = crypto.randomUUID();
		const grant = loadGrant();
		const frame = validateCredentialsCliRequest({
			type: "cli-credentials-request",
			requestId,
			...input,
			...(grant ? { grant } : {}),
		});
		const cli = await connect();
		const reply = await cli.request(
			frame,
			(value): value is CredentialsCliResult | ProtocolError =>
				isReply(value, grant ? undefined : cli.session.sessionId, requestId),
			CREDENTIALS_REQUEST_TIMEOUT_MS,
		);
		if (reply.type === "error")
			throw new DgCliError(
				"This dg-daemon cannot serve credentials. Run dg-skills install, then restart the daemon.",
			);
		if (!reply.ok)
			throw new DgCliError(reply.error || "Credential request failed.");
		return reply.value;
	};
	const get = async (name: string) =>
		((await request({ operation: "get", name })) as CredentialRecord | null) ??
		undefined;
	return {
		set: async (name, value, meta = {}) => {
			await request({ operation: "set", name, value, meta });
		},
		get,
		list: async () =>
			(await request({ operation: "list" })) as CredentialSummary[],
		delete: async (name) =>
			(await request({ operation: "delete", name })) as boolean,
		grant: async (prefix) =>
			(await request({ operation: "grant", prefix })) as {
				prefix: string;
				path: string;
			},
		revoke: async (prefix) =>
			(await request({ operation: "revoke", prefix })) as boolean,
		listGrants: async () =>
			(await request({ operation: "grant-list" })) as CredentialGrantSummary[],
		resolveCredential: async (name, resolveOptions = {}) => {
			let storeError: unknown;
			try {
				const stored = await get(name);
				if (stored) return { value: stored.value, source: "store" };
			} catch (error) {
				storeError = error;
			}
			for (const envName of resolveOptions.env ?? []) {
				const value = env[envName];
				if (value) return { value, source: "env", envName };
			}
			if (storeError) throw storeError;
			return undefined;
		},
		close: () => client?.close(),
	};
}
