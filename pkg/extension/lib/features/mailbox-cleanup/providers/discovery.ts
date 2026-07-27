import type { MailboxProvider } from "./contracts";
import {
	defineMailboxProvider,
	MailboxProviderConfigurationError,
} from "./config";

export type EagerMailboxProviderModules = Readonly<
	Record<string, Readonly<{ default?: unknown; provider?: unknown }>>
>;

function fail(code: "provider_shape" | "provider_id" = "provider_shape"): never {
	throw new MailboxProviderConfigurationError(code);
}

function localModulePath(path: string): boolean {
	return (
		/^\.{1,2}\//.test(path) &&
		!path.includes("://") &&
		!path.startsWith("//") &&
		!path.includes("\0")
	);
}

/**
 * Resolves only already-bundled eager modules. No dynamic import, URL, fetch,
 * network lookup, or ambient registry is consulted.
 */
export function discoverMailboxProviders(
	modules: EagerMailboxProviderModules,
): readonly MailboxProvider[] {
	if (
		modules === null ||
		typeof modules !== "object" ||
		Array.isArray(modules) ||
		Object.getPrototypeOf(modules) !== Object.prototype
	) {
		fail();
	}
	const providers: MailboxProvider[] = [];
	const ids = new Set<string>();
	for (const path of Object.keys(modules).sort()) {
		if (!localModulePath(path)) fail();
		const module = modules[path];
		if (
			module === null ||
			typeof module !== "object" ||
			Array.isArray(module)
		) {
			fail();
		}
		const moduleKeys = Reflect.ownKeys(module);
		const stringKeys = moduleKeys.filter(
			(key): key is string => typeof key === "string",
		);
		const symbolKeys = moduleKeys.filter(
			(key): key is symbol => typeof key === "symbol",
		);
		if (
			symbolKeys.some((key) => key !== Symbol.toStringTag) ||
			stringKeys.length !== 1 ||
			(stringKeys[0] !== "default" && stringKeys[0] !== "provider")
		) {
			fail();
		}
		const exportKey =
			stringKeys[0] === "default" ? "default" : "provider";
		const descriptor = Object.getOwnPropertyDescriptor(module, exportKey);
		if (!descriptor || "get" in descriptor || "set" in descriptor) fail();
		if (symbolKeys.length === 1) {
			const tag = Object.getOwnPropertyDescriptor(module, Symbol.toStringTag);
			if (
				!tag ||
				"get" in tag ||
				"set" in tag ||
				tag.value !== "Module"
			) {
				fail();
			}
		}
		const exported = descriptor.value;
		if (exported === undefined) fail();
		const provider = defineMailboxProvider(exported as MailboxProvider);
		if (ids.has(provider.id)) fail("provider_id");
		ids.add(provider.id);
		providers.push(provider);
	}
	providers.sort((left, right) => left.id.localeCompare(right.id));
	return Object.freeze(providers);
}

export const discoverEagerMailboxProviders = discoverMailboxProviders;
