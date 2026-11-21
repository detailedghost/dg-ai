import { existsSync } from "node:fs";
import { isAbsolute, win32 } from "node:path";
import { skillFilesCheck } from "../doctor/checks";
import { CLI_PATH, readAllowRules, whichBinary } from "../doctor/probes";
import {
	type DoctorCheck,
	type DoctorContext,
	ok,
	warn,
} from "../doctor/types";
import {
	describeStripResolution,
	resolveStripAiCoauthors,
} from "./defs/strip-ai-coauthors";
import { claudeWriter } from "./settings/claude";
import { codexWriter } from "./settings/codex";
import { opencodeWriter } from "./settings/opencode";
import { ownedEntries } from "./settings/owned";
import type { HookRuntime, SettingsWriter } from "./types";

const RUNTIMES: readonly HookRuntime[] = ["claude", "codex", "opencode"];

function writerFor(runtime: HookRuntime, ctx: DoctorContext): SettingsWriter {
	if (runtime === "claude") return claudeWriter(ctx.home);
	if (runtime === "codex") return codexWriter(ctx.home, ctx.env.CODEX_HOME);
	return opencodeWriter(ctx.home, "dg", ctx.env.XDG_CONFIG_HOME);
}

function resolves(launcher: string, ctx: DoctorContext): boolean {
	return isAbsolute(launcher) || win32.isAbsolute(launcher)
		? existsSync(launcher)
		: whichBinary(launcher, ctx.env) !== null;
}

/** Allow rules for the hooks commands that never enable a hook. */
export const HOOKS_ALLOW_RULES: readonly string[] = [
	"status",
	"list",
	"disable",
].map((sub) => `Bash(${CLI_PATH} hooks ${sub}:*)`);

const BROAD_RULES = [`Bash(${CLI_PATH} hooks:*)`, `Bash(${CLI_PATH}:*)`];

const hooksAllowRuleCheck: DoctorCheck = {
	id: "allow-rule",
	run(ctx) {
		const allowed = readAllowRules(ctx.home);
		if ("error" in allowed)
			return warn(
				`cannot read ~/.claude/settings.json: ${allowed.error}`,
				"jq . ~/.claude/settings.json",
			);
		const broad = BROAD_RULES.filter((rule) => allowed.rules.includes(rule));
		if (broad.length > 0)
			return warn(
				`${broad.join(", ")} also allows hooks enable, so Claude does not ask before it enables a hook`,
				`replace it with ${HOOKS_ALLOW_RULES.join(" ")}`,
			);
		const missing = HOOKS_ALLOW_RULES.filter(
			(rule) => !allowed.rules.includes(rule),
		);
		if (missing.length === 0)
			return ok(
				`allow rules present for ${CLI_PATH} hooks status, list and disable`,
			);
		return warn(
			`~/.claude/settings.json has no allow rule for ${CLI_PATH} hooks status, list or disable, so Claude asks before each call`,
			missing.join(" "),
		);
	},
};

function settingsCheck(runtime: HookRuntime): DoctorCheck {
	return {
		id: `settings-${runtime}`,
		run(ctx) {
			const writer = writerFor(runtime, ctx);
			try {
				writer.check();
				ownedEntries(runtime, writer);
			} catch (error) {
				return warn(
					error instanceof Error ? error.message : String(error),
					`fix or move aside ${writer.file}`,
				);
			}
			return ok(`${runtime} hook settings are readable`);
		},
	};
}

const staleEntriesCheck: DoctorCheck = {
	id: "stale-entries",
	run(ctx) {
		const stale = new Map<HookRuntime, string[]>();
		const unreadable: HookRuntime[] = [];
		for (const runtime of RUNTIMES) {
			try {
				for (const entry of ownedEntries(runtime, writerFor(runtime, ctx)))
					if (!resolves(entry.launcher, ctx))
						stale.set(runtime, [...(stale.get(runtime) ?? []), entry.id]);
			} catch {
				unreadable.push(runtime);
			}
		}
		if (unreadable.length === 0 && stale.size === 0)
			return ok("every dg hook entry resolves to dg");
		const details: string[] = [];
		const fixes: string[] = [];
		if (stale.size > 0) {
			const summary = [...stale]
				.map(([runtime, ids]) => `${runtime}:${ids.join(",")}`)
				.join(" ");
			details.push(`dg hook entries point at a missing dg: ${summary}`);
			fixes.push(
				...[...stale].map(
					([runtime, ids]) =>
						`dg hooks disable ${ids.join(" ")} --runtime ${runtime}`,
				),
			);
		}
		if (unreadable.length > 0) {
			details.push(
				`could not read dg hook entries for: ${unreadable.join(", ")}`,
			);
			fixes.push(
				"fix the settings file named by the settings check for that runtime",
			);
		}
		return warn(
			details.join("; "),
			stale.size > 0
				? `${fixes.join("; ")}; then ask the user before enabling them again`
				: fixes.join("; "),
		);
	},
};

const stripSettingCheck: DoctorCheck = {
	id: "strip-ai-coauthors",
	run(ctx) {
		return ok(
			`strip-ai-coauthors is ${describeStripResolution(resolveStripAiCoauthors(ctx.env))}`,
		);
	},
};

export const hooksChecks: DoctorCheck[] = [
	skillFilesCheck(["hooks"]),
	...RUNTIMES.map(settingsCheck),
	staleEntriesCheck,
	hooksAllowRuleCheck,
	stripSettingCheck,
];
