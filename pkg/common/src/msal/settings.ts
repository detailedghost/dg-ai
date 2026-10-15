export interface MicrosoftAuthSettings {
	clientId?: string;
	clientSecret?: string;
	clientSecretEnv?: string;
	accessTokenEnv?: string;
	loginHint?: string;
	redirectUri: string;
	tenantId: string;
	authority: string;
	authMode: "browser" | "device-code" | "env" | "silent";
	openBrowserCommand?: string;
	scopePattern: RegExp;
}

export const MAIL_SCOPE_PATTERN =
	/^(https:\/\/graph\.microsoft\.com\/)?(Mail\.[A-Za-z.]+|MailboxSettings\.[A-Za-z.]+|User\.Read|openid|profile|offline_access)$/;
