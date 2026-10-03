import type {
	InboxProfile,
	InboxProvider,
	InboxBrowserRequest,
	InboxBrowserResponse,
} from "@dg/common";
import type { AppConfig } from "./config/types";
/** Injects encrypted configuration/auth storage and the authenticated Proton extension transport. */
export type InboxRuntime = {
	/** Returns exact private account settings, or null when the named profile is absent. */
	profileGet?(name: string): Promise<InboxProfile | null>;
	/** Persists validated account settings through encrypted storage; credential values remain environment references. */
	profileSet?(name: string, profile: InboxProfile): Promise<void>;
	/** Returns private serialized OAuth material scoped to both profile and provider. */
	authCacheGet?(name: string, provider: InboxProvider): Promise<string | null>;
	/** Stores serialized OAuth material encrypted; never expose this hook as a public cache command. */
	authCacheSet?(
		name: string,
		provider: InboxProvider,
		cache: string,
	): Promise<void>;
	/** Sends a validated named operation through the session-bound extension relay. */
	browserRequest?(request: InboxBrowserRequest): Promise<InboxBrowserResponse>;
};
const runtimes = new WeakMap<
	AppConfig,
	{ runtime: InboxRuntime; profile: string }
>();
export function bindInboxRuntime(
	config: AppConfig,
	runtime: InboxRuntime,
	profile: string,
): void {
	runtimes.set(config, { runtime, profile });
}
export function inboxRuntimeFor(config: AppConfig): {
	runtime: InboxRuntime;
	profile: string;
} {
	return runtimes.get(config) ?? { runtime: {}, profile: "default" };
}
