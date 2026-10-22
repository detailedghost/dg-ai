import type { Page } from "playwright-core";
import { CODE_COMMAND } from "./code/index";
import { COMMANDS } from "./commands/index";
import { commandName, normalize, parse, UsageError } from "./core/args";
import { type LaunchSpec, start } from "./core/browser";
import { type DispatchState, describeError, dispatch } from "./core/dispatch";
import { attach } from "./core/events";
import { remove, touch, write } from "./core/registry";
import { pageHeader, render } from "./core/response";
import { type DaemonRequest, type DaemonResponse, serve } from "./core/socket";
import type { Ctx, DaemonHandler } from "./core/spec";

/** The long-running per-session browser process; `pw __daemon` reexecs the compiled binary into this. */
export async function runDaemon(spec: LaunchSpec): Promise<void> {
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

	const run = async (request: Extract<DaemonRequest, { params: unknown }>): Promise<DaemonResponse> => {
		touch(spec.key);
		const argv = normalize(request.params.argv);
		const entry =
			request.method === "code"
				? CODE_COMMAND
				: COMMANDS.find((candidate) => candidate.spec.name === commandName(argv));
		if (entry?.spec.side !== "daemon") {
			return { id: request.id, error: `Not a browser command: ${commandName(argv) ?? ""}` };
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
			return { id: request.id, result: { text: describeError(error), exitCode } };
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
				return render({ page: await pageHeader(tab, events.totals(tab)) }, { raw: false, codegen: false });
			});
			return { id: request.id, result: { text, exitCode: 0 } };
		}
		return enqueue(() => run(request));
	};

	await serve(spec.socketPath, onRequest);
	write({ ...spec, pid: process.pid, startedAt: new Date().toISOString() });
	void handle.closed.then(() => shutdown(0));
	for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void shutdown(0));
	process.stdout.write(`READY ${spec.socketPath}\n`);
}

/** Entry for the hidden `pw __daemon <json>` verb; terminates the process, never returns. */
export async function runDaemonFromJson(json: string | undefined): Promise<never> {
	process.on("unhandledRejection", (reason) => console.error(`unhandledRejection: ${describeError(reason)}`));
	process.on("uncaughtException", (error) => console.error(`uncaughtException: ${describeError(error)}`));

	let spec: LaunchSpec | null;
	try {
		spec = JSON.parse(json ?? "null") as LaunchSpec | null;
	} catch {
		spec = null;
	}
	if (!spec) {
		process.stdout.write("ERROR missing launch spec\n");
		return process.exit(1);
	}
	try {
		await runDaemon(spec);
		return new Promise<never>(() => undefined);
	} catch (error) {
		const message = describeError(error);
		console.error(message);
		process.stdout.write(`ERROR ${message.split("\n")[0]}\n`);
		return process.exit(1);
	}
}
