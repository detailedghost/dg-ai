import type { ICachePlugin } from "@azure/msal-node";
import type { EncryptedAuthCache } from "../node/oauth-loopback";

export function createEncryptedCachePlugin(
	store: EncryptedAuthCache,
	binding: string,
): ICachePlugin {
	return {
		beforeCacheAccess: async (context) => {
			const serialized = await store.get();
			if (!serialized) {
				return;
			}
			let data: unknown;
			try {
				data = JSON.parse(serialized);
			} catch {
				return;
			}
			if (
				typeof data === "object" &&
				data !== null &&
				"binding" in data &&
				data.binding === binding &&
				"cache" in data &&
				typeof data.cache === "string"
			) {
				try {
					context.tokenCache.deserialize(data.cache);
				} catch {
					throw new Error(
						"Microsoft encrypted authentication cache is invalid. Sign in again with a fresh profile.",
					);
				}
			}
		},
		afterCacheAccess: async (context) => {
			if (context.cacheHasChanged) {
				await store.set(
					JSON.stringify({ binding, cache: context.tokenCache.serialize() }),
				);
			}
		},
	};
}

