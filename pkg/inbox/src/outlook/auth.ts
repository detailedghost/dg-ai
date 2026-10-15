import { createHash } from "node:crypto";
import {
	EnvironmentMicrosoftTokenProvider as CommonMicrosoftTokenProvider,
	MAIL_SCOPE_PATTERN,
	type MicrosoftAccessToken,
	type MicrosoftAuthServices,
	type MicrosoftTokenProvider,
} from "@dg/common/msal";
import type { EncryptedAuthCache } from "@dg/common/node";
import type { AppConfig } from "../config/types";
import { inboxRuntimeFor } from "../runtime";

export {
	StaticMicrosoftTokenProvider,
	createEncryptedCachePlugin,
	type MicrosoftTokenProvider,
	type MicrosoftAccessToken,
} from "@dg/common/msal";

type InboxMicrosoftAuthServices = Omit<
	MicrosoftAuthServices,
	"cacheBinding" | "cache"
> & { cache?: EncryptedAuthCache };

export class EnvironmentMicrosoftTokenProvider implements MicrosoftTokenProvider {
	private readonly provider: CommonMicrosoftTokenProvider;

	constructor(config: AppConfig, services: InboxMicrosoftAuthServices = {}) {
		const settings = config.outlook;
		this.provider = new CommonMicrosoftTokenProvider(
			{
				clientId: settings.clientId,
				clientSecret: settings.clientSecret,
				clientSecretEnv: settings.clientSecretEnv,
				accessTokenEnv: settings.accessTokenEnv,
				loginHint: settings.loginHint,
				redirectUri: settings.redirectUri,
				tenantId: settings.tenantId,
				authority: settings.authority,
				authMode: settings.authMode,
				openBrowserCommand: settings.openBrowserCommand,
				scopePattern: MAIL_SCOPE_PATTERN,
			},
			{
				...services,
				get cacheBinding() {
					const authority = `${new URL(settings.authority).origin}/${settings.tenantId}`;
					return createHash("sha256")
						.update(
							JSON.stringify({
								clientId: settings.clientId,
								authority,
								loginHint: settings.loginHint ?? "",
								accountProfile: settings.accountProfile ?? "",
								scopes: settings.scopes,
							}),
						)
						.digest("hex");
				},
				cache:
					services.cache ??
					(() => {
						const binding = inboxRuntimeFor(config);
						const get = binding.runtime.authCacheGet;
						const set = binding.runtime.authCacheSet;
						if (!get || !set) {
							throw new Error(
								"Outlook login requires dg-ai encrypted profile storage. Start the daemon and use dg-skills inbox with a configured profile.",
							);
						}
						return {
							get: () => get(binding.profile, "outlook"),
							set: (value: string) => set(binding.profile, "outlook", value),
						};
					}),
			},
		);
	}

	getToken(scopes: string[]): Promise<MicrosoftAccessToken> {
		return this.provider.getToken(scopes);
	}
}
