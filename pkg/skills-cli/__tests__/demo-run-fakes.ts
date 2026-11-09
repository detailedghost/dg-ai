import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EncodeDeps } from "../src/demo/recorder/encode";
import { GEOMETRY } from "../src/demo/recorder/encode";
import type { PlayerSession } from "../src/demo/player-process";

export type FakeLocator = {
	filled: string[];
	focused: number;
	typed: string[];
	clicked: number;
};

export type FakeOptions = {
	dir: string;
	missing?: string[];
	hang?: boolean;
	noVideo?: boolean;
	visible?: Record<string, boolean>;
	notPassword?: string[];
	navigatesOnPrompt?: boolean;
	gotoDelayMs?: number;
	untypable?: string[];
	initialCloseMs?: number;
	clickNavigates?: Record<string, string>;
	tabStorage?: { origin: string; items: [string, string][] };
};

export type OpenCall = { record: boolean; state: unknown };

export function fakeBrowser(options: FakeOptions) {
	const locators = new Map<string, FakeLocator>();
	const opens: OpenCall[] = [];
	const log: string[] = [];
	const closes: Array<() => void> = [];
	const evaluated: unknown[] = [];
	const initScripts: OpenCall[] = [];
	const snapshots: unknown[] = [];

	const locatorFor = (selector: string, moveTo: (url: string) => void) => {
		const state = locators.get(selector) ?? { filled: [], focused: 0, typed: [], clicked: 0 };
		locators.set(selector, state);
		const handle = {
			waitFor: async () => {
				if (options.missing?.includes(selector)) throw new Error("timeout");
			},
			scrollIntoViewIfNeeded: async () => undefined,
			boundingBox: async () => null,
			isVisible: async () => options.visible?.[selector] ?? true,
			evaluate: async () => !options.notPassword?.includes(selector),
			fill: async (text: string) => void state.filled.push(text),
			focus: async () => void state.focused++,
			click: async () => {
				state.clicked++;
				const to = options.clickNavigates?.[selector];
				if (to) moveTo(to);
			},
			pressSequentially: async (text: string) => {
				if (options.untypable?.includes(selector)) throw new Error("element is readonly");
				state.typed.push(text);
			},
		};
		return { first: () => handle };
	};

	const newPage = (record: boolean) => {
		let current = "https://example.test/";
		return {
		goto: async (url: string) => {
			log.push(`goto ${url}`);
			current = url;
			if (options.hang) await new Promise(() => undefined);
			if (options.gotoDelayMs) await new Promise((r) => setTimeout(r, options.gotoDelayMs));
		},
		url: () => current,
		viewportSize: () => null,
		locator: (selector: string) => locatorFor(selector, (url) => (current = url)),
		waitForLoadState: async (state: string) => void log.push(`load ${state}`),
		waitForURL: async () => {
			if (options.navigatesOnPrompt) current = "https://example.test/home";
		},
		evaluate: async (_fn: unknown, arg?: unknown) => {
			if (!record && arg === undefined) return options.tabStorage;
			evaluated.push(arg);
		},
		close: async () => undefined,
		video: () =>
			options.noVideo
				? null
				: {
						path: async () => {
							const file = join(options.dir, "rec", `raw-${opens.length}.webm`);
							mkdirSync(join(options.dir, "rec"), { recursive: true });
							writeFileSync(file, "webm");
							return file;
						},
					},
		};
	};

	const newContext = (record: boolean, state: unknown) => {
		opens.push({ record, state });
		const handlers: Array<() => void> = [];
		const context = {
			pages: () =>
				options.initialCloseMs
					? [{ close: () => new Promise((r) => setTimeout(r, options.initialCloseMs)) }]
					: [],
			newPage: async () => newPage(record),
			addInitScript: async (_fn: unknown, arg: unknown) => void initScripts.push({ record, state: arg }),
			storageState: async (options?: unknown) => {
				snapshots.push(options);
				return { cookies: [{ name: "sid" }], origins: [] };
			},
			once: (_event: string, handler: () => void) => void handlers.push(handler),
			close: async () => {
				log.push(`close ${record ? "recording" : "setup"}`);
				for (const handler of handlers) handler();
			},
		};
		closes.push(() => handlers.forEach((handler) => handler()));
		return context as never;
	};

	const session: PlayerSession = {
		open: async (record, state) => newContext(record, state),
		close: async () => void log.push("session closed"),
	};

	return {
		session,
		launch: async () => session,
		opens,
		log,
		locators,
		evaluated,
		initScripts,
		snapshots,
		closeBrowser: () => closes.forEach((close) => close()),
	};
}

export function fakeEncode(present = true): { deps: EncodeDeps; commands: string[][] } {
	const commands: string[][] = [];
	return {
		commands,
		deps: {
			which: (name) => (present ? `/usr/bin/${name}` : null),
			run: (cmd) => {
				commands.push(cmd);
				if (cmd[0]?.endsWith("ffmpeg")) {
					writeFileSync(String(cmd.at(-1)), "mp4");
					return { status: 0, stdout: "", stderr: "" };
				}
				return { status: 0, stdout: `${GEOMETRY}\n`, stderr: "" };
			},
		},
	};
}
