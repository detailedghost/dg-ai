export const DEFAULT_TIMEOUT_SEC = 900;
export const DEFAULT_PORT = 4321;

export interface Flags {
	light: boolean;
	json: boolean;
	series: boolean;
	noOpen: boolean;
	requirePending: boolean;
	selftest: boolean;
	chain?: string;
	port: number;
	timeoutSec: number;
	notes: string;
	source: string;
	rest: string[];
}

function integer(arg: string, prefix: string): number {
	const value = Number.parseInt(arg.slice(prefix.length), 10);
	if (Number.isNaN(value) || value < 0)
		throw new Error(`invalid value: ${arg}`);
	return value;
}

/** Parse the `--flag` and `--flag=value` forms; any other option is an error and `-` stays positional. */
export function parseFlags(argv: string[], allowed: readonly string[]): Flags {
	const flags: Flags = {
		light: false,
		json: false,
		series: false,
		noOpen: process.env.PROTOTYPE_UI_NO_OPEN === "1",
		requirePending: false,
		selftest: false,
		port: DEFAULT_PORT,
		timeoutSec: DEFAULT_TIMEOUT_SEC,
		notes: "",
		source: "cli",
		rest: [],
	};
	for (const arg of argv) {
		const name = arg.startsWith("--") ? (arg.split("=")[0] as string) : "";
		if (name && !allowed.includes(name))
			throw new Error(`Unknown option: ${arg}`);
		if (arg === "--light") flags.light = true;
		else if (arg === "--json") flags.json = true;
		else if (arg === "--series") flags.series = true;
		else if (arg === "--no-open") flags.noOpen = true;
		else if (arg === "--require-pending") flags.requirePending = true;
		else if (arg === "--selftest") flags.selftest = true;
		else if (arg.startsWith("--chain="))
			flags.chain = arg.slice("--chain=".length).trim() || undefined;
		else if (arg.startsWith("--port=")) flags.port = integer(arg, "--port=");
		else if (arg.startsWith("--timeout="))
			flags.timeoutSec = integer(arg, "--timeout=");
		else if (arg.startsWith("--notes="))
			flags.notes = arg.slice("--notes=".length);
		else if (arg.startsWith("--source="))
			flags.source = arg.slice("--source=".length).trim() || "cli";
		else flags.rest.push(arg);
	}
	return flags;
}
