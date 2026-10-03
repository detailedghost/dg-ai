import { Command } from "commander";
import { CliClient, resolveCliSession } from "@dg/dg-agent/client";
import { main, redactPublicValue, type InboxRuntime } from "@dg/inbox";
import {
	INBOX_DEFAULT_TIMEOUT_MS,
	validateInboxProfile,
	validateInboxProfileName,
	validateInboxProvider,
	validateInboxBrowserResponse,
	validateInboxAuthCache,
	validateInboxCliRequest,
	type InboxCliRequest,
	type InboxCliResult,
	type InboxProfile,
	type InboxProviderSettings,
} from "@dg/common";

const profileHelp = `Profile configuration:
  inbox profile list [--session ID]
  inbox profile get NAME [--session ID]
  inbox profile set NAME --json JSON | --file PATH
  inbox profile set NAME --provider protonmail|gmail|outlook [settings]
Settings: --client-id --client-secret-env --access-token-env --refresh-token-env
  --tenant-id --authority --redirect-uri --auth-mode --scopes --page-size
  --tab-id --account-hint --login-hint
Use --account-profile NAME for workflows; --session ID selects a dg session.
Start a session with dg-agent start --open. Profiles and OAuth caches use
dg-ai's encrypted database. Secrets are environment references only.`;

function stripSession(args: string[]): { args: string[]; session?: string } {
	const forwarded: string[] = [];
	let session: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const value = args[i];
		if (value === "--session" || value.startsWith("--session=")) {
			if (session !== undefined)
				throw new Error("Choose one --session ID for inbox commands.");
			session = value === "--session" ? args[++i] : value.slice(10);
			if (!session || session.startsWith("--"))
				throw new Error("--session requires a session ID.");
		} else forwarded.push(value);
	}
	return { args: forwarded, session };
}

function isResult(
	value: unknown,
	sessionId: string,
	requestId: string,
): value is InboxCliResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "cli-inbox-result" &&
		"sessionId" in value &&
		value.sessionId === sessionId &&
		"requestId" in value &&
		value.requestId === requestId &&
		"ok" in value &&
		typeof value.ok === "boolean"
	);
}

type ProtocolError = { type: "error"; sessionId: string };
function isProtocolError(
	value: unknown,
	sessionId: string,
): value is ProtocolError {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "error" &&
		"sessionId" in value &&
		value.sessionId === sessionId
	);
}

function daemonRuntime(session?: string) {
	let connection: Promise<CliClient> | undefined;
	let client: CliClient | undefined;
	const connect = () =>
		(connection ??= (async () => {
			try {
				client = await CliClient.connect(resolveCliSession(session));
				return client;
			} catch {
				throw new Error(
					"Inbox profile or live mail access requires a dg daemon session. Run dg-agent start --open, then pass --session ID (or use that session's working directory). Run dg-skills install if the binaries need updating.",
				);
			}
		})());
	const request = async (
		input: Omit<InboxCliRequest, "type" | "requestId">,
	): Promise<unknown> => {
		const requestId = crypto.randomUUID();
		const frame = validateInboxCliRequest({
			type: "cli-inbox-request",
			requestId,
			...input,
		});
		const cli = await connect();
		let result: InboxCliResult | ProtocolError;
		try {
			const timeout =
				frame.operation === "browser"
					? (frame.timeoutMs ?? INBOX_DEFAULT_TIMEOUT_MS) + 5_000
					: 10_000;
			result = await cli.request(
				frame,
				(value): value is InboxCliResult | ProtocolError =>
					isResult(value, cli.session.sessionId, requestId) ||
					isProtocolError(value, cli.session.sessionId),
				timeout,
			);
		} catch {
			throw new Error(
				"Inbox daemon did not complete the request. Check the session, run dg-skills install, then restart the daemon and run dg-agent start --open.",
			);
		}
		if (result.type === "error")
			throw new Error(
				"This daemon cannot complete inbox requests. Run dg-skills install, then restart the daemon and run dg-agent start --open.",
			);
		if (!result.ok)
			throw new Error(
				result.error ||
					"Inbox daemon request failed. Check the session and retry.",
			);
		return result.value;
	};
	const runtime: InboxRuntime = {
		profileGet: async (name) => {
			const value = await request({ operation: "profile-get", name });
			return value === null ? null : validateInboxProfile(value);
		},
		profileSet: async (name, profile) => {
			await request({ operation: "profile-set", name, profile });
		},
		authCacheGet: async (name, provider) => {
			const value = await request({ operation: "cache-get", name, provider });
			return value === null ? null : validateInboxAuthCache(value);
		},
		authCacheSet: async (name, provider, cache) => {
			await request({ operation: "cache-set", name, provider, cache });
		},
		browserRequest: async (browser) =>
			validateInboxBrowserResponse(
				await request({ operation: "browser", request: browser }),
			),
	};
	return { runtime, request, close: () => client?.close() };
}

function flags(args: string[]): Map<string, string> {
	const values = new Map<string, string>();
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (!flag.startsWith("--"))
			throw new Error(
				"Profile settings require named flags. See dg-skills inbox profile --help.",
			);
		const equal = flag.indexOf("=");
		const key = flag.slice(2, equal === -1 ? undefined : equal);
		const value = equal === -1 ? args[++i] : flag.slice(equal + 1);
		if (value === undefined || value.startsWith("--"))
			throw new Error("Profile --" + key + " requires a value.");
		if (values.has(key))
			throw new Error("Profile --" + key + " may only be supplied once.");
		values.set(key, value);
	}
	return values;
}

async function profileFromFlags(args: string[]): Promise<InboxProfile> {
	const values = flags(args);
	const json = values.get("json"),
		file = values.get("file");
	if (json !== undefined || file !== undefined) {
		if (values.size !== 1)
			throw new Error(
				"Use one --json or --file profile document without extra settings.",
			);
		let profile: unknown;
		try {
			profile =
				json !== undefined ? JSON.parse(json) : await Bun.file(file!).json();
		} catch {
			throw new Error(
				"Profile document must be readable valid JSON with no inline secrets.",
			);
		}
		return validateInboxProfile(profile);
	}
	const provider = validateInboxProvider(values.get("provider"));
	const profile: InboxProfile = { provider };
	const settings: InboxProviderSettings = {};
	for (const [key, value] of values) {
		switch (key) {
			case "provider":
				break;
			case "tab-id":
				profile.tabId = Number(value);
				break;
			case "account-hint":
				profile.accountHint = value;
				break;
			case "client-id":
				settings.clientId = value;
				break;
			case "client-secret-env":
				settings.clientSecretEnv = value;
				break;
			case "access-token-env":
				settings.accessTokenEnv = value;
				break;
			case "refresh-token-env":
				settings.refreshTokenEnv = value;
				break;
			case "tenant-id":
				settings.tenantId = value;
				break;
			case "authority":
				settings.authority = value;
				break;
			case "redirect-uri":
				settings.redirectUri = value;
				break;
			case "auth-mode": {
				if (!["browser", "device-code", "env", "silent"].includes(value))
					throw new Error(
						"Choose browser, device-code, env, or silent authentication.",
					);
				settings.authMode = value as InboxProviderSettings["authMode"];
				break;
			}
			case "scopes":
				settings.scopes = value.split(/[,\s]+/).filter(Boolean);
				break;
			case "page-size":
				settings.pageSize = Number(value);
				break;
			case "login-hint":
				if (provider === "gmail") profile.accountHint = value;
				else settings.loginHint = value;
				break;
			default:
				throw new Error(
					"Unsupported inbox profile option --" +
						key +
						". Secrets must be environment-variable references.",
				);
		}
	}
	if (Object.keys(settings).length) {
		if (provider === "protonmail")
			throw new Error(
				"Proton profiles use tab-id and account-hint; OAuth settings belong to Gmail or Outlook.",
			);
		profile[provider] = settings;
	}
	return validateInboxProfile(profile);
}

function output(value: unknown): void {
	console.log(JSON.stringify(redactPublicValue(value)));
}

/** Forwards raw workflow arguments, injects private daemon hooks lazily, redacts public errors, and closes the connection. */
export async function runInbox(rawArgs: string[]): Promise<void> {
	const { args, session } = stripSession(rawArgs);
	if (
		args[0] !== "profile" &&
		(args.includes("--help") || args.includes("-h") || args.length === 0)
	) {
		await main(["--help"]);
		console.log("\n" + profileHelp);
		return;
	}
	const daemon = daemonRuntime(session);
	try {
		if (args[0] === "profile") {
			if (args.includes("--help") || args.includes("-h") || args.length === 1) {
				console.log(profileHelp);
				return;
			}
			const action = args[1];
			if (action === "list") {
				if (args.length !== 2)
					throw new Error("Profile list accepts only --session ID.");
				output({
					kind: "inbox-profiles",
					profiles: await daemon.request({ operation: "profile-list" }),
				});
				return;
			}
			if (action !== "get" && action !== "set")
				throw new Error(
					"Inbox profile supports set, get, and list. OAuth cache contents are private.",
				);
			const name = validateInboxProfileName(args[2]);
			if (action === "get") {
				if (args.length !== 3)
					throw new Error(
						"Profile get requires one name and optional --session ID.",
					);
				output({
					kind: "inbox-profile",
					name,
					profile: await daemon.runtime.profileGet!(name),
				});
				return;
			}
			const profile = await profileFromFlags(args.slice(3));
			await daemon.runtime.profileSet!(name, profile);
			output({ kind: "inbox-profile-saved", name, profile });
			return;
		}
		const fixture = args.some(
			(arg) =>
				arg === "--data-path" ||
				arg.startsWith("--data-path=") ||
				arg === "--gmail-data-path" ||
				arg.startsWith("--gmail-data-path="),
		);
		await main(args, fixture ? {} : daemon.runtime);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Inbox command failed.";
		throw new Error(String(redactPublicValue(message)));
	} finally {
		daemon.close();
	}
}

/** Registers pass-through inbox/profile commands so Commander preserves provider-specific workflow flags. */
export function registerInbox(program: Command): void {
	program
		.command("inbox")
		.description(
			"Review Proton Mail, Gmail, and Outlook with redacted inbox workflows and DB profiles.",
		)
		.helpOption(false)
		.allowUnknownOption()
		.allowExcessArguments()
		.passThroughOptions()
		.argument("[args...]", "Inbox workflow or profile arguments")
		.action(async (args: string[]) => {
			await runInbox(args);
		});
}
