import { isSecretRef, readDgToml } from "@dg/common/node/dg-toml";
import { envOverrides, inboxDefaults } from "./defaults";
import { loadRouteProfiles } from "./home";
import type { AppConfig, PartialAppConfig } from "./types";

type Env = Record<string, string | undefined>;

export type LoadConfigDeps = {
	env?: Env;
	resolveSecret?: (name: string) => Promise<string | undefined>;
	warn?: (line: string) => void;
};

async function defaultResolveSecret(name: string): Promise<string | undefined> {
	const { createCredentialClient, resolveDgPaths } = await import("@dg/common/node");
	const client = createCredentialClient({ paths: resolveDgPaths() });
	try {
		return (await client.get(name))?.value;
	} finally {
		client.close();
	}
}

async function tomlLayer(env: Env, deps: LoadConfigDeps): Promise<PartialAppConfig> {
	const inbox = structuredClone(readDgToml(env).inbox) as Record<string, Record<string, unknown> | undefined>;
	for (const provider of ["gmail", "outlook"] as const) {
		const section = inbox[provider];
		const ref = section?.clientSecret;
		if (!section || !isSecretRef(ref)) continue;
		delete section.clientSecret;
		try {
			const value = await (deps.resolveSecret ?? defaultResolveSecret)(ref.credential);
			if (value !== undefined) section.clientSecret = value;
		} catch (error) {
			(deps.warn ?? ((line) => process.stderr.write(line)))(
				`inbox: inbox.${provider}.clientSecret did not resolve from credential ${ref.credential} (${error instanceof Error ? error.message : String(error)}); it stays unset\n`,
			);
		}
	}
	return inbox as PartialAppConfig;
}

/** Inbox settings: defaults, then config.toml [inbox], then env vars, then the --config file. */
export async function loadConfig(path?: string, deps: LoadConfigDeps = {}): Promise<AppConfig> {
	const env = deps.env ?? process.env;
	const flag = path && (await Bun.file(path).exists()) ? ((await Bun.file(path).json()) as PartialAppConfig) : {};
	const merged = [await tomlLayer(env, deps), envOverrides(env), flag].reduce(mergeConfig, inboxDefaults(env));
	return {
		...merged,
		routeProfiles: await loadRouteProfiles(merged.configHome),
	};
}

export function mergeConfig(
	base: AppConfig,
	override: PartialAppConfig,
): AppConfig {
	return {
		configHome: override.configHome ?? base.configHome,
		provider: override.provider ?? base.provider,
		protonmail: {
			...base.protonmail,
			...override.protonmail,
			endpoints: {
				...base.protonmail.endpoints,
				...override.protonmail?.endpoints,
			},
		},
		gmail: {
			...base.gmail,
			...override.gmail,
			scopes: { ...base.gmail.scopes, ...override.gmail?.scopes },
		},
		outlook: {
			...base.outlook,
			...override.outlook,
			scopes: { ...base.outlook.scopes, ...override.outlook?.scopes },
		},
		classifier: { ...base.classifier, ...override.classifier },
		output: { ...base.output, ...override.output },
		routeProfiles: base.routeProfiles,
		security: { ...base.security, ...override.security },
	};
}
