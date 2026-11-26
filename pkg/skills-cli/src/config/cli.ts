import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DgCliError } from "@dg/common";
import {
	DG_TOML_DEFAULTS,
	dgTomlValue,
	isRecord,
	isSecretRef,
	parseDgToml,
	readDgToml,
	readLegacyConfig,
	resolveDgPaths,
	stringifyDgToml,
	writeDgToml,
	writeFilePreserving,
} from "@dg/common/node";
import type { Command } from "commander";
import { HOOKS } from "../hooks/manifest";
import { runSubtree } from "../utils/lazy-command";

const SEND_SWITCHES: ReadonlySet<string> = new Set(["ssms.allow_send", "ssms.google.send_enabled"]);

type Known = { fallback?: unknown; text: boolean };

function knownKey(key: string): Known | undefined {
	const parts = key.split(".");
	const [section, name = "", field = "", rest] = parts;
	if (Object.hasOwn(DG_TOML_DEFAULTS, key)) return { fallback: DG_TOML_DEFAULTS[key], text: false };
	if (section === "hooks" && parts.length === 3) {
		const spec = HOOKS.find((hook) => hook.id === name)?.settings?.[field];
		return spec ? { fallback: spec.default, text: true } : undefined;
	}
	if (key === "refs.default_repo" || (section === "refs" && name === "aliases" && parts.length === 3)) return { text: true };
	if ((section === "inbox" || section === "ssms") && parts.length >= 2) return { text: false };
	if (section === "plugins" && parts.length === 3 && field === "enabled") return { fallback: true, text: false };
	if (section === "plugins" && parts.length === 3 && field === "fail_closed") return { fallback: false, text: false };
	if (section === "plugins" && parts.length === 3 && field === "source") return { text: true };
	if (section === "plugins" && field === "settings" && rest !== undefined) return { text: false };
	return undefined;
}

function mustKnow(key: string): Known {
	const known = knownKey(key);
	if (!known)
		throw new DgCliError(`dg config: ${key} is not a dg config key. Next: see docs/config.md for the keys, or run dg config edit.`);
	return known;
}

function shown(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	if (isSecretRef(value)) return `{ credential = "${value.credential}" }`;
	if (isRecord(value)) return stringifyDgToml(value).trimEnd();
	return JSON.stringify(value);
}

function typed(raw: string, known: Known): unknown {
	if (known.text) return raw;
	try {
		return (Bun.TOML.parse(`v = ${raw}`) as { v: unknown }).v;
	} catch {
		return raw;
	}
}

function get(key: string): void {
	const known = mustKnow(key);
	const value = dgTomlValue(readDgToml(), key);
	process.stdout.write(`${shown(value ?? known.fallback)}\n`);
}

function set(key: string, value: string | undefined, credential: string | undefined): void {
	const known = mustKnow(key);
	if ([...SEND_SWITCHES].some((name) => name === key || name.startsWith(`${key}.`)))
		throw new DgCliError(`dg config: ${key} turns sending on, so dg config set does not change it. Next: run dg config edit.`);
	if (credential !== undefined && value !== undefined)
		throw new DgCliError("dg config: pass a value or --credential <name>, not both.");
	if (credential === undefined && value === undefined)
		throw new DgCliError(`dg config: set needs a value. Next: run dg config set ${key} <value>.`);
	writeDgToml(key, credential === undefined ? typed(value as string, known) : { credential });
}

function editorCommand(draft: string): string[] {
	const editor = process.env.VISUAL || process.env.EDITOR;
	if (!editor) throw new DgCliError("dg config: no editor is set. Next: set EDITOR, or use dg config set <key> <value>.");
	if (process.platform === "win32") return [...editor.split(/\s+/).filter(Boolean), draft];
	return ["/bin/sh", "-c", `${editor} "$1"`, "dg-config-edit", draft];
}

function edit(): void {
	const paths = resolveDgPaths();
	const file = paths.configTomlPath;
	const exists = existsSync(file);
	if (!exists && readLegacyConfig(paths).sources.length)
		throw new DgCliError(
			`dg config: ${file} does not exist yet, and older config files still wait to move into it. Next: start the daemon with dg daemon start if it is stopped, run dg doctor so the move runs, then run this again.`,
		);
	const before = exists ? readFileSync(file, "utf8") : "";
	mkdirSync(dirname(file), { recursive: true });
	const draft = `${file}.${process.pid}.edit.toml`;
	const command = editorCommand(draft);
	writeFileSync(draft, before, { mode: 0o600 });
	try {
		const run = Bun.spawnSync(command, { stdio: ["inherit", "inherit", "inherit"] });
		if (run.exitCode !== 0)
			throw new DgCliError(`dg config: the editor exited with ${run.exitCode}; ${file} is unchanged. Next: run dg config edit again.`);
		const after = readFileSync(draft, "utf8");
		if (after === before) return;
		parseDgToml(after, file);
		if ((existsSync(file) ? readFileSync(file, "utf8") : "") !== before)
			throw new DgCliError(`dg config: ${file} changed while you edited it, so your edit was not saved. Next: run dg config edit again.`);
		writeFilePreserving(file, after, 0o600);
	} finally {
		rmSync(draft, { force: true });
	}
}

const FRONT_DOOR_HINT =
	"Next: unset DG_FRONT, set front.enabled = true in config.toml, or run dg install to restore the front door.";

function needsFrontDoor(sub: string): () => never {
	return () => {
		throw new DgCliError(`dg config ${sub} needs the C# front door, and the Bun program does not run it. ${FRONT_DOOR_HINT}`);
	};
}

export function registerConfig(program: Command): void {
	const config = program.command("config").description("Read and change dg settings in config.toml");
	config
		.command("path")
		.description("print the path of config.toml")
		.action(() => {
			process.stdout.write(`${resolveDgPaths().configTomlPath}\n`);
		});
	config
		.command("get")
		.description("print a setting, or its default when unset")
		.argument("<key>", "dotted key, such as install.cli_only")
		.action(get);
	config
		.command("set")
		.description("change one setting; a secret field takes --credential <name>")
		.argument("<key>", "dotted key, such as refs.aliases.app")
		.argument("[value]", "the new value")
		.option("--credential <name>", "point a secret field at a dg credentials entry")
		.action((key: string, value: string | undefined, options: { credential?: string }) => set(key, value, options.credential));
	config.command("list").description("print every setting (needs the C# front door)").action(needsFrontDoor("list"));
	config.command("doctor").description("check config.toml (needs the C# front door)").action(needsFrontDoor("doctor"));
	config
		.command("edit")
		.description("open config.toml in $EDITOR; an edit that does not validate is not saved")
		.action(edit);
}

export function main(argv: string[]): Promise<void> {
	return runSubtree("config", registerConfig, argv);
}
