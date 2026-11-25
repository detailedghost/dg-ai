import { DgCliError } from "@dg/common";
import { BROWSER_MODES, type BrowserMode } from "@dg/common/node";
import { optionArgs } from "./core/args";

export type BrowserModeInput = {
	flags: { local?: boolean; ext?: boolean };
	env: Readonly<Record<string, string | undefined>>;
	config: BrowserMode | undefined;
	extConnected: boolean;
	verb: string | undefined;
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

const EXT_CAPABLE_VERBS: ReadonlySet<string> = new Set([
	"open",
	"click",
	"fill",
	"press",
	"select",
	"upload",
	"close",
	"snapshot",
	"screenshot",
	"console",
	"network",
	"count",
]);

export function isExtCapable(verb: string | undefined): boolean {
	return verb !== undefined && EXT_CAPABLE_VERBS.has(verb);
}

function envMode(value: string | undefined): BrowserMode | undefined {
	if (value === undefined || value === "") return undefined;
	if (!(BROWSER_MODES as readonly string[]).includes(value))
		throw new DgCliError(
			`dg pw: DG_BROWSER must be ext, local or auto, got "${value}". Next: fix or unset DG_BROWSER.`,
		);
	return value as BrowserMode;
}

/** The mode a flag, DG_BROWSER or the config forces, with where it came from; undefined means auto. */
export function forcedBrowserMode(
	input: Pick<BrowserModeInput, "flags" | "env" | "config">,
): { mode: "ext" | "local"; reason: string } | undefined {
	if (input.flags.local) return { mode: "local", reason: "--local" };
	if (input.flags.ext) return { mode: "ext", reason: "--ext" };
	const fromEnv = envMode(input.env["DG_BROWSER"]);
	if (fromEnv && fromEnv !== "auto") return { mode: fromEnv, reason: "DG_BROWSER" };
	if (input.config && input.config !== "auto") return { mode: input.config, reason: "config" };
	return undefined;
}

export function resolveBrowserMode(input: BrowserModeInput): BrowserModeResult {
	if (input.verb !== undefined && LOCAL_ONLY_VERBS.has(input.verb))
		return { mode: "local", reason: "verb is local-only" };
	const forced = forcedBrowserMode(input);
	if (forced) return forced;
	if (!isExtCapable(input.verb)) return { mode: "local", reason: "auto: verb is not ext-capable" };
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
