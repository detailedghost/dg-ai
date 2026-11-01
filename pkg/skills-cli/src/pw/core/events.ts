import type { BrowserContext, ConsoleMessage, Dialog, Download, FileChooser, Page, Request } from "playwright-core";
import { restrictFile } from "./files";
import { resolveOutput, timestampedName } from "./response";

export type ConsoleEntry = { type: string; text: string };

export type ConsoleLevel = "error" | "warning" | "info" | "debug";

export const CONSOLE_LEVELS: readonly ConsoleLevel[] = ["error", "warning", "info", "debug"];

export type DialogWatch = { opened: Promise<void>; dispose(): void };

export type Events = {
	drain(page: Page): ConsoleEntry[];
	totals(page: Page): { errors: number; warnings: number };
	console(page: Page): ConsoleEntry[];
	clearConsole(page: Page): void;
	requests(page: Page): Request[];
	clearRequests(page: Page): void;
	drainNotices(page: Page): string[];
	modal(page: Page): string[];
	hasDialog(page: Page): boolean;
	hasChooser(page: Page): boolean;
	takeDialog(page: Page): Dialog | undefined;
	takeChooser(page: Page): FileChooser | undefined;
	watchDialog(page: Page): DialogWatch;
};

type Tab = {
	pending: ConsoleEntry[];
	retained: ConsoleEntry[];
	requests: Request[];
	notices: string[];
	errors: number;
	warnings: number;
	dialog?: Dialog;
	chooser?: FileChooser;
	waiters: Set<() => void>;
};

const MAX_BUFFER = 1000;
const MODAL_TEXT_MAX = 200;

export function levelOf(type: string): ConsoleLevel {
	if (type === "error" || type === "assert") return "error";
	if (type === "warning") return "warning";
	if (type === "debug") return "debug";
	return "info";
}

export const meetsLevel = (entry: ConsoleEntry, minimum: ConsoleLevel): boolean =>
	CONSOLE_LEVELS.indexOf(levelOf(entry.type)) <= CONSOLE_LEVELS.indexOf(minimum);

function push<T>(items: T[], item: T): void {
	items.push(item);
	if (items.length > MAX_BUFFER) items.shift();
}

export function safeExtension(name: string): string {
	const extension = name.includes(".") ? (name.split(".").pop() ?? "") : "";
	return /^[A-Za-z0-9]{1,8}$/.test(extension) ? extension : "bin";
}

function firstLine(text: string): string {
	return (text.split("\n")[0] ?? "").slice(0, MODAL_TEXT_MAX);
}

export function attach(context: BrowserContext, outputDir: string): Events {
	const tabs = new WeakMap<Page, Tab>();

	const tabFor = (page: Page): Tab => {
		let tab = tabs.get(page);
		if (!tab) {
			tab = {
				pending: [],
				retained: [],
				requests: [],
				notices: [],
				errors: 0,
				warnings: 0,
				waiters: new Set(),
			};
			tabs.set(page, tab);
		}
		return tab;
	};

	const record = (page: Page, entry: ConsoleEntry): void => {
		const tab = tabFor(page);
		push(tab.pending, entry);
		push(tab.retained, entry);
		const kind = levelOf(entry.type);
		if (kind === "error") tab.errors++;
		if (kind === "warning") tab.warnings++;
	};

	const saveDownload = async (page: Page, download: Download): Promise<void> => {
		const tab = tabFor(page);
		const name = download.suggestedFilename();
		try {
			const file = resolveOutput(outputDir, timestampedName("download", safeExtension(name)));
			await download.saveAs(file);
			restrictFile(file);
			push(tab.notices, `- Downloaded ${name} to ${file}`);
		} catch (error) {
			push(tab.notices, `- Download of ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const track = (page: Page): void => {
		const tab = tabFor(page);
		page.on("console", (message: ConsoleMessage) => record(page, { type: message.type(), text: message.text() }));
		page.on("pageerror", (error: Error) => record(page, { type: "error", text: error.message }));
		page.on("request", (request) => {
			if (request.serviceWorker()) return;
			if (request.isNavigationRequest() && request.frame() === page.mainFrame()) tab.requests = [];
			push(tab.requests, request);
		});
		page.on("framenavigated", (frame) => {
			if (frame !== page.mainFrame()) return;
			tab.errors = 0;
			tab.warnings = 0;
			tab.retained = [];
		});
		page.on("dialog", (dialog) => {
			tab.dialog = dialog;
			for (const wake of tab.waiters) wake();
		});
		page.on("filechooser", (chooser) => {
			tab.chooser = chooser;
		});
		page.on("download", (download) => void saveDownload(page, download));
	};

	for (const page of context.pages()) track(page);
	context.on("page", track);

	return {
		drain(page) {
			const tab = tabFor(page);
			const entries = tab.pending;
			tab.pending = [];
			return entries;
		},
		totals(page) {
			const { errors, warnings } = tabFor(page);
			return { errors, warnings };
		},
		console: (page) => [...tabFor(page).retained],
		clearConsole(page) {
			const tab = tabFor(page);
			tab.retained = [];
			tab.pending = [];
			tab.errors = 0;
			tab.warnings = 0;
		},
		requests: (page) => [...tabFor(page).requests],
		clearRequests(page) {
			tabFor(page).requests = [];
		},
		drainNotices(page) {
			const tab = tabFor(page);
			const notices = tab.notices;
			tab.notices = [];
			return notices;
		},
		modal(page) {
			const { dialog, chooser } = tabFor(page);
			const lines: string[] = [];
			if (dialog) {
				lines.push(
					`- ["${dialog.type()}" dialog with message "${firstLine(dialog.message())}"]: ` +
						'can be handled by the "dialog-accept" or "dialog-dismiss" command',
				);
			}
			if (chooser) lines.push('- [File chooser]: can be handled by the "upload" command');
			return lines;
		},
		hasDialog: (page) => tabFor(page).dialog !== undefined,
		hasChooser: (page) => tabFor(page).chooser !== undefined,
		takeDialog(page) {
			const tab = tabFor(page);
			const { dialog } = tab;
			tab.dialog = undefined;
			return dialog;
		},
		takeChooser(page) {
			const tab = tabFor(page);
			const { chooser } = tab;
			tab.chooser = undefined;
			return chooser;
		},
		watchDialog(page) {
			const tab = tabFor(page);
			let wake: () => void = () => undefined;
			const opened = new Promise<void>((resolve) => {
				wake = resolve;
				if (tab.dialog) resolve();
				else tab.waiters.add(resolve);
			});
			return { opened, dispose: () => void tab.waiters.delete(wake) };
		},
	};
}
