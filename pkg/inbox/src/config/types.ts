import type { MailProvider } from "../providers/types";

export type ClassifierMode = "codex-local" | "openai-api" | "rules-only";
export type OutlookAuthMode = "browser" | "device-code" | "silent" | "env";

export type AppConfig = {
	configHome: string;
	provider: MailProvider;
	protonmail: {
		tabId?: number;
		accountHint?: string;
		sessionProfile: string;
		apiBaseUrl: string;
		mailboxUrl?: string;
		apiAppVersion: string;
		liveBrowser: boolean;
		browserType: string;
		browserHeadless: boolean;
		browserExecutablePath?: string;
		browserTimeoutMs: number;
		snippetLength: number;
		batchSize: number;
		debugRaw: boolean;
		dataPath?: string;
		endpoints: {
			folders: string;
			labels: string;
			filters: string;
			messages: string;
			moveMessages: string;
			unlabelMessages: string;
			markRead: string;
		};
	};
	gmail: {
		apiBaseUrl: string;
		loginHint?: string;
		authMode: "browser" | "device-code" | "env";
		clientId?: string;
		clientSecret?: string;
		clientSecretEnv?: string;
		accessTokenEnv?: string;
		refreshTokenEnv?: string;
		redirectUri: string;
		tokenCachePath: string;
		allowPlaintextTokenCache: boolean;
		pageSize: number;
		batchSize: number;
		snippetLength: number;
		maxConcurrency: number;
		debugRaw: boolean;
		dataPath?: string;
		scopes: {
			read: string[];
			modify: string[];
			settings: string[];
		};
	};
	outlook: {
		accountProfile?: string;
		clientId?: string;
		clientSecret?: string;
		clientSecretEnv?: string;
		accessTokenEnv?: string;
		refreshTokenEnv?: string;
		loginHint?: string;
		redirectUri: string;
		tenantId: string;
		authority: string;
		authMode: OutlookAuthMode;
		tokenCachePath: string;
		allowPlaintextTokenCache: boolean;
		openBrowserCommand?: string;
		graphBaseUrl: string;
		snippetLength: number;
		batchSize: number;
		pageSize: number;
		debugRaw: boolean;
		dataPath?: string;
		scopes: {
			read: string[];
			write: string[];
			rules: string[];
		};
	};
	classifier: {
		mode: ClassifierMode;
		model: string;
		confidenceThreshold: number;
	};
	output: {
		reportsDir: string;
		codexDir: string;
		auditDir: string;
	};
	routeProfiles: Record<string, RouteProfileConfig>;
	security: {
		allowRawDebugPaths: string[];
	};
};

export type RouteProfileConfig = {
	folderName: string;
	filterName: string;
	domainFilters?: string[];
	subjectDomainFilters?: {
		domain: string;
		subjectContains: string[];
	}[];
};

export type PartialAppConfig = {
	configHome?: string;
	provider?: MailProvider;
	protonmail?: Partial<AppConfig["protonmail"]>;
	gmail?: Partial<AppConfig["gmail"]>;
	outlook?: Partial<Omit<AppConfig["outlook"], "scopes">> & {
		scopes?: Partial<AppConfig["outlook"]["scopes"]>;
	};
	classifier?: Partial<AppConfig["classifier"]>;
	output?: Partial<AppConfig["output"]>;
	security?: Partial<AppConfig["security"]>;
};
