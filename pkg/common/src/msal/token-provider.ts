import { createHash } from "node:crypto";
import {
	ConfidentialClientApplication,
	PublicClientApplication,
	type AccountInfo,
	type AuthenticationResult,
} from "@azure/msal-node";
import type { MicrosoftAuthSettings } from "./settings";
import { createEncryptedCachePlugin } from "./cache-plugin";
import {
	listenForOAuthCode,
	oauthState,
	openOAuthBrowser,
	validateLoopbackRedirect,
	type EncryptedAuthCache,
} from "../node/oauth-loopback";

export type MicrosoftAccessToken = {
	accessToken: string;
	expiresOn?: Date;
	accountHint?: string;
};
export interface MicrosoftTokenProvider {
	getToken(scopes: string[]): Promise<MicrosoftAccessToken>;
}
type AuthCodeInput = {
	scopes: string[];
	redirectUri: string;
	loginHint?: string;
	state?: string;
	codeChallenge?: string;
	codeChallengeMethod?: string;
};
type CodeClient = {
	getAuthCodeUrl(input: AuthCodeInput): Promise<string>;
	acquireTokenByCode(input: {
		scopes: string[];
		redirectUri: string;
		code: string;
		state?: string;
		codeVerifier?: string;
	}): Promise<AuthenticationResult>;
};
type CommonClient = {
	acquireTokenSilent(input: {
		account: AccountInfo;
		scopes: string[];
	}): Promise<AuthenticationResult>;
};
type PublicClient = CommonClient & {
	getAllAccounts(): Promise<AccountInfo[]>;
	acquireTokenInteractive(input: {
		scopes: string[];
		loginHint?: string;
		openBrowser: (url: string) => Promise<void>;
		successTemplate?: string;
		errorTemplate?: string;
	}): Promise<AuthenticationResult>;
	acquireTokenByDeviceCode(input: {
		scopes: string[];
		timeout?: number;
		deviceCodeCallback: (response: {
			message?: string;
			verificationUri?: string;
			userCode?: string;
		}) => void;
	}): Promise<AuthenticationResult | null>;
};
type ConfidentialClient = CommonClient &
	CodeClient & {
		getTokenCache(): { getAllAccounts(): Promise<AccountInfo[]> };
	};
export type MsalClient = PublicClient | ConfidentialClient;
type BrowserCodeInput = {
	scopes: string[];
	loginHint?: string;
	redirectUri: string;
	openBrowser: (url: string) => Promise<void>;
};
export type MicrosoftAuthServices = {
	cacheBinding: string;
	app?: MsalClient;
	cache?: EncryptedAuthCache | (() => EncryptedAuthCache);
	openBrowser?: (url: string) => Promise<void>;
	deviceCodeLogger?: (message: string) => void;
	timeoutMs?: number;
	browserCodeAuth?: (
		app: ConfidentialClient,
		input: BrowserCodeInput,
	) => Promise<AuthenticationResult>;
};

export class EnvironmentMicrosoftTokenProvider implements MicrosoftTokenProvider {
	private app?: MsalClient;
	private readonly pendingTokens = new Map<
		string,
		Promise<MicrosoftAccessToken>
	>();
	constructor(
		private readonly settings: MicrosoftAuthSettings,
		private readonly input: MicrosoftAuthServices,
	) {}

	async getToken(scopes: string[]): Promise<MicrosoftAccessToken> {
		const normalizedScopes = [...new Set(scopes.filter(Boolean))].sort();
		const key = JSON.stringify(normalizedScopes);
		const pending = this.pendingTokens.get(key);
		if (pending) return pending;
		const acquisition = this.acquireToken(normalizedScopes);
		this.pendingTokens.set(key, acquisition);
		try {
			return await acquisition;
		} finally {
			if (this.pendingTokens.get(key) === acquisition)
				this.pendingTokens.delete(key);
		}
	}

	private async acquireToken(
		normalizedScopes: string[],
	): Promise<MicrosoftAccessToken> {
		const injected =
			process.env[this.settings.accessTokenEnv ?? "MICROSOFT_ACCESS_TOKEN"];
		if (injected) {
			return { accessToken: injected, accountHint: "env-token" };
		}
		if (!this.settings.clientId) {
			throw new Error(
				"Outlook setup requires MICROSOFT_CLIENT_ID or a client ID in the dg-ai profile.",
			);
		}
		const authority = validateAuthority(
			this.settings.authority,
			this.settings.tenantId,
		);
		const scopePattern = new RegExp(this.settings.scopePattern);
		if (
			!normalizedScopes.length ||
			normalizedScopes.some((scope) => {
				scopePattern.lastIndex = 0;
				return !scopePattern.test(scope);
			})
		) {
			throw new Error(
				"Outlook OAuth scopes must target Microsoft Graph mail or profile permissions.",
			);
		}
		const app = this.getApp(authority);
		const cached = await this.acquireCachedToken(app, normalizedScopes);
		if (cached) {
			return tokenFromAuthResult(cached, "msal-cache");
		}
		if (this.settings.authMode === "silent") {
			throw new Error(
				"Outlook silent auth found no cached Microsoft account. Run with MICROSOFT_AUTH_MODE=browser or device-code first.",
			);
		}
		if (
			this.settings.authMode === "device-code" &&
			!isPublicClient(app)
		) {
			throw new Error(
				"Outlook device-code auth requires a public-client app. Remove MICROSOFT_CLIENT_SECRET or use MICROSOFT_AUTH_MODE=browser.",
			);
		}
		try {
			if (
				this.settings.authMode === "device-code" &&
				isPublicClient(app)
			) {
				const result = await app.acquireTokenByDeviceCode({
					scopes: normalizedScopes,
					timeout: Math.ceil((this.input.timeoutMs ?? 120_000) / 1000),
					deviceCodeCallback: (response) => {
						const uri = response.verificationUri;
						if (!uri) {
							return;
						}
						const url = new URL(uri);
						if (
							url.protocol !== "https:" ||
							![
								"microsoft.com",
								"www.microsoft.com",
								"login.microsoftonline.com",
							].includes(url.hostname)
						) {
							return;
						}
						(this.input.deviceCodeLogger ?? console.error)(
							`Open ${url.toString()}${response.userCode ? ` and enter code ${response.userCode}` : " to complete Microsoft login"}`,
						);
					},
				});
				return tokenFromAuthResult(result, "msal-device-code");
			}
			validateLoopbackRedirect(this.settings.redirectUri);
			const openBrowser = async (url: string): Promise<void> => {
				validateMicrosoftLoginUrl(url);
				await (
					this.input.openBrowser ??
					((value) =>
						openOAuthBrowser(value, this.settings.openBrowserCommand))
				)(url);
			};
			const browserInput = {
				scopes: normalizedScopes,
				loginHint: this.settings.loginHint,
				redirectUri: this.settings.redirectUri,
				openBrowser,
			};
			const result =
				this.input.browserCodeAuth && !isPublicClient(app)
					? await this.input.browserCodeAuth(app, browserInput)
					: isCodeClient(app)
						? await acquireTokenByBrowserCode(
								app,
								browserInput,
								this.input.timeoutMs,
							)
						: await app.acquireTokenInteractive({
								scopes: normalizedScopes,
								loginHint: this.settings.loginHint,
								openBrowser,
							});
			return tokenFromAuthResult(result, "msal-browser");
		} catch {
			throw new Error(
				"Microsoft authentication failed. Check the registered loopback redirect and account permissions, then retry login.",
			);
		}
	}

	private async acquireCachedToken(
		app: MsalClient,
		scopes: string[],
	): Promise<AuthenticationResult | undefined> {
		let accounts: AccountInfo[];
		try {
			accounts = await (isPublicClient(app)
				? app.getAllAccounts()
				: app.getTokenCache().getAllAccounts());
		} catch {
			throw new Error(
				"Microsoft encrypted authentication cache could not be loaded. Check daemon storage and retry login.",
			);
		}
		const hint = this.settings.loginHint?.toLowerCase();
		const account = hint
			? accounts.find((candidate) => candidate.username.toLowerCase() === hint)
			: accounts.length === 1
				? accounts[0]
				: undefined;
		if (!account) {
			return undefined;
		}
		try {
			return await app.acquireTokenSilent({ account, scopes });
		} catch {
			return undefined;
		}
	}

	private getApp(authority: string): MsalClient {
		if (this.input.app) {
			return this.input.app;
		}
		if (this.app) {
			return this.app;
		}
		const settings = this.settings;
		const store =
			typeof this.input.cache === "function"
				? this.input.cache()
				: this.input.cache;
		const cache = store
			? { cachePlugin: createEncryptedCachePlugin(store, this.input.cacheBinding) }
			: undefined;
		const clientSecret = settings.clientSecretEnv
			? process.env[settings.clientSecretEnv]
			: settings.clientSecret;
		const system = {
			loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
		};
		this.app = clientSecret
			? new ConfidentialClientApplication({
					auth: { clientId: settings.clientId!, authority, clientSecret },
					cache,
					system,
				})
			: new PublicClientApplication({
					auth: { clientId: settings.clientId!, authority },
					cache,
					system,
				});
		return this.app;
	}
}

function validateAuthority(value: string, tenantId: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.hostname !== "login.microsoftonline.com" ||
		url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!["", "/"].includes(url.pathname) ||
		!/^(common|organizations|consumers|[a-zA-Z0-9][a-zA-Z0-9.-]*)$/.test(
			tenantId,
		)
	) {
		throw new Error(
			"Outlook authority must be https://login.microsoftonline.com with an explicit Microsoft tenant ID.",
		);
	}
	return `${url.origin}/${tenantId}`;
}

function validateMicrosoftLoginUrl(value: string): void {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.hostname !== "login.microsoftonline.com" ||
		url.port ||
		url.username ||
		url.password
	) {
		throw new Error(
			"Microsoft login URL must use the trusted Microsoft authority.",
		);
	}
}

async function acquireTokenByBrowserCode(
	app: CodeClient,
	input: BrowserCodeInput,
	timeoutMs?: number,
): Promise<AuthenticationResult> {
	const state = oauthState();
	const verifier = oauthState();
	const callback = await listenForOAuthCode(
		input.redirectUri,
		state,
		timeoutMs,
	);
	try {
		const url = await app.getAuthCodeUrl({
			scopes: input.scopes,
			redirectUri: callback.redirectUri,
			loginHint: input.loginHint,
			state,
			codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
			codeChallengeMethod: "S256",
		});
		await input.openBrowser(url);
		return await app.acquireTokenByCode({
			scopes: input.scopes,
			redirectUri: callback.redirectUri,
			code: await callback.code,
			state,
			codeVerifier: verifier,
		});
	} finally {
		callback.close();
	}
}

function isPublicClient(app: MsalClient): app is PublicClient {
	return "acquireTokenInteractive" in app;
}
function isCodeClient(app: MsalClient): app is MsalClient & CodeClient {
	return "getAuthCodeUrl" in app && "acquireTokenByCode" in app;
}
function tokenFromAuthResult(
	result: AuthenticationResult | null,
	accountHint: string,
): MicrosoftAccessToken {
	if (!result?.accessToken) {
		throw new Error(
			"Microsoft authentication completed without an access token.",
		);
	}
	return {
		accessToken: result.accessToken,
		expiresOn: result.expiresOn ?? undefined,
		accountHint: result.account?.username ?? accountHint,
	};
}
export class StaticMicrosoftTokenProvider implements MicrosoftTokenProvider {
	constructor(private readonly token: string) {}
	async getToken(): Promise<MicrosoftAccessToken> {
		return { accessToken: this.token, accountHint: "test-token" };
	}
}
