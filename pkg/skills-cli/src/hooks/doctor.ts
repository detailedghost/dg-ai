import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, win32 } from "node:path";
import { skillFilesCheck } from "../doctor/checks";
import { CLI_PATH, readAllowRules, whichBinary } from "../doctor/probes";
import {
	type DoctorCheck,
	type DoctorContext,
	ok,
	warn,
} from "../doctor/types";
import { claudeWriter } from "./settings/claude";
import { codexWriter } from "./settings/codex";
import { type JsonObject, readJsonObject } from "./settings/json-file";
import { ownedId, ownedLauncher } from "./settings/marker";
import { opencodeWriter } from "./settings/opencode";
import type { HookRuntime, SettingsWriter } from "./types";

const RUNTIMES: readonly HookRuntime[] = ["claude", "codex", "opencode"];
const LIST_LINE = /^const HOOKS = (.*);$/m;

interface OwnedEntry {
	id: string;
	launcher: string;
}

function writerFor(runtime: HookRuntime, ctx: DoctorContext): SettingsWriter {
	if (runtime === "claude") return claudeWriter(ctx.home);
	if (runtime === "codex") return codexWriter(ctx.home);
	return opencodeWriter(ctx.home, "dg-skills", ctx.env.XDG_CONFIG_HOME);
}

function commandsIn(doc: JsonObject): string[] {
	const hooks = doc.hooks;
	if (typeof hooks !== "object" || hooks === null) return [];
	return Object.values(hooks).flatMap((groups) =>
		(Array.isArray(groups) ? groups : []).flatMap((group) =>
			Array.isArray(group?.hooks)
				? group.hooks.flatMap((h: { command?: unknown }) =>
						typeof h?.command === "string" ? [h.command] : [],
					)
				: [],
		),
	);
}

function ownedEntries(
	runtime: HookRuntime,
	writer: SettingsWriter,
): OwnedEntry[] {
	if (!existsSync(writer.file)) return [];
	if (runtime === "opencode") {
		const list = LIST_LINE.exec(readFileSync(writer.file, "utf8"))?.[1];
		const hooks = list
			? (JSON.parse(list) as { id: string; argv: string[] }[])
			: [];
		return hooks.map((h) => ({ id: h.id, launcher: h.argv[0] ?? "" }));
	}
	return commandsIn(readJsonObject(writer.file)).flatMap((command) => {
		const id = ownedId(command);
		const launcher = ownedLauncher(command);
		return id && launcher ? [{ id, launcher }] : [];
	});
}

function resolves(launcher: string, ctx: DoctorContext): boolean {
	return isAbsolute(launcher) || win32.isAbsolute(launcher)
		? existsSync(launcher)
		: whichBinary(launcher, ctx.env) !== null;
}

/** Allow rules for the hooks commands that never enable a hook. */
export const HOOKS_ALLOW_RULES: readonly string[] = ["status", "list", "disable"].map(
	(sub) => `Bash(${CLI_PATH} hooks ${sub}:*)`,
);

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
			return ok(`allow rules present for ${CLI_PATH} hooks status, list and disable`);
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
			return ok("every dg hook entry resolves to dg-skills");
		const details: string[] = [];
		const fixes: string[] = [];
		if (stale.size > 0) {
			const summary = [...stale]
				.map(([runtime, ids]) => `${runtime}:${ids.join(",")}`)
				.join(" ");
			details.push(`dg hook entries point at a missing dg-skills: ${summary}`);
			fixes.push(
				...[...stale].map(
					([runtime, ids]) =>
						`~/.dg/bin/dg-skills hooks disable ${ids.join(" ")} --runtime ${runtime}`,
				),
			);
		}
		if (unreadable.length > 0) {
			details.push(`could not read dg hook entries for: ${unreadable.join(", ")}`);
			fixes.push("fix the settings file named by the settings check for that runtime");
		}
		return warn(
			details.join("; "),
			stale.size > 0
				? `${fixes.join("; ")}; then ask the user before enabling them again`
				: fixes.join("; "),
		);
	},
};

export const hooksChecks: DoctorCheck[] = [
	skillFilesCheck(["hooks"]),
	...RUNTIMES.map(settingsCheck),
	staleEntriesCheck,
	hooksAllowRuleCheck,
];
