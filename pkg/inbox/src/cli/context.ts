import { bindInboxRuntime, type InboxRuntime } from "../runtime";
import type { InboxProfile, InboxProviderSettings } from "@dg/common";
import { loadConfig } from "../config/load";
import type { AppConfig } from "../config/types";
import { resolveProvider } from "../providers/factory";
import {
	accountProfileSlug,
	detectProfileProvider,
	profileTokenCachePath,
	workspaceDirForProfile,
} from "../workspace/profile";
import type { WorkspaceLogin } from "../workspace/types";
import { getBooleanFlag, getStringFlag, type ParsedArgs } from "./args";
import { outputOptionsFromFlags, type OutputOptions } from "./output";

export type CliContext = {
	config: AppConfig;
	args: ParsedArgs;
	output: OutputOptions;
};

export async function createCliContext(
	args: ParsedArgs,
	runtime: InboxRuntime = {},
): Promise<CliContext> {
	const configPath =
		typeof args.flags.config === "string" ? args.flags.config : undefined;
	const config = await loadConfig(configPath);
	const providerFlag = getStringFlag(args.flags, "provider");
	if (providerFlag) config.provider = resolveProvider(config, providerFlag);
	await applyWorkspaceLoginConfig(config, args);
	const profileName = getStringFlag(args.flags, "account-profile") || "default";
	const explicitFixture =
		typeof args.flags["data-path"] === "string" ||
		typeof args.flags["gmail-data-path"] === "string";
	if (
		runtime.profileGet &&
		(!explicitFixture || !providerFlag || args.flags["account-profile"])
	) {
		const profile = await runtime.profileGet(profileName);
		if (profile) applyDatabaseProfile(config, profile);
		else if (
			args.flags["account-profile"] &&
			!explicitFixture &&
			args.group !== "init"
		)
			throw new Error(
				"Inbox account profile was not found. Configure it with dg-skills inbox profile set before accessing mail.",
			);
	}
	if (providerFlag) config.provider = resolveProvider(config, providerFlag);
	bindInboxRuntime(config, runtime, profileName);
	applyAccountProfileConfig(config, args);
	if (typeof args.flags["data-path"] === "string") {
		if (config.provider === "gmail") {
			config.gmail.dataPath = args.flags["data-path"];
		} else if (config.provider === "outlook") {
			config.outlook.dataPath = args.flags["data-path"];
		} else {
			config.protonmail.dataPath = args.flags["data-path"];
		}
	}
	if (typeof args.flags["gmail-data-path"] === "string") {
		config.gmail.dataPath = args.flags["gmail-data-path"];
	}
	if (args.flags["live-browser"] !== undefined) {
		config.protonmail.liveBrowser = getBooleanFlag(args.flags, "live-browser");
	}
	const sessionProfile = getStringFlag(args.flags, "session-profile");
	if (sessionProfile) {
		config.protonmail.sessionProfile = sessionProfile;
	}
	const browserType = getStringFlag(args.flags, "browser-type");
	if (browserType) {
		config.protonmail.browserType = browserType;
	}
	const browserExecutablePath = getStringFlag(
		args.flags,
		"browser-executable-path",
	);
	if (browserExecutablePath) {
		config.protonmail.browserExecutablePath = browserExecutablePath;
	}
	if (args.flags["browser-headless"] !== undefined) {
		config.protonmail.browserHeadless = getBooleanFlag(
			args.flags,
			"browser-headless",
		);
	}

	return {
		config,
		args,
		output: outputOptionsFromFlags(args.flags),
	};
}

async function applyWorkspaceLoginConfig(
	config: AppConfig,
	args: ParsedArgs,
): Promise<void> {
	if (args.group === "init") {
		return;
	}
	const providerFlag = getStringFlag(args.flags, "provider");
	const explicitDir = getStringFlag(args.flags, "dir");
	const accountProfile = getStringFlag(args.flags, "account-profile");
	// `--account-profile` alone doesn't say which provider's `dist/` tree to
	// check; probe each provider's profile path so `--provider` stays optional.
	if (!providerFlag && !explicitDir && accountProfile) {
		const detected = await detectProfileProvider({ accountProfile });
		if (detected) {
			config.provider = detected;
		}
	}
	const dir = workspaceDirForProfile({
		provider: config.provider,
		explicitDir,
		accountProfile,
	});
	const file = Bun.file(`${dir}/login.json`);
	if (!(await file.exists())) {
		return;
	}
	const login = (await file.json()) as Partial<WorkspaceLogin>;
	if (typeof login.sessionProfile === "string" && login.sessionProfile) {
		config.protonmail.sessionProfile = login.sessionProfile;
	}
	if (typeof login.apiBaseUrl === "string" && login.apiBaseUrl) {
		config.protonmail.apiBaseUrl = login.apiBaseUrl;
	}
	if (typeof login.liveBrowser === "boolean") {
		config.protonmail.liveBrowser = login.liveBrowser;
	}
	if (typeof login.browserType === "string" && login.browserType) {
		config.protonmail.browserType = login.browserType;
	}
	if (
		typeof login.browserExecutablePath === "string" &&
		login.browserExecutablePath
	) {
		config.protonmail.browserExecutablePath = login.browserExecutablePath;
	}
	if (typeof login.browserHeadless === "boolean") {
		config.protonmail.browserHeadless = login.browserHeadless;
	}
	if (
		login.liveBrowser === true &&
		args.flags["browser-headless"] === undefined
	) {
		config.protonmail.browserHeadless = true;
	}
	if (
		!providerFlag &&
		(login.provider === "gmail" ||
			login.provider === "outlook" ||
			login.provider === "protonmail")
	) {
		config.provider = login.provider;
	}
	if (typeof login.username === "string" && login.username) {
		config.outlook.loginHint = login.username;
	}
	if (typeof login.accountProfile === "string" && login.accountProfile) {
		config.outlook.accountProfile = login.accountProfile;
		config.outlook.tokenCachePath = profileTokenCachePath({
			configHome: config.configHome,
			provider: "outlook",
			accountProfile: login.accountProfile,
			fallbackPath: config.outlook.tokenCachePath,
		});
	}
}

function applyAccountProfileConfig(config: AppConfig, args: ParsedArgs): void {
	const accountProfile = accountProfileSlug(
		getStringFlag(args.flags, "account-profile"),
	);
	if (!accountProfile) {
		return;
	}
	config.outlook.accountProfile = accountProfile;
	config.outlook.tokenCachePath = profileTokenCachePath({
		configHome: config.configHome,
		provider: "outlook",
		accountProfile,
		fallbackPath: config.outlook.tokenCachePath,
	});
}

function applyDatabaseProfile(config: AppConfig, profile: InboxProfile): void {
	config.provider = profile.provider;
	config.protonmail.tabId = profile.tabId;
	config.protonmail.accountHint = profile.accountHint;
	const apply = (
		provider: "gmail" | "outlook",
		settings: InboxProviderSettings | undefined,
	) => {
		if (!settings) return;
		const { scopes, ...flat } = settings;
		if (provider === "gmail") {
			const { tenantId, authority, ...google } = flat;
			config.gmail = {
				...config.gmail,
				...google,
				authMode:
					settings.authMode === "silent"
						? "browser"
						: settings.authMode ?? config.gmail.authMode,
			};
			if (scopes)
				config.gmail.scopes = {
					read: scopes,
					modify: scopes,
					settings: scopes,
				};
			config.gmail.loginHint = profile.accountHint;
		} else {
			config.outlook = { ...config.outlook, ...flat };
			if (scopes)
				config.outlook.scopes = { read: scopes, write: scopes, rules: scopes };
			config.outlook.loginHint =
				settings.loginHint ?? profile.accountHint ?? config.outlook.loginHint;
		}
	};
	apply("gmail", profile.gmail);
	apply("outlook", profile.outlook);
}

export function workspaceDirForContext(context: CliContext): string {
	return workspaceDirForProfile({
		provider: context.config.provider,
		explicitDir: getStringFlag(context.args.flags, "dir"),
		accountProfile: getStringFlag(context.args.flags, "account-profile"),
	});
}
