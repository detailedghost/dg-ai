import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createCredentialClient,
	isDaemonLive,
	readPidFile,
	skillsInstallDest,
} from "@dg/common/node";
import {
	allowRuleFor,
	CLI_PATH,
	hasAllowRule,
	installedPlugins,
	isOlder,
	readAllowRules,
	toolVersion,
	unslopInstalled,
	whichBinary,
} from "./probes";
import {
	type CheckResult,
	type DoctorCheck,
	type DoctorContext,
	fail,
	ok,
	warn,
} from "./types";

type ToolInstall = Partial<Record<NodeJS.Platform | "any", string>>;

const INSTALL_TOOL: Record<string, ToolInstall> = {
	git: {
		linux: "sudo apt-get install -y git",
		darwin: "brew install git",
		win32: "winget install Git.Git",
	},
	gh: {
		linux: "sudo apt-get install -y gh",
		darwin: "brew install gh",
		win32: "winget install GitHub.cli",
	},
	glab: {
		linux: "brew install glab",
		darwin: "brew install glab",
		win32: "winget install GLab.GLab",
	},
	bun: {
		linux: "curl -fsSL https://bun.sh/install | bash",
		darwin: "curl -fsSL https://bun.sh/install | bash",
		win32: 'powershell -c "irm bun.sh/install.ps1 | iex"',
	},
	claude: { any: "npm install -g @anthropic-ai/claude-code" },
	codex: { any: "npm install -g @openai/codex" },
	copilot: { any: "npm install -g @github/copilot" },
	"wl-paste": { linux: "sudo apt-get install -y wl-clipboard" },
	xclip: { linux: "sudo apt-get install -y xclip" },
};

export const PLUGIN_INSTALL = "claude plugin install dg@detailedghost";
export const PLUGIN_UPDATE = "claude plugin update dg@detailedghost";
const DAEMON_START = "dg-agent start";
const DAEMON_PAIR = "dg-daemon pair";

export interface ToolSpec {
	tool: string;
	min?: string;
}

function installHint(tool: string, platform: NodeJS.Platform): string | null {
	const entry = INSTALL_TOOL[tool];
	return entry?.[platform] ?? entry?.any ?? null;
}

function noHint(tool: string): string {
	return `install ${tool} for this platform and put it on PATH`;
}

export function installCommand(
	tool: string,
	platform: NodeJS.Platform = process.platform,
): string {
	return installHint(tool, platform) ?? noHint(tool);
}

export function upgradeCommand(
	tool: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const install = installHint(tool, platform);
	if (!install) return noHint(tool);
	return install
		.replace("sudo apt-get install -y ", "sudo apt-get install --only-upgrade -y ")
		.replace("brew install ", "brew upgrade ")
		.replace("winget install ", "winget upgrade ");
}

export const isCliOnly = (ctx: DoctorContext): boolean =>
	existsSync(join(ctx.paths.stateDir, "cli-only"));

export function bootstrapCommand(
	ctx: DoctorContext,
	platform: NodeJS.Platform = process.platform,
): string {
	const base = "https://github.com/detailedghost/dg-ai/releases/latest/download";
	const cliOnly = isCliOnly(ctx);
	if (platform === "win32") {
		const script = `irm ${base}/bootstrap.ps1 | iex`;
		return cliOnly ? `$env:DG_CLI_ONLY = "1"; ${script}` : script;
	}
	const script = `curl -fsSL ${base}/bootstrap.sh | sh`;
	return cliOnly ? `${script} -s -- --cli-only` : script;
}

interface ToolProbe {
	spec: ToolSpec;
	version: string | null;
}

function probeTool(spec: ToolSpec, ctx: DoctorContext): ToolProbe | null {
	return ctx.memo(`tool:${spec.tool}`, () => {
		const binary = whichBinary(spec.tool, ctx.env);
		if (!binary) return null;
		return { spec, version: toolVersion(binary) };
	});
}

function describeTool(probe: ToolProbe, min?: string): string {
	const version = probe.version ?? "unknown version";
	return `${probe.spec.tool} ${version}${min ? ` (needs ${min} or newer)` : ""}`;
}

export function toolCheck(
	spec: ToolSpec,
	options: { required: boolean; why: string; installFix?: string },
): DoctorCheck {
	const level = options.required ? fail : warn;
	return {
		id: `tool-${spec.tool}`,
		run(ctx) {
			const probe = probeTool(spec, ctx);
			if (!probe)
				return level(
					`${spec.tool} was not found on PATH; ${options.why}`,
					options.installFix ?? installCommand(spec.tool),
				);
			if (spec.min && probe.version === null)
				return warn(
					`${spec.tool} is installed but its version could not be read`,
					`${spec.tool} --version`,
				);
			if (spec.min && probe.version && isOlder(probe.version, spec.min))
				return level(
					`${spec.tool} ${probe.version} is older than ${spec.min}; ${options.why}`,
					upgradeCommand(spec.tool),
				);
			return ok(describeTool(probe, spec.min));
		},
	};
}

export function anyToolCheck(
	id: string,
	specs: ToolSpec[],
	options: { required: boolean; why: string },
): DoctorCheck {
	const level = options.required ? fail : warn;
	const names = specs.map((spec) => spec.tool).join(" or ");
	return {
		id,
		run(ctx) {
			const tooOld: string[] = [];
			const found = specs.flatMap((spec) => {
				const probe = probeTool(spec, ctx);
				if (!probe) return [];
				if (spec.min && probe.version && isOlder(probe.version, spec.min)) {
					tooOld.push(spec.tool);
					return [];
				}
				return [describeTool(probe, spec.min)];
			});
			if (found.length > 0) return ok(found.join(", "));
			const first = specs[0]?.tool ?? "";
			if (tooOld.length > 0)
				return level(
					`${tooOld.join(" and ")} too old; ${options.why}`,
					upgradeCommand(tooOld[0] ?? first),
				);
			return level(
				`none of ${names} was found; ${options.why}`,
				installCommand(first),
			);
		},
	};
}

export const gitCheck = (min?: string): DoctorCheck =>
	toolCheck({ tool: "git", min }, { required: true, why: "this command runs git" });

export const vcsCliCheck = (required = true): DoctorCheck =>
	anyToolCheck("tool-vcs-cli", [{ tool: "gh" }, { tool: "glab" }], {
		required,
		why: "this command talks to GitHub or GitLab",
	});

export function skillFilesCheck(skills: string[]): DoctorCheck {
	return {
		id: "skill-files",
		run(ctx) {
			const plugins = installedPlugins(ctx.home);
			const roots = [
				...plugins.map((plugin) => plugin.skillsDir),
				skillsInstallDest(ctx.env, ctx.home),
			];
			const missing = skills.filter(
				(skill) => !roots.some((root) => existsSync(join(root, skill, "SKILL.md"))),
			);
			if (missing.length === 0) return ok(`skill files found for ${skills.join(", ")}`);
			return fail(
				`skill files missing for ${missing.join(", ")}`,
				plugins.length > 0 ? PLUGIN_UPDATE : PLUGIN_INSTALL,
			);
		},
	};
}

export function allowRuleCheck(sub: string): DoctorCheck {
	return {
		id: "allow-rule",
		run(ctx) {
			const rule = allowRuleFor(sub);
			const allowed = readAllowRules(ctx.home);
			if ("error" in allowed)
				return warn(
					`cannot read ~/.claude/settings.json: ${allowed.error}`,
					"jq . ~/.claude/settings.json",
				);
			if (hasAllowRule(allowed.rules, sub))
				return ok(`allow rule present for ${CLI_PATH} ${sub}`);
			return warn(
				`~/.claude/settings.json has no allow rule for ${CLI_PATH} ${sub}, so Claude asks before each call`,
				rule,
			);
		},
	};
}

export function credentialChecks(names: string[]): DoctorCheck[] {
	return names.map((name) => ({
		id: `credential-${name.replaceAll("/", "-")}`,
		async run(ctx) {
			const stored = await storedCredentialNames(ctx);
			if ("error" in stored)
				return warn(
					`cannot list credentials: ${stored.error}`,
					stored.fix,
				);
			if (stored.names.includes(name)) return ok(`credential ${name} is stored`);
			return warn(
				`credential ${name} is not stored`,
				`${CLI_PATH} credentials set ${name}`,
			);
		},
	}));
}

type CredentialNames =
	| { names: string[] }
	| { error: string; fix: string };

function storedCredentialNames(ctx: DoctorContext): Promise<CredentialNames> {
	return ctx.memo("credential-names", async () => {
		const handle = readPidFile(ctx.paths);
		if (!handle) return { error: "dg-daemon is not running", fix: DAEMON_START };
		if (!(await ctx.memo("daemon-live", () => isDaemonLive(handle))))
			return { error: "dg-daemon is not answering", fix: DAEMON_START };
		const client = createCredentialClient({ paths: ctx.paths, env: ctx.env });
		try {
			return { names: (await client.list()).map((entry) => entry.name) };
		} catch (error) {
			return {
				error: error instanceof Error ? error.message : String(error),
				fix: `${CLI_PATH} install`,
			};
		} finally {
			client.close();
		}
	});
}

export const credentialStoreCheck: DoctorCheck = {
	id: "credential-store",
	async run(ctx) {
		const stored = await storedCredentialNames(ctx);
		if ("error" in stored)
			return warn(`cannot list credentials: ${stored.error}`, stored.fix);
		return ok(`credential store lists ${stored.names.length} credential(s)`);
	},
};

export const daemonCheck: DoctorCheck = {
	id: "daemon",
	async run(ctx): Promise<CheckResult> {
		const handle = readPidFile(ctx.paths);
		if (!handle) return fail("dg-daemon is not running", DAEMON_START);
		const live = await ctx.memo("daemon-live", () => isDaemonLive(handle));
		return live
			? ok(`dg-daemon answers on port ${handle.port}`)
			: fail(`dg-daemon is not answering on port ${handle.port}`, DAEMON_START);
	},
};

function pinnedOrigin(ctx: DoctorContext): string | null {
	try {
		const config: unknown = JSON.parse(readFileSync(ctx.paths.configPath, "utf8"));
		const pinned = (config as { pinnedOrigin?: unknown } | null)?.pinnedOrigin;
		return typeof pinned === "string" && pinned.length > 0 ? pinned : null;
	} catch {
		return null;
	}
}

export const pairingCheck: DoctorCheck = {
	id: "extension-paired",
	run(ctx) {
		const origin = pinnedOrigin(ctx);
		if (origin) return ok(`the daemon has pinned the extension origin ${origin}`);
		return warn(
			existsSync(ctx.paths.pairingPath)
				? "a pairing code is pending and no extension has connected yet; enter the code in the extension"
				: "no extension has connected to the daemon yet; open the extension to check, or start pairing",
			DAEMON_PAIR,
		);
	},
};

function unlessCliOnly(check: DoctorCheck): DoctorCheck {
	return {
		id: check.id,
		run: (ctx) =>
			isCliOnly(ctx)
				? warn(
						"skipped: this CLI-only install has no daemon or extension",
						`${CLI_PATH} install`,
					)
				: check.run(ctx),
	};
}

export const cliOnlyCheck: DoctorCheck = {
	id: "extension-installed",
	run(ctx) {
		return isCliOnly(ctx)
			? warn(
					"this is a CLI-only install, so extension features are off",
					`${CLI_PATH} install`,
				)
			: ok("the extension is part of this install");
	},
};

export const extensionChecks: DoctorCheck[] = [
	cliOnlyCheck,
	unlessCliOnly(daemonCheck),
	unlessCliOnly(pairingCheck),
];

export const unslopCheck: DoctorCheck = {
	id: "unslop",
	run(ctx) {
		return unslopInstalled(ctx.home)
			? ok("unslop is installed")
			: warn(
					"unslop is not installed, so polish skips its prose pass",
					"claude plugin install unslop@detailedghost",
				);
	},
};
