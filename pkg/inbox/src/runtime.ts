import type {
	InboxProfile,
	InboxProvider,
	InboxBrowserRequest,
	InboxBrowserResponse,
} from "@dg/common";
import type { AppConfig } from "./config/types";
export type InboxRuntime = {
	profileGet?(name: string): Promise<InboxProfile | null>;
	profileSet?(name: string, profile: InboxProfile): Promise<void>;
	authCacheGet?(name: string, provider: InboxProvider): Promise<string | null>;
	authCacheSet?(
		name: string,
		provider: InboxProvider,
		cache: string,
	): Promise<void>;
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
