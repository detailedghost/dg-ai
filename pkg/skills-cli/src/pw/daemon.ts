import path from "node:path";
import { isPathInside } from "@dg/common/node";
import type { Page } from "playwright-core";
import { CODE_COMMAND } from "./code/index";
import { COMMANDS } from "./commands/index";
import {
	commandName,
	normalize,
	parse,
	SESSION_NAME,
	UsageError,
} from "./core/args";
import { type LaunchSpec, start } from "./core/browser";
import { type DispatchState, describeError, dispatch } from "./core/dispatch";
import { browsersDir, downloadedChromium } from "./core/downloaded";
import { attach } from "./core/events";
import {
	BROWSERS,
	type BrowserName,
	remove,
	socketPathFor,
	touch,
	write,
} from "./core/registry";
import { pageHeader, render } from "./core/response";
import { type DaemonRequest, type DaemonResponse, serve } from "./core/socket";
import type { Ctx, DaemonHandler } from "./core/spec";
import { STATE_NAME, statesDir } from "./core/states";
import { parseCdpUrl } from "./core/url";
import {
	assertSafeProfileDir,
	isWindowsPath,
	WINDOWS_BROWSERS,
} from "./core/windows";

async function serveSession(spec: LaunchSpec): Promise<void> {
	const handle = await start(spec);
	const events = attach(handle.context, spec.outputDir);
	const state: DispatchState = {};

	let current: Page | undefined = handle.context.pages()[0];
	handle.context.on("page", (page) => {
		current = page;
	});
	const page = (): Page => {
		if (current && !current.isClosed()) return current;
		const open = handle.context.pages();
		current = open[open.length - 1];
		if (!current) throw new Error("No open tabs. Run: pw goto <url>");
		return current;
	};
	const ctx: Ctx = {
		context: handle.context,
		page,
		selectTab(index) {
			const target = handle.context.pages()[index];
			if (!target) throw new Error(`Tab ${index} does not exist`);
			current = target;
		},
		outputDir: spec.outputDir,
		clientCwd: spec.cwd,
		events,
		state: { routes: [], tracing: false },
	};

	let cleanup: Promise<void> | undefined;
	const shutdown = async (code: number): Promise<never> => {
		cleanup ??= (async () => {
			await handle.close().catch(() => undefined);
			remove(spec.key);
		})();
		await cleanup;
		return process.exit(code);
	};

	let queue: Promise<unknown> = Promise.resolve();
	const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
		const result = queue.then(task, task);
		queue = result.catch(() => undefined);
		return result;
	};

	const run = async (
		request: Extract<DaemonRequest, { params: unknown }>,
	): Promise<DaemonResponse> => {
		touch(spec.key);
		const argv = normalize(request.params.argv);
		const entry =
			request.method === "code"
				? CODE_COMMAND
				: COMMANDS.find(
						(candidate) => candidate.spec.name === commandName(argv),
					);
		if (entry?.spec.side !== "daemon") {
			return {
				id: request.id,
				error: `Not a browser command: ${commandName(argv) ?? ""}`,
			};
		}
		try {
			const args = parse(argv, entry.spec);
			ctx.clientCwd = request.params.cwd;
			const handler = (await entry.load()).default as DaemonHandler;
			const result = await dispatch(handler, entry.spec, args, ctx, {
				raw: request.params.raw,
				codegen: args.codegen || spec.codegen,
				state,
				sessionDepth: spec.snapshotDepth,
				envDepth: request.params.snapshotDepth,
			});
			return { id: request.id, result };
		} catch (error) {
			const exitCode = error instanceof UsageError ? 2 : 1;
			return {
				id: request.id,
				result: { text: describeError(error), exitCode },
			};
		}
	};

	const onRequest = async (request: DaemonRequest): Promise<DaemonResponse> => {
		if (request.method === "stop") {
			setImmediate(() => void shutdown(0));
			return { id: request.id, result: { text: "", exitCode: 0 } };
		}
		if (request.method === "ping") {
			const text = await enqueue(async () => {
				const tab = page();
				return render(
					{ page: await pageHeader(tab, events.totals(tab)) },
					{ raw: false, codegen: false },
				);
			});
			return { id: request.id, result: { text, exitCode: 0 } };
		}
		return enqueue(() => run(request));
	};

	await serve(spec.socketPath, onRequest);
	write({ ...spec, pid: process.pid, startedAt: new Date().toISOString() });
	void handle.closed.then(() => shutdown(0));
	for (const signal of ["SIGTERM", "SIGINT"] as const)
		process.on(signal, () => void shutdown(0));
	process.stdout.write(`READY ${spec.socketPath}\n`);
}

type Wire = Record<string, unknown>;

const SCRATCH_KEY_SUFFIX = /^@[0-9a-f]{8}$/;
const INVALID_SPEC_EXIT = 2;

function invalid(field: string, rule: string): never {
	throw new Error(`Invalid launch spec: ${field} ${rule}`);
}

function bool(wire: Wire, field: string): boolean {
	const value = wire[field];
	if (typeof value !== "boolean") invalid(field, "must be true or false");
	return value;
}

function absolutePath(wire: Wire, field: string): string {
	const value = wire[field];
	if (
		typeof value !== "string" ||
		value.includes("\0") ||
		path.resolve(value) !== value
	) {
		invalid(field, "must be an absolute, normalized path");
	}
	return value;
}

function sessionName(wire: Wire): string {
	const name = wire["name"];
	if (typeof name !== "string" || !SESSION_NAME.test(name)) {
		throw new Error(`Invalid session name '${String(name)}'`);
	}
	return name;
}

function sessionKeyOf(wire: Wire, name: string, scratch: boolean): string {
	const key = wire["key"];
	const suffix =
		typeof key === "string" && key.startsWith(name)
			? key.slice(name.length)
			: null;
	const matches =
		suffix !== null &&
		(scratch ? SCRATCH_KEY_SUFFIX.test(suffix) : suffix === "");
	if (!matches || typeof key !== "string")
		throw new Error(`Invalid session key '${String(key)}'`);
	return key;
}

function snapshotDepth(wire: Wire): Pick<LaunchSpec, "snapshotDepth"> {
	const depth = wire["snapshotDepth"];
	if (depth === undefined) return {};
	if (typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 0) {
		invalid("snapshotDepth", "must be a non-negative integer");
	}
	return { snapshotDepth: depth };
}

function storageState(wire: Wire): Pick<LaunchSpec, "storageState"> {
	const file = wire["storageState"];
	if (file === undefined) return {};
	const dir = statesDir();
	const saved =
		typeof file === "string" &&
		file.endsWith(".json") &&
		file === path.join(dir, path.basename(file)) &&
		STATE_NAME.test(path.basename(file, ".json"));
	if (!saved) invalid("storageState", `must be a saved state under ${dir}`);
	return { storageState: file };
}

function downloadedExecutable(
	browser: BrowserName,
): Pick<LaunchSpec, "executablePath"> {
	if (browser !== "chromium") return {};
	const downloaded = downloadedChromium();
	if (!downloaded || !isPathInside(downloaded.executablePath, browsersDir()))
		return {};
	return { executablePath: downloaded.executablePath };
}

type Target = Pick<
	LaunchSpec,
	"mode" | "browser" | "profileDir" | "executablePath" | "cdpUrl" | "winPid"
>;

function localTarget(wire: Wire, scratch: boolean): Target {
	const browser = BROWSERS.find((known) => known === wire["browser"]);
	if (!browser) invalid("browser", `must be one of ${BROWSERS.join(", ")}`);
	if (scratch && wire["profileDir"] !== null)
		invalid("profileDir", "must be null for a scratch session");
	const profileDir = scratch ? null : absolutePath(wire, "profileDir");
	return {
		mode: "local",
		browser,
		profileDir,
		...downloadedExecutable(browser),
	};
}

function cdpTarget(wire: Wire, scratch: boolean): Target {
	if (scratch) invalid("scratch", "must be false for a CDP session");
	const browser = WINDOWS_BROWSERS.find((known) => known === wire["browser"]);
	if (!browser)
		invalid(
			"browser",
			`must be one of ${WINDOWS_BROWSERS.join(", ")} for a CDP session`,
		);
	const cdpUrl = wire["cdpUrl"];
	if (typeof cdpUrl !== "string")
		invalid("cdpUrl", "is required for a CDP session");
	parseCdpUrl(cdpUrl);
	const winPid = wire["winPid"];
	const profileDir = wire["profileDir"];
	if (winPid === undefined) {
		if (profileDir !== null)
			invalid("profileDir", "must be null for an attached CDP session");
		return { mode: "cdp", browser, profileDir: null, cdpUrl };
	}
	if (
		typeof winPid !== "number" ||
		!Number.isSafeInteger(winPid) ||
		winPid < 1
	) {
		invalid("winPid", "must be a positive integer");
	}
	if (typeof profileDir !== "string" || !isWindowsPath(profileDir)) {
		invalid(
			"profileDir",
			"must be a Windows path for a Windows browser session",
		);
	}
	assertSafeProfileDir(profileDir);
	return { mode: "cdp", browser, profileDir, cdpUrl, winPid };
}

export function validateSpec(input: unknown): LaunchSpec {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new Error("Invalid launch spec: must be a JSON object");
	}
	const wire: Wire = Object.fromEntries(Object.entries(input));
	const name = sessionName(wire);
	const scratch = bool(wire, "scratch");
	const key = sessionKeyOf(wire, name, scratch);
	const mode = wire["mode"];
	if (mode !== "local" && mode !== "cdp")
		invalid("mode", "must be local or cdp");
	const target =
		mode === "local" ? localTarget(wire, scratch) : cdpTarget(wire, scratch);
	return {
		name,
		key,
		socketPath: socketPathFor(key),
		cwd: absolutePath(wire, "cwd"),
		outputDir: absolutePath(wire, "outputDir"),
		headless: bool(wire, "headless"),
		scratch,
		codegen: bool(wire, "codegen"),
		...snapshotDepth(wire),
		...storageState(wire),
		...target,
	};
}

function readSpec(specJson: string | undefined): unknown {
	if (specJson === undefined) throw new Error("missing launch spec");
	try {
		return JSON.parse(specJson);
	} catch {
		throw new Error("launch spec is not valid JSON");
	}
}

export function runDaemon(specJson: string | undefined): Promise<void> {
	process.on("unhandledRejection", (reason) =>
		console.error(`unhandledRejection: ${describeError(reason)}`),
	);
	process.on("uncaughtException", (error) =>
		console.error(`uncaughtException: ${describeError(error)}`),
	);

	let trusted: LaunchSpec;
	try {
		trusted = validateSpec(readSpec(specJson));
	} catch (error) {
		process.stdout.write(`ERROR ${describeError(error)}\n`);
		process.exit(INVALID_SPEC_EXIT);
	}
	return serveSession(trusted).catch((error) => {
		const message = describeError(error);
		console.error(message);
		process.stdout.write(`ERROR ${message.split("\n")[0]}\n`);
		process.exit(1);
	});
}
