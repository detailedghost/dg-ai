import {
	discoverMailboxProviders,
	type EagerMailboxProviderModules,
} from "./discovery";

const modules: EagerMailboxProviderModules = import.meta.glob<
	Readonly<{ default?: unknown; provider?: unknown }>
>("./adapters/*.ts", { eager: true });

export const bundledMailboxProviders = discoverMailboxProviders(modules);
