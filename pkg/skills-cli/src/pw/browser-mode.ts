import { DgCliError } from "@dg/common";
import { PW_MODES, type PwMode } from "@dg/common/node";
import { assertBrowserPath } from "../utils/find-browser";
import { optionArgs } from "./core/args";

export type BrowserModeInput = {
	flags: { local?: boolean; ext?: boolean };
	env: Readonly<Record<string, string | undefined>>;
	config: PwMode | undefined;
	extConnected: boolean;
	verb: string | undefined;
	fits?: boolean;
};

export type BrowserModeResult = { mode: "ext" | "local"; reason: string };

export const LOCAL_ONLY_VERBS: ReadonlySet<string> = new Set([
	"route",
	"unroute",
	"route-list",
	"network-state-set",
	"state-save",
	"state-load",
	"delete-data",
	"cookie-set",
	"cookie-delete",
	"cookie-clear",
	"video-start",
	"video-stop",
	"video-chapter",
	"tracing-start",
	"tracing-stop",
	"pdf",
	"install-browser",
	"kill-all",
	"attach",
]);

type ExtCall = { ext: string; args: readonly [min: number, max: number]; flags?: readonly string[] };

const SAME = { args: [0, 0] } as const;
const EXT_CALLS: Readonly<Record<string, ExtCall>> = {
	open: { ext: "open", args: [1, 1] },
	goto: { ext: "open", args: [1, 1] },
	click: { ext: "click", args: [1, 1] },
	fill: { ext: "fill", args: [2, 2] },
	press: { ext: "press", args: [1, 1] },
	snapshot: { ext: "snapshot", ...SAME },
	screenshot: { ext: "screenshot", ...SAME },
	console: { ext: "console", ...SAME },
	network: { ext: "network", ...SAME },
	count: { ext: "count", args: [1, 1] },
	"tab-list": { ext: "tabs", ...SAME },
	"tab-new": { ext: "new", args: [0, 1] },
	"tab-close": { ext: "close", ...SAME },
	"go-back": { ext: "go-back", ...SAME },
	"go-forward": { ext: "go-forward", ...SAME },
	reload: { ext: "reload", ...SAME },
	hover: { ext: "hover", args: [1, 1] },
	dblclick: { ext: "dblclick", args: [1, 1] },
	drag: { ext: "drag", args: [2, 2] },
	mousedown: { ext: "mousedown", args: [0, 1] },
	mouseup: { ext: "mouseup", args: [0, 1] },
	mousemove: { ext: "mousemove", args: [2, 2] },
	mousewheel: { ext: "mousewheel", args: [2, 2] },
	check: { ext: "check", args: [1, 1] },
	uncheck: { ext: "uncheck", args: [1, 1] },
	type: { ext: "type", args: [1, 1], flags: ["--submit"] },
	keydown: { ext: "keydown", args: [1, 1] },
	keyup: { ext: "keyup", args: [1, 1] },
	eval: { ext: "eval", args: [1, 1] },
	resize: { ext: "resize", args: [2, 2] },
	"localstorage-set": { ext: "localstorage-set", args: [2, 2] },
	"localstorage-delete": { ext: "localstorage-delete", args: [1, 1] },
	"localstorage-clear": { ext: "localstorage-clear", ...SAME },
	"sessionstorage-set": { ext: "sessionstorage-set", args: [2, 2] },
	"sessionstorage-delete": { ext: "sessionstorage-delete", args: [1, 1] },
	"sessionstorage-clear": { ext: "sessionstorage-clear", ...SAME },
};

export function isExtCapable(verb: string | undefined): boolean {
	return verb !== undefined && Object.hasOwn(EXT_CALLS, verb);
}

const isOption = (arg: string) => arg.startsWith("-") && !/^-\d/.test(arg);

/** The ext argv for a pw call auto mode may send to the extension; undefined when only local mode runs it as written. */
export function autoExtArgv(argv: readonly string[]): string[] | undefined {
	const [verb, ...rest] = argv;
	if (verb === undefined || !isExtCapable(verb)) return undefined;
	const call = EXT_CALLS[verb] as ExtCall;
	const flags = rest.filter(isOption);
	if (flags.some((flag) => !call.flags?.includes(flag))) return undefined;
	const positionals = rest.length - flags.length;
	if (positionals < call.args[0] || positionals > call.args[1]) return undefined;
	return [call.ext, ...rest];
}

function envMode(value: string | undefined): PwMode | undefined {
	if (value === undefined || value === "") return undefined;
	if (!(PW_MODES as readonly string[]).includes(value))
		throw new DgCliError(
			`dg pw: DG_PW_MODE must be ext, local or auto, got "${value}". Next: fix or unset DG_PW_MODE.`,
		);
	return value as PwMode;
}

/** The mode a flag, DG_PW_MODE or the config forces, with where it came from; undefined means auto. */
export function forcedBrowserMode(
	input: Pick<BrowserModeInput, "flags" | "env" | "config">,
): { mode: "ext" | "local"; reason: string } | undefined {
	if (input.flags.local) return { mode: "local", reason: "--local" };
	if (input.flags.ext) return { mode: "ext", reason: "--ext" };
	assertBrowserPath(input.env);
	const fromEnv = envMode(input.env["DG_PW_MODE"]);
	if (fromEnv && fromEnv !== "auto") return { mode: fromEnv, reason: "DG_PW_MODE" };
	if (input.config && input.config !== "auto") return { mode: input.config, reason: "config" };
	return undefined;
}

export function resolveBrowserMode(input: BrowserModeInput): BrowserModeResult {
	if (input.verb !== undefined && LOCAL_ONLY_VERBS.has(input.verb))
		return { mode: "local", reason: "verb is local-only" };
	const forced = forcedBrowserMode(input);
	if (forced) return forced;
	if (!isExtCapable(input.verb)) return { mode: "local", reason: "auto: verb is not ext-capable" };
	if (input.fits === false) return { mode: "local", reason: "auto: call is not ext-compatible" };
	return input.extConnected
		? { mode: "ext", reason: "auto: extension connected" }
		: { mode: "local", reason: "auto: extension not connected" };
}

export function withoutLocalFlag(argv: readonly string[]): { argv: string[]; local: boolean } {
	const options = optionArgs(argv);
	const rest = argv.slice(options.length);
	const kept = options.filter((arg) => arg !== "--local");
	return { argv: [...kept, ...rest], local: kept.length !== options.length };
}
