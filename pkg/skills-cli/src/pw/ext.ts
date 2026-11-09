import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import {
	PW_EXT_DEFAULT_TIMEOUT_MS,
	PW_EXT_MAX_TAB_ID,
	type PwExtCliCancel,
	type PwExtCliRequest,
	type PwExtCliResult,
	type PwExtRequest,
	type PwExtVerb,
	PW_EXT_READ_VERBS,
	PW_EXT_MAX_UPLOAD_BYTES,
	PW_EXT_WRITE_VERBS,
	describeError,
	redactText,
	validatePwExtRequest,
	validatePwExtResponse,
} from "@dg/common";
import {
	CliClient,
	postAsset,
	readAssetSourceFile,
	resolveCliSession,
	scratchRoot,
} from "@dg/common/node";
import { demosDir } from "../demo/paths";
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
	send(frame: PwExtCliCancel): void;
	postAsset(fileName: string, bytes: Buffer): Promise<string>;
	close(): void;
};

export type ExtDeps = {
	connect(sessionId?: string): Promise<ExtClient>;
	cliOnly(): boolean;
	onInterrupt(handler: () => void): () => void;
};

const DEFAULT_DEPS: ExtDeps = {
	async connect(sessionId) {
		const session = await resolveCliSession(sessionId);
		const client = await CliClient.connect(session);
		return {
			request: (frame, accept, timeoutMs) =>
				client.request(frame, accept, timeoutMs),
			send: (frame) => client.send(frame),
			postAsset: (fileName, bytes) => postAsset(session, fileName, bytes),
			close: () => client.close(),
		};
	},
	cliOnly: isCliOnly,
	onInterrupt(handler) {
		process.once("SIGINT", handler);
		process.once("SIGTERM", handler);
		return () => {
			process.off("SIGINT", handler);
			process.off("SIGTERM", handler);
		};
	},
};

type StagedFile = {
	bytes: Buffer;
	fileName: string;
	fileType: string;
	filePath: string;
};

function within(root: string, target: string): boolean {
	const path = relative(root, target);
	return path !== "" && !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
}

function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function stageFile(file: string, cwd: string): StagedFile {
	const path = resolve(cwd, file);
	let info: ReturnType<typeof lstatSync>;
	try {
		info = lstatSync(path);
	} catch {
		throw new ExtUsageError(`No such file: ${file}`);
	}
	if (info.isSymbolicLink())
		throw new ExtUsageError(`pw --ext upload refuses a symbolic link: ${file}`);
	if (!info.isFile())
		throw new ExtUsageError(`pw --ext upload needs a regular file: ${file}`);
	if (info.size > PW_EXT_MAX_UPLOAD_BYTES)
		throw new ExtUsageError(
			`pw --ext upload takes files up to ${PW_EXT_MAX_UPLOAD_BYTES} bytes.`,
		);
	const real = realpathSync(path);
	const homes = new Set(
		[homedir(), process.env["HOME"] ?? "", "/"].flatMap((dir) => {
			try {
				return dir ? [realpathSync(dir)] : [];
			} catch {
				return [];
			}
		}),
	);
	const roots = [cwd, scratchRoot(), demosDir()].flatMap((root) => {
		try {
			const resolved = realpathSync(root);
			return homes.has(resolved) ? [] : [resolved];
		} catch {
			return [];
		}
	});
	const root = roots.find((candidate) => within(candidate, real));
	const trusted = [scratchRoot(), demosDir()].map(realpathOrSelf);
	if (
		root &&
		realpathOrSelf(cwd) === root &&
		!trusted.includes(root) &&
		root.split(sep).some((part) => part.startsWith("."))
	)
		throw new ExtUsageError(
			"pw --ext upload refuses a working directory inside a hidden folder.",
		);
	if (root && relative(root, real).split(sep).some((part) => part.startsWith(".")))
		throw new ExtUsageError(
			"pw --ext upload refuses hidden files and files in hidden folders.",
		);
	if (!root)
		throw new ExtUsageError(
			"pw --ext upload takes files only from the working directory, the dg scratch directory or the dg demos directory.",
		);
	let bytes: Buffer;
	try {
		const checked = lstatSync(real);
		bytes = readAssetSourceFile(real, {
			noFollow: true,
			maxBytes: PW_EXT_MAX_UPLOAD_BYTES,
			expect: { dev: Number(info.dev), ino: Number(info.ino) },
		});
		if (Number(checked.ino) !== Number(info.ino))
			throw new Error("the file changed while it was being checked");
	} catch (error) {
		throw new ExtUsageError(
			`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const type = (Bun.file(real).type || "application/octet-stream").split(";")[0] as string;
	const home = homedir();
	return {
		bytes,
		fileName: basename(real),
		fileType: type,
		filePath: home && real.startsWith(`${home}${sep}`) ? `~${real.slice(home.length)}` : real,
	};
}

const POSITIONALS: Record<PwExtVerb, readonly string[]> = {
	current: [],
	snapshot: [],
	screenshot: [],
	selection: [],
	console: [],
	tabs: [],
	open: ["url"],
	new: ["url?"],
	select: ["tabId"],
	close: ["tabId?"],
	click: ["target"],
	count: ["target"],
	fill: ["target", "value"],
	upload: ["target", "file"],
	tools: [],
	call: ["tool", "json-args"],
};
const OPTIONS = {
	ext: { type: "boolean" },
	help: { type: "boolean" },
	tab: { type: "string" },
	session: { type: "string" },
} as const;
const STAGED_PLACEHOLDER = "00000000-0000-4000-8000-000000000000";

export const EXT_HELP = `Usage: dg-skills pw --ext [--session <id>] [--tab <id>] <verb> [args]

Drive your real browser through the paired dg-ai-extension.
Passing --ext gives the CLI control of the tabs in the agent's own tab group. The browser asks for no approval per call.
Every verb acts on the agent's selected tab. --tab <id> targets one tab of the group once, without changing the selection.

Session: each dg session has its own tab group. The CLI picks the session from --session <id>,
then the DG_SESSION_ID environment variable, then the one session registered for the working directory.
Under --ext, --session takes a dg session id, not a pw browser session name.

Read verbs (they never change the page):
  current                 the agent's selected tab URL and title
  tabs                    tabs in the agent's group, the selected one marked
  snapshot                accessibility tree with refs, and visible text
  screenshot              visible part of the agent's selected tab, saved to scratch; brings the tab to the front
  selection               selected text
  console                 errors and console warnings since the first call
  count <ref|selector>    how many elements match, with tag, type, id and name for each; use it to test a selector before click, fill or upload
  tools                   WebMCP tools the page exposes

Write verbs (they change the page):
  open <url>              open an http(s) URL in the agent's selected tab, or in a new tab when it has none
  new [url]               open a new tab in the agent's group and select it
  select <tabId>          make a tab of the group the agent's selected tab
  close [tabId]           close a tab of the group (the agent's selected tab by default)
  click <ref|selector>    click one element
  fill <ref|selector> <text>  set the value of one text field
  upload <ref|selector> <file>  set one file on a file input (https pages only)
  call <tool> <json-args> run one WebMCP tool of the page`;

class ExtUsageError extends Error {}

const UNSUPPORTED = "Unsupported pw --ext request.";

type Parsed = { request: PwExtRequest; staged?: StagedFile; session?: string };

function readArgs(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		options: OPTIONS,
		allowPositionals: true,
		strict: true,
	});
}

function tabIdOf(text: string, usage: string): number {
	if (!/^\d+$/.test(text) || Number(text) > PW_EXT_MAX_TAB_ID)
		throw new ExtUsageError(usage);
	return Number(text);
}

function positionalLabel(name: string): string {
	return name.endsWith("?") ? `[<${name.slice(0, -1)}>]` : `<${name}>`;
}

function parseRequest(argv: readonly string[], cwd: string): Parsed | "help" {
	let parsed: ReturnType<typeof readArgs>;
	try {
		parsed = readArgs(argv);
	} catch (error) {
		throw new ExtUsageError(
			`${describeError(error)}\nRun: dg-skills pw --ext --help`,
		);
	}
	if (parsed.values.help) return "help";
	const [verb, ...rest] = parsed.positionals;
	if (!verb || !Object.hasOwn(POSITIONALS, verb))
		throw new ExtUsageError(
			`Unknown pw --ext verb: ${verb ?? "(none)"}. Use one of: ${[...PW_EXT_READ_VERBS, ...PW_EXT_WRITE_VERBS].join(", ")}.`,
		);
	const names = POSITIONALS[verb as PwExtVerb];
	const tab =
		parsed.values.tab === undefined
			? undefined
			: tabIdOf(parsed.values.tab, "pw --ext --tab takes a tab id from pw --ext tabs.");
	if (tab !== undefined && verb === "select")
		throw new ExtUsageError("pw --ext select takes a tab id, not --tab.");
	const required = names.filter((name) => !name.endsWith("?")).length;
	if (rest.length < required || rest.length > names.length)
		throw new ExtUsageError(
			`pw --ext ${verb} takes ${names.length ? names.map(positionalLabel).join(" ") : "no arguments"}.`,
		);
	if (tab !== undefined && (verb === "tabs" || verb === "new"))
		throw new ExtUsageError(`pw --ext ${verb} does not take --tab.`);
	if (tab !== undefined && verb === "close" && rest.length)
		throw new ExtUsageError("pw --ext close takes a tab id or --tab, not both.");
	const request: Record<string, unknown> = { verb };
	let staged: StagedFile | undefined;
	if (verb === "upload") {
		staged = stageFile(rest[1] as string, cwd);
		Object.assign(request, {
			target: rest[0],
			assetId: STAGED_PLACEHOLDER,
			fileName: staged.fileName,
			fileSize: staged.bytes.length,
			fileType: staged.fileType,
			filePath: staged.filePath,
		});
	} else if (verb === "call") {
		let args: unknown;
		try {
			args = JSON.parse(rest[1] as string);
		} catch {
			throw new ExtUsageError("pw --ext call needs <json-args> as a JSON object.");
		}
		if (typeof args !== "object" || args === null || Array.isArray(args))
			throw new ExtUsageError("pw --ext call needs <json-args> as a JSON object.");
		Object.assign(request, { tool: rest[0], args });
	} else
		names.forEach((name, i) => {
			const key = name.replace(/\?$/, "");
			const value = rest[i];
			if (value === undefined) return;
			request[key] =
				key === "tabId"
					? tabIdOf(value, `pw --ext ${verb} takes a tab id from pw --ext tabs.`)
					: value;
		});
	if (tab !== undefined) request.tabId = tab;
	try {
		return {
			request: validatePwExtRequest(request),
			...(staged ? { staged } : {}),
			...(parsed.values.session === undefined ? {} : { session: parsed.values.session }),
		};
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
	let parsed: Parsed | "help";
	try {
		parsed = parseRequest(argv, env.cwd);
	} catch (error) {
		env.err((error as Error).message);
		return 2;
	}
	if (parsed === "help") {
		env.out(EXT_HELP);
		return 0;
	}
	if (deps.cliOnly()) {
		env.err(extensionRequiredMessage("dg-skills pw --ext"));
		return 1;
	}
	let client: ExtClient;
	try {
		client = await deps.connect(parsed.session);
	} catch (error) {
		env.err(
			`pw --ext needs a dg-daemon session with the paired dg-ai-extension. Run dg-skills doctor pw for the steps. ${redactText(error instanceof Error ? error.message : String(error))}`,
		);
		return 1;
	}
	const requestId = crypto.randomUUID();
	let interrupted = false;
	const stopListening = deps.onInterrupt(() => {
		interrupted = true;
		try {
			client.send({ type: "cli-pw-ext-cancel", requestId });
		} finally {
			client.close();
		}
	});
	try {
		let request = parsed.request;
		if (parsed.staged) {
			const assetId = await client.postAsset(
				parsed.staged.fileName,
				parsed.staged.bytes,
			);
			request = validatePwExtRequest({ ...request, assetId });
		}
		const reply = await client.request(
			{ type: "cli-pw-ext-request", requestId, request },
			isResult(requestId),
			PW_EXT_DEFAULT_TIMEOUT_MS + 5_000,
		);
		if (!reply.ok) {
			const error = reply.error ?? "pw --ext failed in the browser.";
			env.err(
				redactText(
					error === UNSUPPORTED
						? `${error} The extension may be older than this CLI: update the dg-ai-extension and reload it.`
						: error,
				),
			);
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
		if (interrupted) {
			env.err("pw --ext canceled; the extension was told to cancel it.");
			return 130;
		}
		env.err(redactText(error instanceof Error ? error.message : String(error)));
		return 1;
	} finally {
		stopListening();
		client.close();
	}
}
