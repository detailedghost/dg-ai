import { writeFileSync } from "node:fs";
import { scratchPath } from "@dg/common/node";
import { UsageError } from "../core/args";
import type { ClientEnv } from "../core/spec";
import { EXT_VERBS, type ExtRequest, type ExtTab, type ExtTransport, isExtVerb, isExtWriteVerb } from "./protocol";
import { redactExtOutput } from "./redact";

export { EXT_VERBS };

const BLOCKED_URL_SCHEMES = ["chrome:", "chrome-extension:", "about:", "edge:", "brave:", "devtools:"];

function assertOpenableUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new UsageError(`pw --ext open: not a URL: ${url}`);
	}
	if (BLOCKED_URL_SCHEMES.includes(parsed.protocol)) {
		throw new UsageError(`pw --ext open: refusing to open ${parsed.protocol} pages (browser settings and other extensions are out of bounds)`);
	}
}

function buildRequest(argv: string[]): ExtRequest {
	const verb = argv[0];
	if (!verb || !isExtVerb(verb)) {
		throw new UsageError(`pw --ext: unknown or unsupported verb '${verb ?? ""}'. Use one of: ${EXT_VERBS.join(", ")}`);
	}
	if (verb === "open") {
		const url = argv[1];
		if (!url) throw new UsageError("pw --ext open: provide a URL");
		assertOpenableUrl(url);
		return { verb, url };
	}
	if (verb === "click") {
		const target = argv[1];
		if (!target) throw new UsageError("pw --ext click: provide a target");
		return { verb, target };
	}
	if (verb === "fill") {
		const [target, value] = argv.slice(1);
		if (!target || value === undefined) throw new UsageError("pw --ext fill: provide a target and a value");
		return { verb, target, value, submit: argv.includes("--submit") };
	}
	if (verb === "snapshot") {
		const depthArg = argv.find((arg) => arg.startsWith("--depth="));
		const depth = depthArg ? Number(depthArg.slice("--depth=".length)) : undefined;
		if (depth !== undefined && (!Number.isInteger(depth) || depth < 0)) {
			throw new UsageError("pw --ext snapshot: --depth must be a non-negative integer");
		}
		return { verb, depth };
	}
	return { verb };
}

const describeTab = (tab: ExtTab): string => `"${tab.title}" (${tab.url})`;

function writeScreenshot(dataBase64: string): string {
	const file = scratchPath("pw-ext", `screenshot-${Date.now()}.png`);
	writeFileSync(file, Buffer.from(dataBase64, "base64"), { mode: 0o600 });
	return file;
}

/** The CLI side of `pw --ext`: builds a request, asks the transport, and renders the outcome. */
export async function dispatchExt(argv: string[], env: ClientEnv, transport: ExtTransport): Promise<number> {
	let request: ExtRequest;
	try {
		request = buildRequest(argv);
	} catch (error) {
		if (error instanceof UsageError) {
			env.err(error.message);
			return error.exitCode;
		}
		throw error;
	}

	const outcome = await transport(request);

	if (outcome.status === "blocked") {
		env.err(`pw --ext: blocked (${outcome.reason})`);
		return 1;
	}
	if (outcome.status === "denied") {
		const verbKind = isExtWriteVerb(request.verb) ? "write" : "read";
		env.err(redactExtOutput(`pw --ext: denied for tab ${describeTab(outcome.tab)} (${verbKind} access to ${request.verb})`));
		return 1;
	}

	const { payload, tab } = outcome;
	if (payload.kind === "ack") {
		env.out(redactExtOutput(`### Tab\n${describeTab(tab)}`));
		return 0;
	}
	if (payload.kind === "snapshot") {
		env.out(redactExtOutput(payload.text));
		return 0;
	}
	if (payload.kind === "selection") {
		env.out(redactExtOutput(payload.text));
		return 0;
	}
	if (payload.kind === "console") {
		if (payload.entries.length === 0) {
			env.out("(no console entries)");
			return 0;
		}
		env.out(redactExtOutput(payload.entries.map((entry) => `[${entry.type}] ${entry.text}`).join("\n")));
		return 0;
	}
	if (payload.kind === "screenshot") {
		env.out(`Saved ${writeScreenshot(payload.dataBase64)}`);
		return 0;
	}
	const lines = [`### Current tab\n${describeTab(payload.active)}`, "### Open tabs", ...payload.tabs.map(describeTab)];
	env.out(redactExtOutput(lines.join("\n")));
	return 0;
}
