import { lstatSync, readFileSync, realpathSync } from "node:fs";
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
	PW_EXT_NETWORK_MAX_LIMIT,
	PW_EXT_UNMASK_DEFAULT_MINUTES,
	PW_EXT_UNMASK_MAX_MINUTES,
	PW_EXT_WRITE_VERBS,
	describeError,
	isPwExtCliResult,
	isPwExtSecretTooShort,
	PW_EXT_MIN_SECRET_CHARS,
	redactLiterals,
	redactSecrets,
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
	/** Where `fill --value-env` and `--value-stdin` read a secret. */
	env?: Readonly<Record<string, string | undefined>>;
	readStdin?: () => string;
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
	unmask: [],
	tools: [],
	call: ["tool", "json-args"],
	dialog: ["answer?"],
	network: [],
	storage: ["area?"],
	fetch: ["url"],
	credential: ["action", "name"],
};
const OPTIONS = {
	ext: { type: "boolean" },
	help: { type: "boolean" },
	tab: { type: "string" },
	session: { type: "string" },
	minutes: { type: "string" },
	off: { type: "boolean" },
	"value-env": { type: "string" },
	"value-stdin": { type: "boolean" },
	text: { type: "string" },
	filter: { type: "string" },
	limit: { type: "string" },
	since: { type: "string" },
	values: { type: "boolean" },
	method: { type: "string" },
	json: { type: "string" },
	"body-stdin": { type: "boolean" },
	header: { type: "string", multiple: true },
	auth: { type: "string" },
	key: { type: "string" },
	keys: { type: "boolean" },
	from: { type: "string" },
	path: { type: "string" },
} as const;
const STAGED_PLACEHOLDER = "00000000-0000-4000-8000-000000000000";

export const EXT_HELP = `Usage: dg-skills pw --ext [--session <id>] [--tab <id>] <verb> [args]

Drive your real browser through the paired dg-ai-extension.
Passing --ext gives the CLI control of the tabs in the agent's own tab group.
The browser asks the user once per site in each session, on the first verb there (open and new too).
tools and call are the Web MCP bridge: they skip that site question and use Web MCP approvals instead.
An "Agent is driving" banner on each agent tab has a Stop button. Stop ends the session's control: every later verb fails until a new dg session starts.
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
  tools                   Web MCP bridge: WebMCP tools the page exposes
  network [--filter <text>] [--limit N] [--since <ms>|clear] [--values]
                          fetch and XMLHttpRequest calls of the page since it loaded in the agent tab, newest last:
                          method, address with query values removed, status, header names, and the key
                          structure and value types of JSON bodies, never values. --filter keeps calls whose
                          shown address holds the text, --limit keeps the newest N (default 50, up to ${PW_EXT_NETWORK_MAX_LIMIT}),
                          --since <ms> keeps calls that started after that time, --since clear empties the list.
                          --values shows values too, after the user clicks Allow once in the browser for this site
                          and session; passwords, cookies, sign-in headers and secrets stay masked
  storage [local|session] [--keys] [--key <k>] [--values]
                          keys of the page's localStorage (default) or sessionStorage, with type, length and
                          JSON key structure; --keys lists keys only, --key shows one key; --values shows values
                          after the same Allow; tokens and secrets stay masked

Write verbs (they change the page):
  open <url>              open an http(s) URL in the agent's selected tab, or in a new tab when it has none
  new [url]               open a new tab in the agent's group and select it
  select <tabId>          make a tab of the group the agent's selected tab
  close [tabId]           close a tab of the group (the agent's selected tab by default)
  click <ref|selector>    click one element
  fill <ref|selector> <text>  set one text, date or time field (YYYY-MM-DD, HH:MM), or pick a select option by value or label
  fill <ref|selector> --value-env NAME | --value-stdin
                          set a password or secret field during an unmask; the value never goes in argv or output
  upload <ref|selector> <file>  set one file on a file input (https pages only)
  call <tool> <json-args> Web MCP bridge: run one WebMCP tool of the page; it asks a Web MCP approval
                          (not the pw --ext site allowlist) unless the tool reads only or a grant holds
  unmask [--minutes N]    ask the user, in the browser, to show email addresses and allow secret fill
                          on this tab's site for N minutes (1-${PW_EXT_UNMASK_MAX_MINUTES}, default ${PW_EXT_UNMASK_DEFAULT_MINUTES})
  unmask --off            end the unmask now
  dialog                  the page's last alert, confirm or prompt, how it was answered, and the answer set for the next one
  dialog accept [--text <answer>]  accept the next dialog on this page; --text is the answer a prompt gets
  dialog dismiss          dismiss the next dialog on this page; each new page starts at dismiss
  fetch <path|url> [--method M] [--json <body>|--body-stdin] [--header Name:Value]... [--auth page] [--values]
                          send one request from the agent tab to its own origin, with the page's cookies;
                          --auth page adds the page's own sign-in headers, which you never see; output has
                          the shape of the response, values only with --values. A method other than GET or
                          HEAD, --auth page and --values need the user's one Allow for this site and session
  credential save <name> --from cookie:<n>|header:<n>|local:<k>|session:<k> [--path a.b]
                          copy a sign-in value of this site straight into the dg credential store as
                          pw/<site>/<name>, after the same Allow; the value is never shown. --path picks a value
                          inside a JSON value. Use it with dg-skills credentials exec`;

class ExtUsageError extends Error {}

type Parsed = {
	request: PwExtRequest;
	staged?: StagedFile;
	session?: string;
	secret?: string;
};

type SecretSource = Pick<ExtDeps, "env" | "readStdin">;

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

function readSecret(
	values: { "value-env"?: string; "value-stdin"?: boolean },
	source: SecretSource,
): string {
	const name = values["value-env"];
	if (name !== undefined && values["value-stdin"])
		throw new ExtUsageError("pw --ext fill takes --value-env or --value-stdin, not both.");
	const raw =
		name !== undefined
			? (source.env ?? process.env)[name]
			: (source.readStdin ?? (() => readFileSync(0, "utf8")))().replace(/\r?\n$/, "");
	if (!raw)
		throw new ExtUsageError(
			name !== undefined
				? `pw --ext fill --value-env ${name}: the environment variable is not set or is empty.`
				: "pw --ext fill --value-stdin: stdin is empty.",
		);
	if (isPwExtSecretTooShort(raw))
		throw new ExtUsageError(`pw --ext fill: the secret value must be at least ${PW_EXT_MIN_SECRET_CHARS} characters.`);
	return raw;
}

function parseRequest(
	argv: readonly string[],
	cwd: string,
	source: SecretSource = {},
): Parsed | "help" {
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
	const secretFill =
		parsed.values["value-env"] !== undefined || parsed.values["value-stdin"] === true;
	if (secretFill && verb !== "fill")
		throw new ExtUsageError("--value-env and --value-stdin work only with pw --ext fill.");
	if ((parsed.values.minutes !== undefined || parsed.values.off) && verb !== "unmask")
		throw new ExtUsageError("--minutes and --off work only with pw --ext unmask.");
	if (parsed.values.text !== undefined && (verb !== "dialog" || rest[0] !== "accept"))
		throw new ExtUsageError("--text works only with pw --ext dialog accept.");
	const networkOption =
		parsed.values.filter !== undefined || parsed.values.limit !== undefined || parsed.values.since !== undefined;
	if (networkOption && verb !== "network")
		throw new ExtUsageError("--filter, --limit and --since work only with pw --ext network.");
	if (parsed.values.values && !["network", "storage", "fetch"].includes(verb))
		throw new ExtUsageError("--values works only with pw --ext network, storage or fetch.");
	const only = (names: (keyof typeof parsed.values)[], verbs: string[], label: string) => {
		if (names.some((name) => parsed.values[name] !== undefined) && !verbs.includes(verb))
			throw new ExtUsageError(`${label} work${names.length === 1 ? "s" : ""} only with pw --ext ${verbs.join(" or ")}.`);
	};
	only(["method", "json", "body-stdin", "header", "auth"], ["fetch"], "--method, --json, --body-stdin, --header and --auth");
	only(["from", "path"], ["credential"], "--from and --path");
	only(["key", "keys"], ["storage"], "--key and --keys");
	if (verb === "dialog" && rest.length === 1 && rest[0] !== "accept" && rest[0] !== "dismiss")
		throw new ExtUsageError("pw --ext dialog takes accept or dismiss.");
	if (parsed.values.off && parsed.values.minutes !== undefined)
		throw new ExtUsageError("pw --ext unmask takes --minutes or --off, not both.");
	if (secretFill && rest.length !== 1)
		throw new ExtUsageError(
			"pw --ext fill takes a secret only from --value-env or --value-stdin, never as an argument.",
		);
	const names = secretFill ? ["target"] : POSITIONALS[verb as PwExtVerb];
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
	} else if (verb === "storage") {
		if (rest[0] !== undefined && rest[0] !== "local" && rest[0] !== "session")
			throw new ExtUsageError("pw --ext storage takes local or session.");
		Object.assign(request, {
			...(rest[0] === undefined ? {} : { area: rest[0] }),
			...(parsed.values.key === undefined ? {} : { key: parsed.values.key }),
			...(parsed.values.keys ? { keysOnly: true } : {}),
			...(parsed.values.values ? { values: true } : {}),
		});
	} else if (verb === "fetch") {
		Object.assign(request, fetchOptions(rest[0] as string, parsed.values, source));
	} else if (verb === "credential") {
		if (rest[0] !== "save") throw new ExtUsageError("pw --ext credential takes save <name> --from <source>:<key>.");
		const from = /^(cookie|header|local|session):(.+)$/.exec(parsed.values.from ?? "");
		if (!from)
			throw new ExtUsageError("pw --ext credential save needs --from cookie:<name>, header:<name>, local:<key> or session:<key>.");
		Object.assign(request, {
			name: rest[1],
			source: from[1],
			key: from[2],
			...(parsed.values.path === undefined ? {} : { path: parsed.values.path }),
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
	let secret: string | undefined;
	if (secretFill) {
		secret = readSecret(parsed.values, source);
		Object.assign(request, { value: secret, secret: true });
	}
	if (verb === "unmask") {
		if (parsed.values.off) request.off = true;
		else {
			const text = parsed.values.minutes ?? String(PW_EXT_UNMASK_DEFAULT_MINUTES);
			const minutes = Number(text);
			if (!/^\d+$/.test(text) || minutes < 1 || minutes > PW_EXT_UNMASK_MAX_MINUTES)
				throw new ExtUsageError(
					`pw --ext unmask --minutes takes a whole number from 1 to ${PW_EXT_UNMASK_MAX_MINUTES}.`,
				);
			request.minutes = minutes;
		}
	}
	if (parsed.values.text !== undefined) request.text = parsed.values.text;
	if (verb === "network") Object.assign(request, networkOptions(parsed.values));
	if (tab !== undefined) request.tabId = tab;
	try {
		return {
			request: validatePwExtRequest(request),
			...(staged ? { staged } : {}),
			...(parsed.values.session === undefined ? {} : { session: parsed.values.session }),
			...(secret === undefined ? {} : { secret }),
		};
	} catch (error) {
		throw new ExtUsageError(
			redactText(
				redactLiterals(error instanceof Error ? error.message : String(error), secret ? [secret] : []),
				secret ? [secret] : [],
			),
		);
	}
}

function fetchOptions(
	url: string,
	values: { method?: string; json?: string; "body-stdin"?: boolean; header?: string[]; auth?: string; values?: boolean },
	source: SecretSource,
): Partial<PwExtRequest> {
	const options: Partial<PwExtRequest> = { url };
	if (values.json !== undefined && values["body-stdin"])
		throw new ExtUsageError("pw --ext fetch takes --json or --body-stdin, not both.");
	if (values.json !== undefined) {
		try {
			JSON.parse(values.json);
		} catch {
			throw new ExtUsageError("pw --ext fetch --json needs valid JSON.");
		}
		Object.assign(options, { body: values.json, contentType: "application/json" });
	}
	if (values["body-stdin"]) options.body = (source.readStdin ?? (() => readFileSync(0, "utf8")))();
	const method = (values.method ?? (options.body === undefined ? "GET" : "POST")).toUpperCase();
	if (method !== "GET") options.method = method;
	if (values.header?.length)
		options.headers = values.header.map((pair) => {
			const at = pair.indexOf(":");
			if (at < 1) throw new ExtUsageError("pw --ext fetch --header takes Name:Value.");
			return [pair.slice(0, at).trim(), pair.slice(at + 1).trim()] as [string, string];
		});
	if (values.auth !== undefined) {
		if (values.auth !== "page") throw new ExtUsageError("pw --ext fetch --auth takes page.");
		options.auth = "page";
	}
	if (values.values) options.values = true;
	return options;
}

function networkOptions(values: { filter?: string; limit?: string; since?: string; values?: boolean }): Partial<PwExtRequest> {
	const options: Partial<PwExtRequest> = {};
	if (values.since === "clear") {
		if (values.filter !== undefined || values.limit !== undefined || values.values)
			throw new ExtUsageError("pw --ext network --since clear takes no other option.");
		return { since: "clear" };
	}
	if (values.since !== undefined) {
		if (!/^\d{1,16}$/.test(values.since))
			throw new ExtUsageError("pw --ext network --since takes a time in ms or clear.");
		options.since = Number(values.since);
	}
	if (values.limit !== undefined) {
		const limit = Number(values.limit);
		if (!/^\d+$/.test(values.limit) || limit < 1 || limit > PW_EXT_NETWORK_MAX_LIMIT)
			throw new ExtUsageError(`pw --ext network --limit takes a whole number from 1 to ${PW_EXT_NETWORK_MAX_LIMIT}.`);
		options.limit = limit;
	}
	if (values.filter !== undefined) options.filter = values.filter;
	if (values.values) options.values = true;
	return options;
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
		parsed = parseRequest(argv, env.cwd, deps);
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
	const secrets = parsed.secret ? [parsed.secret] : [];
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
			isPwExtCliResult(requestId),
			PW_EXT_DEFAULT_TIMEOUT_MS + 5_000,
		);
		if (!reply.ok) {
			env.err(redactText(redactLiterals(reply.error ?? "pw --ext failed in the browser.", secrets), secrets));
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
		const lines = [redactSecrets(redactLiterals(data.text, secrets), secrets)];
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
		env.err(
			redactText(redactLiterals(error instanceof Error ? error.message : String(error), secrets), secrets),
		);
		return 1;
	} finally {
		stopListening();
		client.close();
	}
}
