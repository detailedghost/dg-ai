import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describeError, isRecord } from "@dg/common";
import { DOCTOR_REGISTRY } from "../doctor/registry";
import { runDoctor, summarizeReport } from "../doctor/runner";
import { claudeConfigDir, type Runner, runSync } from "../install/recommended-plugins";
import { isCliOnly } from "../utils/cli-only";
import { compareVersions, listReleases, pickBundle, readCurrentVersion, readMarker } from "../utils/lib";

export const MARKETPLACE = "detailedghost";
export const MARKETPLACE_SOURCE = "detailedghost/dg-ai";
export const PLUGIN_REF = `dg@${MARKETPLACE}`;

export type StepStatus = "ok" | "skipped" | "failed";

export type StepResult = { name: string; status: StepStatus; detail: string };

export type UpdateOptions = { check?: boolean };

export type InstallTarget = "chrome" | "firefox" | "cli-only" | "bundle";

export type UpdateDeps = {
	platform: NodeJS.Platform;
	claudeHome: string;
	codexHome: string;
	install(target: InstallTarget, version: string): Promise<void>;
	newestVersion(): Promise<string>;
	installedVersion(): string | undefined;
	stagedExtensions(): Partial<Record<"chrome" | "firefox", string>>;
	cliOnly(): boolean;
	which(name: string): string | null;
	run: Runner;
	doctorSummary(): Promise<string>;
	log(line: string): void;
};

const STEP_ICON = { ok: "✅", skipped: "⏭️", failed: "❌" } as const;

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

function failure(name: string, argv: string[], stderr: string, status: number | null): StepResult {
	return { name, status: "failed", detail: `${argv.join(" ")}: ${firstLine(stderr) || `exit ${status ?? "signal"}`}` };
}

function runAll(name: string, steps: string[][], run: Runner, done: string): StepResult {
	for (const argv of steps) {
		const result = run(argv);
		if (result.status !== 0) return failure(name, argv, result.stderr, result.status);
	}
	return { name, status: "ok", detail: done };
}

type CodexState = { enabled: boolean; source?: string; local: boolean };

/** Reads whether the Codex config enables the dg plugin, and where its marketplace points. */
export function codexState(codexHome: string): CodexState {
	try {
		const config: unknown = Bun.TOML.parse(readFileSync(join(codexHome, "config.toml"), "utf8"));
		if (!isRecord(config)) return { enabled: false, local: false };
		const plugins = isRecord(config.plugins) ? config.plugins : {};
		const plugin = plugins[PLUGIN_REF];
		const markets = isRecord(config.marketplaces) ? config.marketplaces : {};
		const market = markets[MARKETPLACE];
		const source = isRecord(market) && typeof market.source === "string" ? market.source : undefined;
		const local = isRecord(market) && market.source_type === "local";
		return { enabled: isRecord(plugin) && plugin.enabled === true, source, local };
	} catch {
		return { enabled: false, local: false };
	}
}

/** Newest dg plugin version in the Codex plugin cache, which keeps only the installed copy. */
export function cachedPluginVersion(configHome: string): string | undefined {
	try {
		return readdirSync(join(configHome, "plugins", "cache", MARKETPLACE, "dg"))
			.filter((name) => /^\d+\.\d+\.\d+$/.test(name))
			.sort(compareVersions)
			.pop();
	} catch {
		return undefined;
	}
}

export type ClaudeInstall = { scope: string; version: string; projectPath?: string };

/** Every scope where Claude has the dg plugin installed, from installed_plugins.json. */
export function claudeInstalls(claudeHome: string): ClaudeInstall[] {
	try {
		const doc: unknown = JSON.parse(readFileSync(join(claudeHome, "plugins", "installed_plugins.json"), "utf8"));
		const plugins = isRecord(doc) && isRecord(doc.plugins) ? doc.plugins : {};
		const entries = plugins[PLUGIN_REF];
		return (Array.isArray(entries) ? entries : []).flatMap((entry) =>
			isRecord(entry) && typeof entry.scope === "string" && typeof entry.version === "string"
				? [
						{
							scope: entry.scope,
							version: entry.version,
							...(typeof entry.projectPath === "string" ? { projectPath: entry.projectPath } : {}),
						},
					]
				: [],
		);
	} catch {
		return [];
	}
}

/** The user-scope dg plugin version, which is the install update refreshes. */
export const claudePluginVersion = (claudeHome: string): string | undefined =>
	claudeInstalls(claudeHome).find((install) => install.scope === "user")?.version;

function scopeLabel(install: ClaudeInstall): string {
	return install.projectPath ? `${install.scope} ${install.projectPath}` : install.scope;
}

/** Turns a plugin step that ran cleanly into a failure when the cache is still behind the release. */
function reached(step: StepResult, current: () => string | undefined, version: string): StepResult {
	if (step.status !== "ok") return step;
	const cached = current();
	if (cached !== undefined && compareVersions(cached, version) >= 0) return step;
	return {
		...step,
		status: "failed",
		detail: `the dg plugin is ${cached ?? "missing"}, not ${version}; its marketplace may be pinned to an old ref (see Update the Claude Code plugin in docs/install.md)`,
	};
}

function guarded(name: string, step: () => StepResult): StepResult {
	try {
		return step();
	} catch (error) {
		return { name, status: "failed", detail: describeError(error) };
	}
}

function claudeStep(deps: UpdateDeps): StepResult {
	const name = "Claude plugin";
	if (!deps.which("claude")) return { name, status: "skipped", detail: "claude is not on PATH" };
	const refreshed = deps.run(["claude", "plugin", "marketplace", "update", MARKETPLACE]);
	if (refreshed.status !== 0) {
		const add = ["claude", "plugin", "marketplace", "add", MARKETPLACE_SOURCE];
		const added = deps.run(add);
		if (added.status !== 0) return failure(name, add, added.stderr, added.status);
	}
	const installed = claudePluginVersion(deps.claudeHome) !== undefined;
	const argv = ["claude", "plugin", installed ? "update" : "install", PLUGIN_REF, "--scope", "user"];
	return runAll(name, [argv], deps.run, `${installed ? "updated" : "installed"} ${PLUGIN_REF}`);
}

function codexStep(deps: UpdateDeps): StepResult {
	const name = "Codex plugin";
	if (!deps.which("codex")) return { name, status: "skipped", detail: "codex is not on PATH" };
	const state = codexState(deps.codexHome);
	if (!state.enabled)
		return {
			name,
			status: "skipped",
			detail: `${PLUGIN_REF} is not enabled in the Codex config${standaloneNote(deps)}`,
		};
	const repoint = state.local || state.source === undefined;
	const market = repoint
		? [
				...(state.source === undefined ? [] : [["codex", "plugin", "marketplace", "remove", MARKETPLACE]]),
				["codex", "plugin", "marketplace", "add", MARKETPLACE_SOURCE],
			]
		: [["codex", "plugin", "marketplace", "upgrade", MARKETPLACE]];
	const moved = repoint ? `; marketplace now ${MARKETPLACE_SOURCE}` : "";
	return runAll(name, [...market, ["codex", "plugin", "add", PLUGIN_REF]], deps.run, `updated ${PLUGIN_REF}${moved}`);
}

const BOOTSTRAP = "https://github.com/detailedghost/dg-ai/releases/latest/download";

/** The bootstrap command that refreshes standalone Codex skills, keeping a CLI-only install CLI-only. */
export function standaloneRefresh(platform: NodeJS.Platform, cliOnly: boolean): string {
	if (platform === "win32")
		return `$env:DG_INSTALL_CODEX = "1"; ${cliOnly ? '$env:DG_CLI_ONLY = "1"; ' : ""}irm ${BOOTSTRAP}/bootstrap.ps1 | iex`;
	return `curl -fsSL ${BOOTSTRAP}/bootstrap.sh | DG_INSTALL_CODEX=1 sh${cliOnly ? " -s -- --cli-only" : ""}`;
}

/** Skills copied into $CODEX_HOME/skills by a standalone install are not refreshed here; say how to refresh them. */
function standaloneNote(deps: UpdateDeps): string {
	return existsSync(join(deps.codexHome, "skills"))
		? `; skills copied into ${join(deps.codexHome, "skills")} are not refreshed here, refresh them with: ${standaloneRefresh(deps.platform, deps.cliOnly())}`
		: "";
}

/** One install per update, so the bundle is fetched and pruned once and the previous one stays for rollback. */
function installTarget(deps: UpdateDeps): { target: InstallTarget; others: string[] } {
	if (deps.cliOnly()) return { target: "cli-only", others: [] };
	const staged = (["chrome", "firefox"] as const).filter((target) => deps.stagedExtensions()[target] !== undefined);
	const [first, ...others] = staged;
	return { target: first ?? "bundle", others };
}

async function installStep(deps: UpdateDeps, version: string): Promise<StepResult> {
	const name = "CLI, runtime and extension";
	try {
		const { target, others } = installTarget(deps);
		await deps.install(target, version);
		const installed = deps.installedVersion();
		if (installed !== version)
			return { name, status: "failed", detail: `dg ${installed ?? "unknown"} is installed, not ${version}` };
		const more = others.map((other) => `; run dg-skills install ${other} to refresh the ${other} extension too`).join("");
		return { name, status: "ok", detail: `dg ${version} installed${more}` };
	} catch (error) {
		return { name, status: "failed", detail: describeError(error) };
	}
}

function claudeRows(deps: UpdateDeps): [string, string | undefined, boolean][] {
	const used = Boolean(deps.which("claude"));
	const others = claudeInstalls(deps.claudeHome).filter((install) => install.scope !== "user");
	return [
		["Claude plugin (user)", claudePluginVersion(deps.claudeHome), used],
		...others.map((install): [string, string, boolean] => [`Claude plugin (${scopeLabel(install)})`, install.version, used]),
	];
}

/** Names each other Claude scope that is still behind, with the command that updates it. */
function otherScopes(deps: UpdateDeps, version: string): void {
	for (const install of claudeInstalls(deps.claudeHome)) {
		if (install.scope === "user" || compareVersions(install.version, version) >= 0) continue;
		const where = install.projectPath ? `in ${install.projectPath}, ` : "";
		deps.log(`⚠️ Claude plugin (${scopeLabel(install)}) is ${install.version}; ${where}run claude plugin update ${PLUGIN_REF} --scope ${install.scope}`);
	}
}

/** Prints installed and newest versions; changes nothing. */
async function check(deps: UpdateDeps): Promise<number> {
	let newest: string;
	try {
		newest = await deps.newestVersion();
	} catch (error) {
		deps.log(`Could not read the newest release: ${describeError(error)}`);
		return 1;
	}
	const staged = Object.entries(deps.cliOnly() ? {} : deps.stagedExtensions()).map(
		([target, version]): [string, string | undefined, boolean] => [`${target} extension`, version, true],
	);
	const rows: [string, string | undefined, boolean][] = [
		["dg CLI", deps.installedVersion(), true],
		...staged,
		...claudeRows(deps),
		["Codex plugin", cachedPluginVersion(deps.codexHome), codexState(deps.codexHome).enabled],
	];
	let stale = false;
	for (const [label, version, used] of rows) {
		if (!used) {
			deps.log(`⏭️ ${label}: not used here`);
			continue;
		}
		const current = version !== undefined && compareVersions(version, newest) >= 0;
		stale ||= !current;
		deps.log(`${current ? "✅" : "⬆️"} ${label}: ${version ?? "not installed"}${current ? "" : ` -> ${newest}`}`);
	}
	const note = codexState(deps.codexHome).enabled ? "" : standaloneNote(deps);
	if (note) deps.log(`⚠️ Codex${note}`);
	deps.log(stale ? "Run dg-skills update to bring these up to date." : `Everything is at ${newest}.`);
	return stale ? 1 : 0;
}

/** Updates every dg part to the newest release, then runs doctor; exit 1 when a step failed. */
export async function runUpdate(opts: UpdateOptions, deps: UpdateDeps): Promise<number> {
	if (opts.check) return check(deps);
	const steps: StepResult[] = [];
	const report = (step: StepResult) => {
		steps.push(step);
		deps.log(`${STEP_ICON[step.status]} ${step.name}: ${step.detail}`);
	};
	let version: string;
	try {
		version = await deps.newestVersion();
	} catch (error) {
		deps.log(`❌ Could not read the newest release: ${describeError(error)}`);
		return 1;
	}
	report(await installStep(deps, version));
	report(reached(guarded("Claude plugin", () => claudeStep(deps)), () => claudePluginVersion(deps.claudeHome), version));
	report(reached(guarded("Codex plugin", () => codexStep(deps)), () => cachedPluginVersion(deps.codexHome), version));
	if (deps.which("claude")) otherScopes(deps, version);
	try {
		deps.log(`Doctor (information only, not part of the exit code): ${await deps.doctorSummary()}. Run dg-skills doctor for details.`);
	} catch (error) {
		deps.log(`Doctor did not run: ${describeError(error)}`);
	}
	deps.log("Restart Claude Code and Codex sessions to load the new skills, and reload the dg-ai-extension.");
	return steps.some((step) => step.status === "failed") ? 1 : 0;
}

export function defaultUpdateDeps(): UpdateDeps {
	const home = process.env.HOME ?? homedir();
	return {
		platform: process.platform,
		claudeHome: claudeConfigDir(home),
		codexHome: process.env.CODEX_HOME ?? join(home, ".codex"),
		install: async (target, version) => {
			const { installBundleOnly, runInstall } = await import("../install/cli");
			if (target === "bundle") await installBundleOnly(version);
			else if (target === "cli-only") await runInstall(undefined, { cliOnly: true, version });
			else await runInstall(target, { version });
		},
		newestVersion: async () => pickBundle(await listReleases()).version,
		installedVersion: () => readCurrentVersion(),
		stagedExtensions: () => {
			const marker = readMarker();
			return Object.fromEntries(
				(["chrome", "firefox"] as const).flatMap((target) => (marker[target] ? [[target, marker[target]]] : [])),
			);
		},
		cliOnly: isCliOnly,
		which: (name) => Bun.which(name),
		run: runSync,
		doctorSummary: async () => summarizeReport(await runDoctor([], DOCTOR_REGISTRY)),
		log: (line) => console.log(line),
	};
}
