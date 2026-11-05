import { parseArgs } from "node:util";
import {
	PW_EXT_DEFAULT_TIMEOUT_MS,
	type PwExtCliRequest,
	type PwExtCliResult,
	type PwExtRequest,
	type PwExtVerb,
	PW_EXT_READ_VERBS,
	PW_EXT_WRITE_VERBS,
	redactText,
	validatePwExtRequest,
	validatePwExtResponse,
} from "@dg/common";
import { extensionRequiredMessage, isCliOnly } from "../utils/cli-only";
import { publishPrivate } from "./core/files";
import { defaultOutputDir } from "./core/registry";
import { resolveOutput, timestampedName } from "./core/response";
import type { ClientEnv } from "./core/spec";

export type ExtClient = {
	request(
		frame: PwExtCliRequest,
		accept: (value: unknown) => value is PwExtCliResult,
		timeoutMs: number,
	): Promise<PwExtCliResult>;
	close(): void;
};

export type ExtDeps = {
	connect(): Promise<ExtClient>;
	cliOnly(): boolean;
};

const DEFAULT_DEPS: ExtDeps = {
	async connect() {
		const { CliClient, resolveCliSession } = await import("@dg/common/node");
		return (await CliClient.connect(await resolveCliSession())) as ExtClient;
	},
	cliOnly: isCliOnly,
};

const POSITIONALS: Record<PwExtVerb, readonly (keyof PwExtRequest)[]> = {
	current: [],
	snapshot: [],
	screenshot: [],
	selection: [],
	console: [],
	open: ["url"],
	click: ["target"],
	fill: ["target", "value"],
};

export const EXT_HELP = `Usage: dg-skills pw --ext <verb> [args]

Drive your real browser through the paired dg-ai-extension.
The browser asks you to approve every call.

Read verbs (they never change the page):
  current                 active tab URL and title, plus open tabs
  snapshot                accessibility tree with refs, and visible text
  screenshot              visible part of the active tab, saved to scratch
  selection               selected text
  console                 errors since capture started on the tab

Write verbs (each needs its own approval):
  open <url>              open an http(s) URL in a new tab
  click <ref|selector>    click one element
  fill <ref|selector> <text>  set the value of one text field`;

class ExtUsageError extends Error {}

function parseRequest(argv: readonly string[]): PwExtRequest | "help" {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			args: [...argv],
			options: { ext: { type: "boolean" }, help: { type: "boolean" } },
			allowPositionals: true,
			strict: true,
		});
	} catch (error) {
		throw new ExtUsageError(
			`${error instanceof Error ? error.message : String(error)}\npw --ext takes no other flags. Run: dg-skills pw --ext --help`,
		);
	}
	if (parsed.values.help) return "help";
	const [verb, ...rest] = parsed.positionals;
	if (!verb || !Object.hasOwn(POSITIONALS, verb))
		throw new ExtUsageError(
			`Unknown pw --ext verb: ${verb ?? "(none)"}. Use one of: ${[...PW_EXT_READ_VERBS, ...PW_EXT_WRITE_VERBS].join(", ")}.`,
		);
	const names = POSITIONALS[verb as PwExtVerb];
	if (rest.length !== names.length)
		throw new ExtUsageError(
			`pw --ext ${verb} takes ${names.length ? names.map((name) => `<${name}>`).join(" ") : "no arguments"}.`,
		);
	const request: Record<string, string> = { verb };
	names.forEach((name, i) => {
		request[name] = rest[i] as string;
	});
	try {
		return validatePwExtRequest(request);
	} catch (error) {
		throw new ExtUsageError(error instanceof Error ? error.message : String(error));
	}
}

function isResult(requestId: string) {
	return (value: unknown): value is PwExtCliResult => {
		const frame = value as Partial<PwExtCliResult> | null;
		return (
			typeof frame === "object" &&
			frame !== null &&
			frame.type === "cli-pw-ext-result" &&
			frame.requestId === requestId
		);
	};
}

async function saveImage(dataUrl: string): Promise<string> {
	const match = /^data:image\/(jpeg|png);base64,(.*)$/.exec(dataUrl);
	if (!match) throw new Error("Invalid screenshot data.");
	const file = resolveOutput(
		defaultOutputDir(),
		timestampedName("ext-screenshot", match[1] === "png" ? "png" : "jpg"),
	);
	const bytes = Buffer.from(match[2] as string, "base64");
	await publishPrivate(file, (staging) => Bun.write(staging, bytes));
	return file;
}

/** Runs `dg-skills pw --ext <verb>` through the dg-daemon relay to the paired extension. */
export async function runExt(
	argv: readonly string[],
	env: ClientEnv,
	deps: ExtDeps = DEFAULT_DEPS,
): Promise<number> {
	let request: PwExtRequest | "help";
	try {
		request = parseRequest(argv);
	} catch (error) {
		env.err((error as Error).message);
		return 2;
	}
	if (request === "help") {
		env.out(EXT_HELP);
		return 0;
	}
	if (deps.cliOnly()) {
		env.err(extensionRequiredMessage("dg-skills pw --ext"));
		return 1;
	}
	let client: ExtClient;
	try {
		client = await deps.connect();
	} catch (error) {
		env.err(
			`pw --ext needs a dg-daemon session with the paired dg-ai-extension. Run dg-skills doctor pw for the steps. ${redactText(error instanceof Error ? error.message : String(error))}`,
		);
		return 1;
	}
	const requestId = crypto.randomUUID();
	try {
		const reply = await client.request(
			{ type: "cli-pw-ext-request", requestId, request },
			isResult(requestId),
			PW_EXT_DEFAULT_TIMEOUT_MS + 5_000,
		);
		if (!reply.ok) {
			env.err(redactText(reply.error ?? "pw --ext failed in the browser."));
			return 1;
		}
		let data: ReturnType<typeof validatePwExtResponse>;
		try {
			data = validatePwExtResponse(reply.data);
		} catch (error) {
			env.err(
				`Invalid reply from the extension: ${error instanceof Error ? error.message : String(error)}`,
			);
			return 1;
		}
		const lines = [redactText(data.text)];
		if (data.image)
			lines.push(
				"### Result",
				`- [Screenshot of visible tab](${await saveImage(data.image)})`,
			);
		env.out(lines.join("\n"));
		return 0;
	} catch (error) {
		env.err(redactText(error instanceof Error ? error.message : String(error)));
		return 1;
	} finally {
		client.close();
	}
}
