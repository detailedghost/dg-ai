import { detectProvider } from "./detect";
import { createGithubProvider } from "./github";
import { createGitlabProvider } from "./gitlab";
import type { Provider, ProviderKind } from "./types";

function buildProvider(kind: ProviderKind): Provider {
	return kind === "github" ? createGithubProvider() : createGitlabProvider();
}

const cache = new Map<string, Promise<Provider>>();

function cacheKey(override: ProviderKind | undefined, cwd: string): string {
	return `${override ?? ""}::${cwd}`;
}

/** Discard cached provider resolutions, including their captured executable/configuration choices. */
export function resetProviderCache(): void {
	cache.clear();
}

/** Cache resolution by cwd and explicit provider override; rejected resolutions are evicted for retry. */
export async function getProvider(override?: ProviderKind): Promise<Provider> {
	const cwd = process.cwd();
	const key = cacheKey(override, cwd);
	const cached = cache.get(key);
	if (cached) return cached;

	const resolution = (async () => {
		const kind = override ?? (await detectProvider()).kind;
		return buildProvider(kind);
	})();
	cache.set(key, resolution);
	resolution.catch(() => {
		if (cache.get(key) === resolution) {
			cache.delete(key);
		}
	});
	return resolution;
}

/** Resolve a URL-specific adapter without using the cwd cache; recognized URLs outrank the provider override. */
export async function getProviderForUrl(url: string): Promise<Provider> {
	const { kind } = await detectProvider(url);
	return buildProvider(kind);
}
