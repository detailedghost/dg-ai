import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node/dg-paths";
import type { AppConfig, PartialAppConfig } from "./types";

type Env = Record<string, string | undefined>;

/** The inbox settings from built-in defaults and the env vars in `env`. */
export function inboxDefaults(env: Env = process.env): AppConfig {
	return {
		configHome:
			env.EMAIL_ORGANIZER_HOME ??
			env.EMAIL_ORGANIZER_CONFIG_HOME ??
			join(resolveDgPaths({ env }).stateDir, "inbox", "config"),
		provider: providerFromEnv(env.EMAIL_ORGANIZER_PROVIDER),
		protonmail: {
			sessionProfile: "dg-extension",
			apiBaseUrl:
				env.PROTONMAIL_API_BASE_URL ?? "https://mail.proton.me/api",
			mailboxUrl: env.PROTONMAIL_MAILBOX_URL,
			apiAppVersion:
				env.PROTONMAIL_API_APP_VERSION ?? "web-mail@5.0.120.8",
			liveBrowser: true,
			browserType:
				env.PROTONMAIL_BROWSER_TYPE ??
				inferBrowserType(env.PROTONMAIL_BROWSER_EXECUTABLE_PATH),
			browserHeadless: env.PROTONMAIL_BROWSER_HEADLESS === "true",
			browserExecutablePath: env.PROTONMAIL_BROWSER_EXECUTABLE_PATH,
			browserTimeoutMs: Number(
				env.PROTONMAIL_BROWSER_TIMEOUT_MS ?? 60_000,
			),
			snippetLength: Number(env.PROTONMAIL_SNIPPET_LENGTH ?? 160),
			batchSize: Number(env.PROTONMAIL_BATCH_SIZE ?? 200),
			debugRaw: env.PROTONMAIL_DEBUG_RAW === "true",
			dataPath: env.PROTONMAIL_DATA_PATH,
			endpoints: {
				folders: env.PROTONMAIL_FOLDERS_PATH ?? "/core/v4/labels?Type=1",
				labels: env.PROTONMAIL_LABELS_PATH ?? "/core/v4/labels",
				filters: env.PROTONMAIL_FILTERS_PATH ?? "/mail/v4/filters",
				messages: env.PROTONMAIL_MESSAGES_PATH ?? "/mail/v4/messages",
				moveMessages:
					env.PROTONMAIL_MOVE_MESSAGES_PATH ?? "/mail/v4/messages/label",
				unlabelMessages:
					env.PROTONMAIL_UNLABEL_MESSAGES_PATH ??
					"/mail/v4/messages/unlabel",
				markRead:
					env.PROTONMAIL_MARK_READ_PATH ?? "/mail/v4/messages/read",
			},
		},
		gmail: {
			apiBaseUrl:
				env.GMAIL_API_BASE_URL ?? "https://gmail.googleapis.com/gmail/v1",
			authMode: gmailAuthMode(env.GOOGLE_AUTH_MODE),
			clientId: env.GOOGLE_CLIENT_ID,
			clientSecretEnv: "GOOGLE_CLIENT_SECRET",
			accessTokenEnv: "GOOGLE_ACCESS_TOKEN",
			refreshTokenEnv: "GOOGLE_REFRESH_TOKEN",
			openBrowserCommand: env.GOOGLE_BROWSER_OPEN_COMMAND,
			redirectUri:
				env.GOOGLE_REDIRECT_URI ?? "http://127.0.0.1:0/oauth2/callback",
			tokenCachePath:
				env.GOOGLE_TOKEN_CACHE_PATH ??
				"./email-cleanup/google-token-cache.json",
			allowPlaintextTokenCache: false,
			pageSize: Number(env.GMAIL_PAGE_SIZE ?? 100),
			batchSize: Number(env.GMAIL_BATCH_SIZE ?? 200),
			snippetLength: Number(env.GMAIL_SNIPPET_LENGTH ?? 160),
			maxConcurrency: Number(env.GMAIL_MAX_CONCURRENCY ?? 10),
			debugRaw: env.GMAIL_DEBUG_RAW === "true",
			dataPath: env.GMAIL_DATA_PATH,
			scopes: {
				read: ["https://www.googleapis.com/auth/gmail.readonly"],
				modify: ["https://www.googleapis.com/auth/gmail.modify"],
				settings: ["https://www.googleapis.com/auth/gmail.settings.basic"],
			},
		},
		outlook: {
			accountProfile: env.MICROSOFT_ACCOUNT_PROFILE,
			clientId: env.MICROSOFT_CLIENT_ID,
			clientSecretEnv: "MICROSOFT_CLIENT_SECRET",
			accessTokenEnv: "MICROSOFT_ACCESS_TOKEN",
			loginHint: env.MICROSOFT_LOGIN_HINT,
			redirectUri:
				env.MICROSOFT_REDIRECT_URI ??
				(env.MICROSOFT_CLIENT_SECRET
					? "http://localhost:3000"
					: "http://localhost:0"),
			tenantId: env.MICROSOFT_TENANT_ID ?? "organizations",
			authority:
				env.MICROSOFT_AUTHORITY ?? "https://login.microsoftonline.com",
			authMode: outlookAuthMode(env.MICROSOFT_AUTH_MODE),
			tokenCachePath:
				env.MICROSOFT_TOKEN_CACHE_PATH ??
				"./email-cleanup/outlook-token-cache.json",
			allowPlaintextTokenCache: false,
			openBrowserCommand: env.MICROSOFT_BROWSER_OPEN_COMMAND,
			graphBaseUrl:
				env.MICROSOFT_GRAPH_BASE_URL ??
				"https://graph.microsoft.com/v1.0",
			snippetLength: Number(env.OUTLOOK_SNIPPET_LENGTH ?? 160),
			batchSize: Number(env.OUTLOOK_BATCH_SIZE ?? 200),
			pageSize: Math.min(Number(env.OUTLOOK_PAGE_SIZE ?? 50), 50),
			debugRaw: env.OUTLOOK_DEBUG_RAW === "true",
			dataPath: env.OUTLOOK_DATA_PATH,
			scopes: {
				read: (env.MICROSOFT_READ_SCOPES ?? "Mail.Read,User.Read")
					.split(",")
					.map((scope) => scope.trim())
					.filter(Boolean),
				write: (env.MICROSOFT_WRITE_SCOPES ?? "Mail.ReadWrite")
					.split(",")
					.map((scope) => scope.trim())
					.filter(Boolean),
				rules: (env.MICROSOFT_RULE_SCOPES ?? "MailboxSettings.Read")
					.split(",")
					.map((scope) => scope.trim())
					.filter(Boolean),
			},
		},
		classifier: {
			mode: classifierMode(env.CLASSIFIER_MODE),
			model: env.OPENAI_MODEL ?? "gpt-4.1-nano",
			confidenceThreshold: Number(
				env.CLASSIFIER_CONFIDENCE_THRESHOLD ?? 0.75,
			),
		},
		output: {
			reportsDir: env.ORGANIZER_REPORTS_DIR ?? "data/reports",
			codexDir: env.ORGANIZER_CODEX_DIR ?? "data/codex",
			auditDir: env.ORGANIZER_AUDIT_DIR ?? "data/audit",
		},
		routeProfiles: {},
		security: {
			allowRawDebugPaths: [],
		},
	};
}

export const defaultConfig: AppConfig = inboxDefaults(process.env);

export const ENV_PATHS: readonly (readonly [string, ...string[]])[] = [
	["configHome", "EMAIL_ORGANIZER_HOME", "EMAIL_ORGANIZER_CONFIG_HOME"],
	["provider", "EMAIL_ORGANIZER_PROVIDER"],
	["protonmail.apiBaseUrl", "PROTONMAIL_API_BASE_URL"],
	["protonmail.mailboxUrl", "PROTONMAIL_MAILBOX_URL"],
	["protonmail.apiAppVersion", "PROTONMAIL_API_APP_VERSION"],
	["protonmail.browserType", "PROTONMAIL_BROWSER_TYPE", "PROTONMAIL_BROWSER_EXECUTABLE_PATH"],
	["protonmail.browserHeadless", "PROTONMAIL_BROWSER_HEADLESS"],
	["protonmail.browserExecutablePath", "PROTONMAIL_BROWSER_EXECUTABLE_PATH"],
	["protonmail.browserTimeoutMs", "PROTONMAIL_BROWSER_TIMEOUT_MS"],
	["protonmail.snippetLength", "PROTONMAIL_SNIPPET_LENGTH"],
	["protonmail.batchSize", "PROTONMAIL_BATCH_SIZE"],
	["protonmail.debugRaw", "PROTONMAIL_DEBUG_RAW"],
	["protonmail.dataPath", "PROTONMAIL_DATA_PATH"],
	["protonmail.endpoints.folders", "PROTONMAIL_FOLDERS_PATH"],
	["protonmail.endpoints.labels", "PROTONMAIL_LABELS_PATH"],
	["protonmail.endpoints.filters", "PROTONMAIL_FILTERS_PATH"],
	["protonmail.endpoints.messages", "PROTONMAIL_MESSAGES_PATH"],
	["protonmail.endpoints.moveMessages", "PROTONMAIL_MOVE_MESSAGES_PATH"],
	["protonmail.endpoints.unlabelMessages", "PROTONMAIL_UNLABEL_MESSAGES_PATH"],
	["protonmail.endpoints.markRead", "PROTONMAIL_MARK_READ_PATH"],
	["gmail.apiBaseUrl", "GMAIL_API_BASE_URL"],
	["gmail.authMode", "GOOGLE_AUTH_MODE"],
	["gmail.clientId", "GOOGLE_CLIENT_ID"],
	["gmail.openBrowserCommand", "GOOGLE_BROWSER_OPEN_COMMAND"],
	["gmail.redirectUri", "GOOGLE_REDIRECT_URI"],
	["gmail.tokenCachePath", "GOOGLE_TOKEN_CACHE_PATH"],
	["gmail.pageSize", "GMAIL_PAGE_SIZE"],
	["gmail.batchSize", "GMAIL_BATCH_SIZE"],
	["gmail.snippetLength", "GMAIL_SNIPPET_LENGTH"],
	["gmail.maxConcurrency", "GMAIL_MAX_CONCURRENCY"],
	["gmail.debugRaw", "GMAIL_DEBUG_RAW"],
	["gmail.dataPath", "GMAIL_DATA_PATH"],
	["outlook.accountProfile", "MICROSOFT_ACCOUNT_PROFILE"],
	["outlook.clientId", "MICROSOFT_CLIENT_ID"],
	["outlook.loginHint", "MICROSOFT_LOGIN_HINT"],
	["outlook.redirectUri", "MICROSOFT_REDIRECT_URI"],
	["outlook.tenantId", "MICROSOFT_TENANT_ID"],
	["outlook.authority", "MICROSOFT_AUTHORITY"],
	["outlook.authMode", "MICROSOFT_AUTH_MODE"],
	["outlook.tokenCachePath", "MICROSOFT_TOKEN_CACHE_PATH"],
	["outlook.openBrowserCommand", "MICROSOFT_BROWSER_OPEN_COMMAND"],
	["outlook.graphBaseUrl", "MICROSOFT_GRAPH_BASE_URL"],
	["outlook.snippetLength", "OUTLOOK_SNIPPET_LENGTH"],
	["outlook.batchSize", "OUTLOOK_BATCH_SIZE"],
	["outlook.pageSize", "OUTLOOK_PAGE_SIZE"],
	["outlook.debugRaw", "OUTLOOK_DEBUG_RAW"],
	["outlook.dataPath", "OUTLOOK_DATA_PATH"],
	["outlook.scopes.read", "MICROSOFT_READ_SCOPES"],
	["outlook.scopes.write", "MICROSOFT_WRITE_SCOPES"],
	["outlook.scopes.rules", "MICROSOFT_RULE_SCOPES"],
	["classifier.mode", "CLASSIFIER_MODE"],
	["classifier.model", "OPENAI_MODEL"],
	["classifier.confidenceThreshold", "CLASSIFIER_CONFIDENCE_THRESHOLD"],
	["output.reportsDir", "ORGANIZER_REPORTS_DIR"],
	["output.codexDir", "ORGANIZER_CODEX_DIR"],
	["output.auditDir", "ORGANIZER_AUDIT_DIR"],
];

/** Only the settings that a set env var in `env` chooses, so they can win over config.toml. */
export function envOverrides(env: Env = process.env): PartialAppConfig {
	const full = inboxDefaults(env) as unknown as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [path, ...names] of ENV_PATHS) {
		if (!names.some((name) => env[name] !== undefined)) continue;
		const parts = path.split(".");
		let from: unknown = full;
		let to = out;
		for (const part of parts.slice(0, -1)) {
			from = (from as Record<string, unknown>)[part];
			to = (to[part] ??= {}) as Record<string, unknown>;
		}
		const last = parts.at(-1) as string;
		to[last] = (from as Record<string, unknown>)[last];
	}
	return out as PartialAppConfig;
}

function providerFromEnv(value: string | undefined): AppConfig["provider"] {
	if (value === "outlook") {
		return "outlook";
	}
	if (value === "gmail") {
		return "gmail";
	}
	return "protonmail";
}

function outlookAuthMode(
	value: string | undefined,
): AppConfig["outlook"]["authMode"] {
	if (value === "device-code" || value === "silent" || value === "env") {
		return value;
	}
	return "browser";
}

function gmailAuthMode(
	value: string | undefined,
): AppConfig["gmail"]["authMode"] {
	if (value === "device-code" || value === "env") {
		return value;
	}
	return "browser";
}

function classifierMode(
	value: string | undefined,
): AppConfig["classifier"]["mode"] {
	if (value === "openai-api" || value === "rules-only") {
		return value;
	}
	return "codex-local";
}

function inferBrowserType(executablePath?: string): string {
	const normalized = executablePath?.toLowerCase() ?? "";
	if (normalized.includes("brave")) {
		return "brave";
	}
	return "chromium";
}
