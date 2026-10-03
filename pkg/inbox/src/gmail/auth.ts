import { createHash } from "node:crypto";
import type { AppConfig } from "../config/types";
import { inboxRuntimeFor } from "../runtime";
import {
	listenForOAuthCode,
	oauthState,
	openOAuthBrowser,
	type EncryptedAuthCache,
} from "./oauth-loopback";

export type GoogleAccessToken = {
	accessToken: string;
	expiresOn?: Date;
	accountHint?: string;
};
export interface GoogleTokenProvider {
	getToken(scopes: string[]): Promise<GoogleAccessToken>;
}
type GoogleCache = {
	binding: string;
	accessToken: string;
	expiresAt: number;
	refreshToken?: string;
};
type GoogleAuthServices = {
	cache?: EncryptedAuthCache;
	fetch?: typeof fetch;
	openBrowser?: (url: string) => Promise<void>;
	now?: () => number;
	timeoutMs?: number;
};

class GoogleInvalidGrantError extends Error {}

export class EnvironmentGoogleTokenProvider implements GoogleTokenProvider {
	private pending = new Map<string, Promise<GoogleAccessToken>>();
	constructor(
		private readonly config: AppConfig,
		private readonly input: GoogleAuthServices = {},
	) {}

	async getToken(scopes: string[]): Promise<GoogleAccessToken> {
		const injected =
			process.env[this.config.gmail.accessTokenEnv ?? "GOOGLE_ACCESS_TOKEN"];
		if (injected) {
			return { accessToken: injected, accountHint: "env-token" };
		}
		if (!this.config.gmail.clientId) {
			throw new Error(
				"Gmail setup requires a desktop OAuth client ID in the dg-ai profile or GOOGLE_CLIENT_ID.",
			);
		}
		const normalized = [
			...new Set([
				...scopes,
				...Object.values(this.config.gmail.scopes).flat(),
			]),
		].sort();
		if (
			!normalized.length ||
			normalized.some(
				(scope) =>
					!/^https:\/\/www\.googleapis\.com\/auth\/gmail\.[a-z.]+$/.test(scope),
			)
		) {
			throw new Error("Gmail OAuth scopes must be explicit Gmail API scopes.");
		}
		const key = JSON.stringify(normalized);
		const active = this.pending.get(key);
		if (active) {
			return active;
		}
		const result = this.acquire(normalized);
		this.pending.set(key, result);
		try {
			return await result;
		} finally {
			this.pending.delete(key);
		}
	}

	private encryptedCache(): EncryptedAuthCache | undefined {
		if (this.input.cache) {
			return this.input.cache;
		}
		const binding = inboxRuntimeFor(this.config);
		const get = binding?.runtime.authCacheGet;
		const set = binding?.runtime.authCacheSet;
		if (!binding || !get || !set) {
			return undefined;
		}
		return {
			get: () => get(binding.profile, "gmail"),
			set: (value) => set(binding.profile, "gmail", value),
		};
	}

	private async acquire(scopes: string[]): Promise<GoogleAccessToken> {
		const settings = this.config.gmail;
		const binding = createHash("sha256")
			.update(
				JSON.stringify({
					clientId: settings.clientId,
					scopes,
					loginHint: settings.loginHint ?? "",
				}),
			)
			.digest("hex");
		const store = this.encryptedCache();
		const now = this.input.now ?? Date.now;
		const cached = parseCache(await store?.get(), binding);
		if (cached && cached.expiresAt > now() + 60_000) {
			return {
				accessToken: cached.accessToken,
				expiresOn: new Date(cached.expiresAt),
				accountHint: settings.loginHint,
			};
		}
		const environmentRefresh =
			process.env[settings.refreshTokenEnv ?? "GOOGLE_REFRESH_TOKEN"];
		const refreshToken = environmentRefresh ?? cached?.refreshToken;
		if (refreshToken) {
			try {
				return await this.exchange(
					{ grant_type: "refresh_token", refresh_token: refreshToken },
					binding,
					store,
					refreshToken,
				);
			} catch (error) {
				if (
					!(error instanceof GoogleInvalidGrantError) ||
					environmentRefresh !== undefined
				)
					throw error;
				await store?.set("");
				if (settings.authMode !== "browser") throw error;
			}
		}
		if (settings.authMode === "env") {
			throw new Error(
				"Gmail env authentication requires GOOGLE_ACCESS_TOKEN or GOOGLE_REFRESH_TOKEN (or configured environment references).",
			);
		}
		if (settings.authMode === "device-code") {
			throw new Error(
				"Gmail device-code login requires a compatible TV/device OAuth app. Configure a desktop OAuth client with authMode browser, or provide an environment token.",
			);
		}
		if (!store) {
			throw new Error(
				"Gmail browser login requires dg-ai encrypted profile storage. Start the daemon and use dg-skills inbox with a configured profile.",
			);
		}
		const state = oauthState();
		const verifier = oauthState();
		const callback = await listenForOAuthCode(
			settings.redirectUri,
			state,
			this.input.timeoutMs,
		);
		try {
			const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
			url.search = new URLSearchParams({
				client_id: settings.clientId!,
				redirect_uri: callback.redirectUri,
				response_type: "code",
				scope: scopes.join(" "),
				state,
				code_challenge: createHash("sha256")
					.update(verifier)
					.digest("base64url"),
				code_challenge_method: "S256",
				access_type: "offline",
				prompt: "consent",
				...(settings.loginHint ? { login_hint: settings.loginHint } : {}),
			}).toString();
			try {
				await (
					this.input.openBrowser ??
					((value) => openOAuthBrowser(value, settings.openBrowserCommand))
				)(url.toString());
			} catch {
				console.error(
					"Could not open the login browser. Continue with the login URL below.",
				);
			}
			const manualUrl = new URL(url);
			manualUrl.searchParams.delete("login_hint");
			console.error(
				"Open this URL in a browser to continue Gmail login:\n" +
					manualUrl.toString(),
			);
			const code = await callback.code;
			return await this.exchange(
				{
					grant_type: "authorization_code",
					code,
					redirect_uri: callback.redirectUri,
					code_verifier: verifier,
				},
				binding,
				store,
			);
		} finally {
			callback.close();
		}
	}

	private async exchange(
		values: Record<string, string>,
		binding: string,
		store?: EncryptedAuthCache,
		previousRefresh?: string,
	): Promise<GoogleAccessToken> {
		const clientSecret = this.config.gmail.clientSecretEnv
			? process.env[this.config.gmail.clientSecretEnv]
			: this.config.gmail.clientSecret;
		const body = new URLSearchParams({
			...values,
			client_id: this.config.gmail.clientId!,
			...(clientSecret ? { client_secret: clientSecret } : {}),
		});
		let response: Response;
		try {
			response = await (this.input.fetch ?? fetch)(
				"https://oauth2.googleapis.com/token",
				{
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body,
					redirect: "error",
					signal: AbortSignal.timeout(30_000),
				},
			);
		} catch {
			throw new Error(
				"Google token exchange failed. Check connectivity and retry login.",
			);
		}
		if (!response.ok) {
			if (response.status === 400) {
				const rejected: unknown = await response.json().catch(() => undefined);
				if (
					typeof rejected === "object" &&
					rejected !== null &&
					"error" in rejected &&
					rejected.error === "invalid_grant"
				)
					throw new GoogleInvalidGrantError(
						"Google token exchange was rejected. Check the desktop OAuth client and sign in again.",
					);
			}
			throw new Error(
				"Google token exchange was rejected. Check the desktop OAuth client and sign in again.",
			);
		}
		let data: unknown;
		try {
			data = await response.json();
		} catch {
			throw new Error("Google token exchange returned an invalid response.");
		}
		if (!isTokenResponse(data)) {
			throw new Error(
				"Google token exchange returned no valid access token or expiry.",
			);
		}
		const expiresAt = (this.input.now ?? Date.now)() + data.expires_in * 1000;
		const refreshToken =
			typeof data.refresh_token === "string"
				? data.refresh_token
				: previousRefresh;
		if (store) {
			await store.set(
				JSON.stringify({
					binding,
					accessToken: data.access_token,
					expiresAt,
					...(refreshToken ? { refreshToken } : {}),
				}),
			);
		}
		return {
			accessToken: data.access_token,
			expiresOn: new Date(expiresAt),
			accountHint: this.config.gmail.loginHint,
		};
	}
}

function isTokenResponse(
	value: unknown,
): value is {
	access_token: string;
	expires_in: number;
	refresh_token?: unknown;
} {
	return (
		typeof value === "object" &&
		value !== null &&
		"access_token" in value &&
		typeof value.access_token === "string" &&
		!!value.access_token &&
		"expires_in" in value &&
		typeof value.expires_in === "number" &&
		Number.isFinite(value.expires_in) &&
		value.expires_in > 0
	);
}

function parseCache(
	value: string | null | undefined,
	binding: string,
): GoogleCache | undefined {
	if (!value) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("binding" in parsed) ||
			parsed.binding !== binding ||
			!("accessToken" in parsed) ||
			typeof parsed.accessToken !== "string" ||
			!("expiresAt" in parsed) ||
			typeof parsed.expiresAt !== "number" ||
			!Number.isFinite(parsed.expiresAt)
		) {
			return undefined;
		}
		return {
			binding,
			accessToken: parsed.accessToken,
			expiresAt: parsed.expiresAt,
			...("refreshToken" in parsed && typeof parsed.refreshToken === "string"
				? { refreshToken: parsed.refreshToken }
				: {}),
		};
	} catch {
		return undefined;
	}
}

export class StaticGoogleTokenProvider implements GoogleTokenProvider {
	constructor(private readonly token: string) {}
	async getToken(): Promise<GoogleAccessToken> {
		return { accessToken: this.token, accountHint: "test-token" };
	}
}
