import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describeError, isRecord } from "@dg/common";
import { installedPlugins } from "../doctor/probes";
import { type Runner, runSync } from "../install/recommended-plugins";
import { compareVersions, listReleases, pickBundle, readCurrentVersion } from "../utils/lib";

export const MARKETPLACE = "detailedghost";
export const MARKETPLACE_SOURCE = "detailedghost/dg-ai";
export const PLUGIN_REF = `dg@${MARKETPLACE}`;

export type StepStatus = "ok" | "skipped" | "failed";

export type StepResult = { name: string; status: StepStatus; detail: string };

export type UpdateOptions = { version?: string; check?: boolean };

export type UpdateDeps = {
	home: string;
	install(version?: string): Promise<void>;
	newestVersion(version?: string): Promise<string>;
	installedVersion(): string | undefined;
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

type CodexState = { enabled: boolean; source?: string };

/** Reads whether ~/.codex/config.toml enables the dg plugin, and where its marketplace points. */
export function codexState(home: string): CodexState {
	try {
		const config: unknown = Bun.TOML.parse(readFileSync(join(home, ".codex", "config.toml"), "utf8"));
		if (!isRecord(config)) return { enabled: false };
		const plugins = isRecord(config.plugins) ? config.plugins : {};
		const plugin = plugins[PLUGIN_REF];
		const markets = isRecord(config.marketplaces) ? config.marketplaces : {};
		const market = markets[MARKETPLACE];
		const source = isRecord(market) && typeof market.source === "string" ? market.source : undefined;
		return { enabled: isRecord(plugin) && plugin.enabled === true, source };
	} catch {
		return { enabled: false };
	}
}

/** Newest dg plugin version in the Codex plugin cache. */
export function codexPluginVersion(home: string): string | undefined {
	try {
		const dir = join(home, ".codex", "plugins", "cache", MARKETPLACE, "dg");
		return readdirSync(dir).sort(compareVersions).pop();
	} catch {
		return undefined;
	}
}

const isGithubSource = (source: string | undefined): boolean =>
	source !== undefined && /detailedghost\/dg-ai(\.git)?$/.test(source);

function claudeStep(deps: UpdateDeps): StepResult {
	const name = "Claude plugin";
	if (!deps.which("claude")) return { name, status: "skipped", detail: "claude is not on PATH" };
	const refreshed = deps.run(["claude", "plugin", "marketplace", "update", MARKETPLACE]);
	if (refreshed.status !== 0) {
		const added = deps.run(["claude", "plugin", "marketplace", "add", MARKETPLACE_SOURCE]);
		if (added.status !== 0)
			return failure(name, ["claude", "plugin", "marketplace", "add", MARKETPLACE_SOURCE], added.stderr, added.status);
	}
	const installed = installedPlugins(deps.home).length > 0;
	const argv = ["claude", "plugin", installed ? "update" : "install", PLUGIN_REF];
	return runAll(name, [argv], deps.run, `${installed ? "updated" : "installed"} ${PLUGIN_REF}`);
}

function codexStep(deps: UpdateDeps): StepResult {
	const name = "Codex plugin";
	if (!deps.which("codex")) return { name, status: "skipped", detail: "codex is not on PATH" };
	const state = codexState(deps.home);
	if (!state.enabled) return { name, status: "skipped", detail: `${PLUGIN_REF} is not enabled in ~/.codex/config.toml` };
	const market = isGithubSource(state.source)
		? [["codex", "plugin", "marketplace", "upgrade", MARKETPLACE]]
		: [
				...(state.source === undefined ? [] : [["codex", "plugin", "marketplace", "remove", MARKETPLACE]]),
				["codex", "plugin", "marketplace", "add", MARKETPLACE_SOURCE],
			];
	const moved = isGithubSource(state.source) ? "" : `; marketplace now ${MARKETPLACE_SOURCE}`;
	return runAll(name, [...market, ["codex", "plugin", "add", PLUGIN_REF]], deps.run, `updated ${PLUGIN_REF}${moved}`);
}

async function installStep(deps: UpdateDeps, version?: string): Promise<StepResult> {
	const name = "CLI, runtime and extension";
	try {
		await deps.install(version);
		return { name, status: "ok", detail: `dg ${deps.installedVersion() ?? "unknown"} installed` };
	} catch (error) {
		return { name, status: "failed", detail: describeError(error) };
	}
}

/** Prints installed and newest versions; changes nothing. */
async function check(opts: UpdateOptions, deps: UpdateDeps): Promise<number> {
	let newest: string;
	try {
		newest = await deps.newestVersion(opts.version);
	} catch (error) {
		deps.log(`Could not read the newest release: ${describeError(error)}`);
		return 1;
	}
	const rows: [string, string | undefined, boolean][] = [
		["dg CLI", deps.installedVersion(), true],
		["Claude plugin", installedPlugins(deps.home)[0]?.version, Boolean(deps.which("claude"))],
		["Codex plugin", codexPluginVersion(deps.home), codexState(deps.home).enabled],
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
	deps.log(stale ? "Run dg-skills update to bring these up to date." : `Everything is at ${newest}.`);
	return stale ? 1 : 0;
}

/** Updates every dg part, then runs doctor; exit 1 when a step failed. */
export async function runUpdate(opts: UpdateOptions, deps: UpdateDeps): Promise<number> {
	if (opts.check) return check(opts, deps);
	const steps: StepResult[] = [];
	const report = (step: StepResult) => {
		steps.push(step);
		deps.log(`${STEP_ICON[step.status]} ${step.name}: ${step.detail}`);
	};
	report(await installStep(deps, opts.version));
	report(claudeStep(deps));
	report(codexStep(deps));
	try {
		deps.log(`Doctor: ${await deps.doctorSummary()}. Run dg-skills doctor for details.`);
	} catch (error) {
		deps.log(`Doctor did not run: ${describeError(error)}`);
	}
	deps.log("Restart Claude Code and Codex sessions to load the new skills, and reload the dg-ai-extension.");
	return steps.some((step) => step.status === "failed") ? 1 : 0;
}

export function defaultUpdateDeps(): UpdateDeps {
	return {
		home: process.env.HOME ?? homedir(),
		install: async (version) => {
			const { runInstall } = await import("../install/cli");
			await runInstall(undefined, { version });
		},
		newestVersion: async (version) => pickBundle(await listReleases(), version).version,
		installedVersion: () => readCurrentVersion(),
		which: (name) => Bun.which(name),
		run: runSync,
		doctorSummary: async () => {
			const [{ DOCTOR_REGISTRY }, { runDoctor, summarizeReport }] = await Promise.all([
				import("../doctor/registry"),
				import("../doctor/runner"),
			]);
			return summarizeReport(await runDoctor([], DOCTOR_REGISTRY));
		},
		log: (line) => console.log(line),
	};
}
