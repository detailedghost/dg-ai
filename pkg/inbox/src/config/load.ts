import { defaultConfig } from "./defaults";
import { loadRouteProfiles } from "./home";
import type { AppConfig, PartialAppConfig } from "./types";

export async function loadConfig(
	path = `${defaultConfig.configHome}/organizer.config.json`,
): Promise<AppConfig> {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return {
			...mergeConfig(defaultConfig, {}),
			routeProfiles: await loadRouteProfiles(defaultConfig.configHome),
		};
	}

	const parsed = (await file.json()) as PartialAppConfig;
	const merged = mergeConfig(defaultConfig, parsed);
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
