import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./types";

export const defaultConfig: AppConfig = {
	configHome:
		process.env.EMAIL_ORGANIZER_HOME ??
		process.env.EMAIL_ORGANIZER_CONFIG_HOME ??
		join(process.env.DG_HOME ?? join(homedir(), ".dg"), "inbox", "config"),
	provider: providerFromEnv(process.env.EMAIL_ORGANIZER_PROVIDER),
	protonmail: {
		sessionProfile: "dg-extension",
		apiBaseUrl:
			process.env.PROTONMAIL_API_BASE_URL ?? "https://mail.proton.me/api",
		mailboxUrl: process.env.PROTONMAIL_MAILBOX_URL,
		apiAppVersion:
			process.env.PROTONMAIL_API_APP_VERSION ?? "web-mail@5.0.120.8",
		liveBrowser: true,
		browserType:
			process.env.PROTONMAIL_BROWSER_TYPE ??
			inferBrowserType(process.env.PROTONMAIL_BROWSER_EXECUTABLE_PATH),
		browserHeadless: process.env.PROTONMAIL_BROWSER_HEADLESS === "true",
		browserExecutablePath: process.env.PROTONMAIL_BROWSER_EXECUTABLE_PATH,
		browserTimeoutMs: Number(
			process.env.PROTONMAIL_BROWSER_TIMEOUT_MS ?? 60_000,
		),
		snippetLength: Number(process.env.PROTONMAIL_SNIPPET_LENGTH ?? 160),
		batchSize: Number(process.env.PROTONMAIL_BATCH_SIZE ?? 200),
		debugRaw: process.env.PROTONMAIL_DEBUG_RAW === "true",
		dataPath: process.env.PROTONMAIL_DATA_PATH,
		endpoints: {
			folders: process.env.PROTONMAIL_FOLDERS_PATH ?? "/core/v4/labels?Type=1",
			labels: process.env.PROTONMAIL_LABELS_PATH ?? "/core/v4/labels",
			filters: process.env.PROTONMAIL_FILTERS_PATH ?? "/mail/v4/filters",
			messages: process.env.PROTONMAIL_MESSAGES_PATH ?? "/mail/v4/messages",
			moveMessages:
				process.env.PROTONMAIL_MOVE_MESSAGES_PATH ?? "/mail/v4/messages/label",
			unlabelMessages:
				process.env.PROTONMAIL_UNLABEL_MESSAGES_PATH ??
				"/mail/v4/messages/unlabel",
			markRead:
				process.env.PROTONMAIL_MARK_READ_PATH ?? "/mail/v4/messages/read",
		},
	},
	gmail: {
		apiBaseUrl:
			process.env.GMAIL_API_BASE_URL ?? "https://gmail.googleapis.com/gmail/v1",
		authMode: gmailAuthMode(process.env.GOOGLE_AUTH_MODE),
		clientId: process.env.GOOGLE_CLIENT_ID,
		clientSecretEnv: "GOOGLE_CLIENT_SECRET",
		accessTokenEnv: "GOOGLE_ACCESS_TOKEN",
		refreshTokenEnv: "GOOGLE_REFRESH_TOKEN",
		redirectUri:
			process.env.GOOGLE_REDIRECT_URI ?? "http://127.0.0.1:0/oauth2/callback",
		tokenCachePath:
			process.env.GOOGLE_TOKEN_CACHE_PATH ??
			"./email-cleanup/google-token-cache.json",
		allowPlaintextTokenCache: false,
		pageSize: Number(process.env.GMAIL_PAGE_SIZE ?? 100),
		batchSize: Number(process.env.GMAIL_BATCH_SIZE ?? 200),
		snippetLength: Number(process.env.GMAIL_SNIPPET_LENGTH ?? 160),
		maxConcurrency: Number(process.env.GMAIL_MAX_CONCURRENCY ?? 10),
		debugRaw: process.env.GMAIL_DEBUG_RAW === "true",
		dataPath: process.env.GMAIL_DATA_PATH,
		scopes: {
			read: ["https://www.googleapis.com/auth/gmail.readonly"],
			modify: ["https://www.googleapis.com/auth/gmail.modify"],
			settings: ["https://www.googleapis.com/auth/gmail.settings.basic"],
		},
	},
	outlook: {
		accountProfile: process.env.MICROSOFT_ACCOUNT_PROFILE,
		clientId: process.env.MICROSOFT_CLIENT_ID,
		clientSecretEnv: "MICROSOFT_CLIENT_SECRET",
		accessTokenEnv: "MICROSOFT_ACCESS_TOKEN",
		loginHint: process.env.MICROSOFT_LOGIN_HINT,
		redirectUri:
			process.env.MICROSOFT_REDIRECT_URI ??
			(process.env.MICROSOFT_CLIENT_SECRET
				? "http://localhost:3000"
				: "http://localhost:0"),
		tenantId: process.env.MICROSOFT_TENANT_ID ?? "organizations",
		authority:
			process.env.MICROSOFT_AUTHORITY ?? "https://login.microsoftonline.com",
		authMode: outlookAuthMode(process.env.MICROSOFT_AUTH_MODE),
		tokenCachePath:
			process.env.MICROSOFT_TOKEN_CACHE_PATH ??
			"./email-cleanup/outlook-token-cache.json",
		allowPlaintextTokenCache: false,
		openBrowserCommand: process.env.MICROSOFT_BROWSER_OPEN_COMMAND,
		graphBaseUrl:
			process.env.MICROSOFT_GRAPH_BASE_URL ??
			"https://graph.microsoft.com/v1.0",
		snippetLength: Number(process.env.OUTLOOK_SNIPPET_LENGTH ?? 160),
		batchSize: Number(process.env.OUTLOOK_BATCH_SIZE ?? 200),
		pageSize: Math.min(Number(process.env.OUTLOOK_PAGE_SIZE ?? 50), 50),
		debugRaw: process.env.OUTLOOK_DEBUG_RAW === "true",
		dataPath: process.env.OUTLOOK_DATA_PATH,
		scopes: {
			read: (process.env.MICROSOFT_READ_SCOPES ?? "Mail.Read,User.Read")
				.split(",")
				.map((scope) => scope.trim())
				.filter(Boolean),
			write: (process.env.MICROSOFT_WRITE_SCOPES ?? "Mail.ReadWrite")
				.split(",")
				.map((scope) => scope.trim())
				.filter(Boolean),
			rules: (process.env.MICROSOFT_RULE_SCOPES ?? "MailboxSettings.Read")
				.split(",")
				.map((scope) => scope.trim())
				.filter(Boolean),
		},
	},
	classifier: {
		mode: classifierMode(process.env.CLASSIFIER_MODE),
		model: process.env.OPENAI_MODEL ?? "gpt-4.1-nano",
		confidenceThreshold: Number(
			process.env.CLASSIFIER_CONFIDENCE_THRESHOLD ?? 0.75,
		),
	},
	output: {
		reportsDir: process.env.ORGANIZER_REPORTS_DIR ?? "data/reports",
		codexDir: process.env.ORGANIZER_CODEX_DIR ?? "data/codex",
		auditDir: process.env.ORGANIZER_AUDIT_DIR ?? "data/audit",
	},
	routeProfiles: {},
	security: {
		allowRawDebugPaths: [],
	},
};

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
