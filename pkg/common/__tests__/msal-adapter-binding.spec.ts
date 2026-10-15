import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createEncryptedCachePlugin } from "@dg/common/msal";
import { defaultConfig } from "../../inbox/src/config/defaults";
import {
	EnvironmentMicrosoftTokenProvider,
	createEncryptedCachePlugin as adapterCachePlugin,
} from "../../inbox/src/outlook/auth";

const GRAPH_MAIL_READ = "https://graph.microsoft.com/Mail.Read";

function config() {
	return {
		...defaultConfig,
		outlook: {
			...defaultConfig.outlook,
			clientId: "client",
			accessTokenEnv: "DG_MSAL_ADAPTER_NO_ACCESS",
			authMode: "silent" as const,
			loginHint: "user@contoso.com",
			accountProfile: "profile-a",
			authority: "https://login.microsoftonline.com",
			tenantId: "organizations",
		},
	};
}

function preMoveBinding(settings: ReturnType<typeof config>["outlook"]) {
	return createHash("sha256")
		.update(
			JSON.stringify({
				clientId: settings.clientId,
				authority: `https://login.microsoftonline.com/${settings.tenantId}`,
				loginHint: settings.loginHint ?? "",
				accountProfile: settings.accountProfile ?? "",
				scopes: settings.scopes,
			}),
		)
		.digest("hex");
}

function seededCache(binding: string): string {
	const home = "uid.utid";
	const env = "login.microsoftonline.com";
	const realm = "organizations";
	const toBase64Url = (value: object) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	const jwt = `${toBase64Url({ alg: "none" })}.${toBase64Url({
		preferred_username: "user@contoso.com",
		tid: realm,
		oid: "uid",
		sub: "sub",
		aud: "client",
		iss: `https://${env}/${realm}/v2.0`,
		exp: 9999999999,
		iat: 1,
	})}.sig`;
	const now = Math.floor(Date.now() / 1000);
	const cache = {
		Account: {
			[`${home}-${env}-${realm}`]: {
				home_account_id: home,
				environment: env,
				realm,
				local_account_id: "uid",
				username: "user@contoso.com",
				authority_type: "MSSTS",
				name: "User",
			},
		},
		IdToken: {
			[`${home}-${env}-idtoken-client-${realm}-`]: {
				home_account_id: home,
				environment: env,
				credential_type: "IdToken",
				client_id: "client",
				secret: jwt,
				realm,
			},
		},
		AccessToken: {
			[`${home}-${env}-accesstoken-client-${realm}-${GRAPH_MAIL_READ}`]: {
				home_account_id: home,
				environment: env,
				credential_type: "AccessToken",
				client_id: "client",
				secret: "seeded-token",
				realm,
				target: GRAPH_MAIL_READ,
				cached_at: String(now),
				expires_on: String(now + 3600),
				extended_expires_on: String(now + 7200),
				token_type: "Bearer",
			},
		},
		RefreshToken: {},
		AppMetadata: {},
	};
	return JSON.stringify({ binding, cache: JSON.stringify(cache) });
}

describe("inbox Outlook adapter cache binding", () => {
	test("reads a cache stored under the pre-move binding hash", async () => {
		const settings = config();
		const token = await new EnvironmentMicrosoftTokenProvider(settings, {
			cache: {
				get: async () => seededCache(preMoveBinding(settings.outlook)),
				set: async () => {},
			},
		}).getToken([GRAPH_MAIL_READ]);
		expect(token.accessToken).toBe("seeded-token");
	});

	test("changes the binding when the account profile changes", async () => {
		const settings = config();
		const stored = seededCache(preMoveBinding(settings.outlook));
		const other = config();
		other.outlook.accountProfile = "profile-b";
		await expect(
			new EnvironmentMicrosoftTokenProvider(other, {
				cache: { get: async () => stored, set: async () => {} },
			}).getToken([GRAPH_MAIL_READ]),
		).rejects.toThrow("no cached Microsoft account");
	});

	test("changes the binding when the login hint changes", async () => {
		const settings = config();
		const stored = seededCache(preMoveBinding(settings.outlook));
		const other = config();
		other.outlook.loginHint = "User@Contoso.com ";
		await expect(
			new EnvironmentMicrosoftTokenProvider(other, {
				cache: { get: async () => stored, set: async () => {} },
			}).getToken([GRAPH_MAIL_READ]),
		).rejects.toThrow();
	});
});

describe("inbox Outlook adapter storage error", () => {
	test("rejects the authority check before storage", async () => {
		const settings = config();
		settings.outlook.authority =
			"https://login.microsoftonline.com.attacker.example";
		await expect(
			new EnvironmentMicrosoftTokenProvider(settings).getToken(["Mail.Read"]),
		).rejects.toThrow("authority");
	});

	test("rejects a non-Graph scope before storage", async () => {
		await expect(
			new EnvironmentMicrosoftTokenProvider(config()).getToken([
				"https://attacker.example/Mail.Read",
			]),
		).rejects.toThrow("Graph");
	});

	test("rejects with the encrypted profile storage error after both checks pass", async () => {
		const pending = new EnvironmentMicrosoftTokenProvider(config()).getToken([
			"Mail.Read",
		]);
		expect(pending).toBeInstanceOf(Promise);
		await expect(pending).rejects.toThrow("encrypted profile storage");
	});

	test("rejects Chat.Read because the adapter pins the mail scope pattern", async () => {
		await expect(
			new EnvironmentMicrosoftTokenProvider(config()).getToken(["Chat.Read"]),
		).rejects.toThrow("Graph");
	});
});

describe("inbox Outlook adapter re-exports", () => {
	test("re-exports the common createEncryptedCachePlugin", () => {
		expect(adapterCachePlugin).toBe(createEncryptedCachePlugin);
	});
});
