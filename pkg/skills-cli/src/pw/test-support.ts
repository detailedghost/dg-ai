import { afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright-core";
import { parse } from "./core/args";
import type { Events } from "./core/events";
import { readCmdline, type SessionRecord, socketPathFor, write } from "./core/registry";
import { type DaemonRequest, serve } from "./core/socket";
import type { ClientEnv, CommandSpec, Ctx, ParsedArgs } from "./core/spec";

export function useTempEnv(name: string): { readonly dir: string } {
	const holder = { dir: "" };
	let previous: string | undefined;
	beforeEach(() => {
		previous = process.env[name];
		holder.dir = mkdtempSync(path.join(tmpdir(), "pw-test-"));
		process.env[name] = holder.dir;
	});
	afterEach(() => {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
		rmSync(holder.dir, { recursive: true, force: true });
	});
	return holder;
}

export const useTempScratch = (): { readonly dir: string } => useTempEnv("AI_SCRATCH_DIR");

export const argsFor = (spec: CommandSpec, ...argv: string[]): ParsedArgs => parse([spec.name, ...argv], spec);

function writeFakeOutput(method: string, args: unknown[]): void {
	const target = (args[0] as { path?: unknown } | undefined)?.path;
	if (typeof target === "string" && (method === "pdf" || method === "stop")) writeFileSync(target, "x");
}

export type Recorded<T extends object> = T & {
	returns: Record<string, unknown>;
};

function recording<T extends object>(target: T, calls: string[], label: string): Recorded<T> {
	const returns: Record<string, unknown> = {};
	return new Proxy(target, {
		get(object, property, receiver) {
			if (property === "returns") return returns;
			if (typeof property !== "string" || property === "then" || property in object) {
				return Reflect.get(object, property, receiver);
			}
			return async (...args: unknown[]) => {
				calls.push(`${label}${property} ${JSON.stringify(args)}`);
				writeFakeOutput(property, args);
				const value = returns[property];
				if (value instanceof Error) throw value;
				return value;
			};
		},
	}) as Recorded<T>;
}

export class FakeLocator {
	readonly returns: Record<string, unknown> = {};
	readonly calls: string[] = [];

	constructor(
		readonly selector: string,
		private readonly matches = 1,
		private readonly evaluated: unknown = undefined,
	) {}

	async count(): Promise<number> {
		return this.matches;
	}

	async click(options?: unknown): Promise<void> {
		this.calls.push(`click ${JSON.stringify(options)}`);
	}

	async fill(text: string): Promise<void> {
		this.calls.push(`fill ${text}`);
	}

	async press(key: string): Promise<void> {
		this.calls.push(`press ${key}`);
	}

	async evaluate(source: unknown): Promise<unknown> {
		this.calls.push(`evaluate ${String(source)}`);
		return this.evaluated;
	}

	async screenshot(options: { path: string; type: string }): Promise<void> {
		this.calls.push(`screenshot ${options.type}`);
		writeFileSync(options.path, "image");
	}

	async ariaSnapshot(): Promise<string> {
		return `- scoped ${this.selector}`;
	}

	toString(): string {
		return `locator('${this.selector}')`;
	}
}

export class FakePage {
	readonly returns: Record<string, unknown> = {};
	readonly calls: string[] = [];
	readonly locators = new Map<string, FakeLocator>();
	evaluated: unknown = undefined;
	snapshotCalls: unknown[] = [];
	readonly keyboard = recording(
		{
			type: async (text: string) => void this.calls.push(`type ${text}`),
			press: async (key: string) => void this.calls.push(`press ${key}`),
		},
		this.calls,
		"keyboard.",
	);
	readonly mouse = recording({}, this.calls, "mouse.");
	readonly screencast = recording({}, this.calls, "screencast.");

	locator(selector: string): FakeLocator {
		const existing = this.locators.get(selector);
		if (existing) return existing;
		const created = new FakeLocator(selector);
		this.locators.set(selector, created);
		return created;
	}

	missing(selector: string): void {
		this.locators.set(selector, new FakeLocator(selector, 0));
	}

	async goto(url: string, options?: unknown): Promise<void> {
		this.calls.push(`goto ${url} ${JSON.stringify(options)}`);
	}

	readonly evaluateArgs: unknown[] = [];

	async evaluate(source: unknown, argument?: unknown): Promise<unknown> {
		this.calls.push(`evaluate ${String(source)}`);
		this.evaluateArgs.push(argument);
		return this.evaluated;
	}

	async screenshot(options: { path: string; type: string; fullPage: boolean }): Promise<void> {
		this.calls.push(`screenshot ${options.type} fullPage=${options.fullPage}`);
		writeFileSync(options.path, "image");
	}

	async ariaSnapshot(options: unknown): Promise<string> {
		this.snapshotCalls.push(options);
		return "- generic [ref=e1]";
	}

	async waitForLoadState(): Promise<void> {}

	url(): string {
		return "https://example.test/";
	}

	async title(): Promise<string> {
		return "Example";
	}

	isClosed(): boolean {
		return false;
	}
}

type Fallback = { calls: string[]; returns: Record<string, unknown> };

function installFallback(prototype: object): void {
	const fallback = new Proxy(
		{},
		{
			get(_target, property, receiver: Fallback) {
				if (typeof property !== "string" || property === "then") return undefined;
				return async (...args: unknown[]) => {
					receiver.calls.push(`${property} ${JSON.stringify(args)}`);
					writeFakeOutput(property, args);
					const value = receiver.returns[property];
					if (value instanceof Error) throw value;
					return value;
				};
			},
		},
	);
	Object.setPrototypeOf(prototype, fallback);
}

installFallback(FakeLocator.prototype);
installFallback(FakePage.prototype);

export function fakeEvents(overrides: Partial<Events> = {}): Events {
	return {
		drain: () => [],
		totals: () => ({ errors: 0, warnings: 0 }),
		console: () => [],
		clearConsole: () => undefined,
		requests: () => [],
		clearRequests: () => undefined,
		drainNotices: () => [],
		modal: () => [],
		hasDialog: () => false,
		hasChooser: () => false,
		takeDialog: () => undefined,
		takeChooser: () => undefined,
		watchDialog: () => ({
			opened: new Promise<void>(() => undefined),
			dispose: () => undefined,
		}),
		...overrides,
	};
}

export type FakeContext = Recorded<{
	pages(): Page[];
	tracing: Recorded<object>;
}>;

export function fakeCtx(
	outputDir: string,
	page = new FakePage(),
	events: Partial<Events> = {},
): { ctx: Ctx; page: FakePage; context: FakeContext } {
	const pages: Page[] = [page as unknown as Page];
	const context = recording(
		{ pages: () => pages, tracing: recording({}, page.calls, "tracing.") },
		page.calls,
		"context.",
	) as FakeContext;
	let current = 0;
	const ctx: Ctx = {
		context: context as unknown as Ctx["context"],
		page: () => context.pages()[current] as Page,
		selectTab: (index) => {
			current = index;
		},
		outputDir,
		clientCwd: "/work",
		events: fakeEvents(events),
		state: { routes: [], tracing: false },
	};
	return { ctx, page, context };
}

export function clientEnv(cwd = "/work"): ClientEnv & { stdout: string[]; stderr: string[] } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		cwd,
		stdout,
		stderr,
		out: (text) => void stdout.push(text),
		err: (text) => void stderr.push(text),
	};
}

let fakeDaemonPath: string | undefined;

function fakeDaemon(): string {
	if (fakeDaemonPath === undefined) {
		const dir = path.join(mkdtempSync(path.join(tmpdir(), "pw-fake-daemon-")), "skills-cli", "src");
		mkdirSync(dir, { recursive: true });
		fakeDaemonPath = path.join(dir, "index.ts");
		writeFileSync(fakeDaemonPath, "await Bun.sleep(60_000);\n");
	}
	return fakeDaemonPath;
}

export function spawnFakeDaemonProcess(key: string): ReturnType<typeof Bun.spawn> {
	const script = fakeDaemon();
	const child = Bun.spawn([process.execPath, script, "pw", "__daemon", JSON.stringify({ key })]);
	const deadline = Date.now() + 2_000;
	while (!readCmdline(child.pid)?.includes(script) && Date.now() < deadline) Bun.sleepSync(2);
	return child;
}

export function useFakeDaemons(): { pidFor(key: string): number } {
	const children: ReturnType<typeof Bun.spawn>[] = [];
	afterEach(() => {
		for (const child of children.splice(0)) child.kill();
	});
	return {
		pidFor(key) {
			const child = spawnFakeDaemonProcess(key);
			children.push(child);
			return child.pid;
		},
	};
}

export type FakeReply = { text: string; exitCode: number };

export async function startFakeDaemon(
	key: string,
	overrides: Partial<SessionRecord> = {},
	respond: (request: DaemonRequest) => FakeReply = () => ({
		text: "",
		exitCode: 0,
	}),
) {
	const child = spawnFakeDaemonProcess(key);
	const server = await serve(socketPathFor(key), async (request) => {
		if (request.method === "stop") child.kill();
		return {
			id: request.id,
			result: request.method === "stop" ? { text: "", exitCode: 0 } : respond(request),
		};
	});
	const record: SessionRecord = {
		name: key.split("@")[0] as string,
		key,
		pid: child.pid,
		socketPath: socketPathFor(key),
		cwd: "/work",
		outputDir: "/tmp/out",
		mode: "local",
		browser: "chrome",
		headless: true,
		scratch: key.includes("@"),
		codegen: false,
		profileDir: null,
		startedAt: "2026-10-07T00:00:00.000Z",
		...overrides,
	};
	write(record);
	const dispose = () => {
		child.kill();
		server.close();
	};
	return { child, record, dispose };
}
