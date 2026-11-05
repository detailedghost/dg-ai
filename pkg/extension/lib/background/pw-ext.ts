import {
	isPwExtWebUrl,
	isPwExtWriteVerb,
	PW_EXT_MAX_TEXT_CHARS,
	type PwExtRequest,
	type PwExtResponse,
	type PwExtVerb,
	redactText,
	validatePwExtRequest,
} from "@dg/common";
import {
	type PwExtWebMcpResult,
	pwExtConsoleHook,
	pwExtWebMcp,
} from "@/lib/features/pw-ext-main";
import {
	type PwExtElement,
	type PwExtPageAction,
	type PwExtPageResult,
	pwExtPageAction,
} from "@/lib/features/pw-ext-page";
import { isProtonMailOrigin } from "@/lib/features/inbox-proton-observer";
import { fitPreviewDataUrl } from "./proto";

type Tab = {
	id?: number;
	windowId?: number;
	url?: string;
	title?: string;
	active?: boolean;
	incognito?: boolean;
};

type TabEvent<T> = {
	addListener(listener: T): void;
	removeListener(listener: T): void;
};

/** Promise-based Chromium MV3 surface the handler needs. */
export type PwExtBrowserApi = {
	windows: {
		getLastFocused(options: {
			windowTypes: ["normal"];
		}): Promise<{ id?: number }>;
	};
	tabs: {
		query(query: { active?: boolean; windowId?: number }): Promise<Tab[]>;
		get(tabId: number): Promise<Tab>;
		create(props: {
			url: string;
			windowId?: number;
			active: boolean;
		}): Promise<Tab>;
		captureVisibleTab(
			windowId: number,
			options: { format: "jpeg"; quality: number },
		): Promise<string>;
		onActivated: TabEvent<(info: { tabId: number; windowId: number }) => void>;
		onUpdated: TabEvent<(tabId: number, change: { url?: string; status?: string }) => void>;
		onRemoved: TabEvent<(tabId: number) => void>;
	};
	scripting: {
		executeScript(details: {
			target: { tabId: number };
			world?: "MAIN" | "ISOLATED";
			func: (...args: never[]) => unknown;
			args: unknown[];
		}): Promise<Array<{ result?: unknown }>>;
	};
};

/** What the human sees before one call runs. */
export type PwExtApprovalPrompt = {
	verb: PwExtVerb;
	write: boolean;
	tabTitle: string;
	tabUrl: string;
	detail?: string;
};

export type PwExtResult =
	| { ok: true; data: PwExtResponse }
	| { ok: false; error: string };

export const PW_EXT_BLOCKED_ERROR =
	"pw --ext does not read or change browser settings pages, extension pages, or other non-web pages. Switch to a web page tab and retry.";
const STORE_HOSTS = new Set([
	"chromewebstore.google.com",
	"chrome.google.com",
	"microsoftedge.microsoft.com",
]);
export const PW_EXT_MAILBOX_ERROR =
	"pw --ext does not read or change the signed-in Proton Mail tab. Use dg-skills inbox.";
const MAX_TABS = 200;
const CANCELED: PwExtResult = {
	ok: false,
	error: "The request was canceled before it ran.",
};
const MAX_PAGE_RESULT_CHARS = 150_000;
const PAGE_RESULT_KEYS = [
	["tree", "text"],
	["detail"],
	["text"],
	["started", "entries"],
	["element"],
	["error"],
];
const ELEMENT_KEYS = ["name", "role", "tag", "text"];
const TOOL_TIMEOUT_MS = 30_000;

/** Per-request seams that need the session capability. */
export type PwExtContext = {
	fetchAsset(assetId: string): Promise<Blob>;
	deleteAsset(assetId: string): Promise<void>;
};

function pageResult(raw: unknown): PwExtPageResult {
	const fail = () => {
		throw new Error("The page returned an unexpected result.");
	};
	if (typeof raw !== "object" || raw === null) fail();
	const keys = Object.keys(raw as object).sort().join(",");
	if (!PAGE_RESULT_KEYS.some((shape) => [...shape].sort().join(",") === keys))
		fail();
	for (const [key, value] of Object.entries(raw as object)) {
		if (key === "element") {
			if (
				typeof value !== "object" ||
				value === null ||
				Object.keys(value).sort().join(",") !== ELEMENT_KEYS.join(",") ||
				Object.values(value).some((field) => typeof field !== "string")
			)
				fail();
			continue;
		}
		if (key === "started" ? typeof value !== "boolean" : key === "entries"
			? !Array.isArray(value) || value.some((entry) => typeof entry !== "string")
			: typeof value !== "string")
			fail();
	}
	if (JSON.stringify(raw).length > MAX_PAGE_RESULT_CHARS) fail();
	return raw as PwExtPageResult;
}
const JPEG_QUALITY = 70;

function allowedPage(url: string | undefined): url is string {
	if (!url || !isPwExtWebUrl(url)) return false;
	return !STORE_HOSTS.has(new URL(url).hostname);
}

function mailbox(url: string | undefined): boolean {
	try {
		return isProtonMailOrigin(new URL(url ?? "").origin);
	} catch {
		return false;
	}
}

function cap(text: string): string {
	const marker = "\n[truncated]";
	return text.length > PW_EXT_MAX_TEXT_CHARS
		? `${text.slice(0, PW_EXT_MAX_TEXT_CHARS - marker.length)}${marker}`
		: text;
}

const SECRET_PAIR =
	/\b((?:access_|refresh_|id_)?token|secret|password|passwd|api[-_]?key|session)(\s*[:=]\s*)[^\s&,;"']+/gi;

function clean(text: string): string {
	return cap(redactText(text).replace(SECRET_PAIR, "$1$2[redacted]"));
}

function shownUrl(tab: Tab): string {
	if (!allowedPage(tab.url)) return "(browser page)";
	return mailbox(tab.url) ? "(protected mailbox)" : redactText(tab.url);
}

function shownTitle(tab: Tab): string {
	if (!allowedPage(tab.url) || mailbox(tab.url)) return "";
	return redactText(tab.title ?? "");
}

function pageLines(tab: Tab): string[] {
	const title = shownTitle(tab);
	return [
		"### Page",
		`- Page URL: ${shownUrl(tab)}`,
		...(title ? [`- Page Title: ${title}`] : []),
	];
}

function sizeText(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function elementLines(element: PwExtElement): string[] {
	const name = element.name ? ` "${element.name}"` : "";
	return [
		`Element: ${element.role}${name} <${element.tag}>`,
		...(element.text && element.text !== element.name ? [`Text: ${element.text}`] : []),
	].map((line) => redactText(line));
}

function base64Of(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

function webMcpResult(raw: unknown): PwExtWebMcpResult {
	const value = raw as Record<string, unknown> | null;
	if (typeof value !== "object" || value === null)
		throw new Error("The page returned an unexpected WebMCP result.");
	if (typeof value.error === "string") return { error: value.error };
	if (!["modelContext", "modelContextTesting", "none"].includes(value.api as string))
		throw new Error("The page returned an unexpected WebMCP result.");
	if (JSON.stringify(value).length > MAX_PAGE_RESULT_CHARS)
		throw new Error("The page returned too much WebMCP data.");
	if (Array.isArray(value.tools)) {
		for (const tool of value.tools as unknown[]) {
			const entry = tool as Record<string, unknown> | null;
			if (
				typeof entry !== "object" ||
				entry === null ||
				Object.values(entry).some((field) => typeof field !== "string") ||
				typeof entry.name !== "string"
			)
				throw new Error("The page returned an unexpected WebMCP tool.");
		}
		return value as PwExtWebMcpResult;
	}
	if (typeof value.output === "string") return value as PwExtWebMcpResult;
	throw new Error("The page returned an unexpected WebMCP result.");
}

function defaultIsChromium(): boolean {
	const runtime = (
		globalThis as { browser?: { runtime?: { getBrowserInfo?: unknown } } }
	).browser?.runtime;
	return typeof runtime?.getBrowserInfo !== "function";
}

/** Runs one approved pw --ext verb against the active tab of the last focused window. */
export function createPwExtHandler({
	browserApi: api,
	approve,
	isChromium = defaultIsChromium,
}: {
	browserApi: PwExtBrowserApi;
	approve: (
		prompt: PwExtApprovalPrompt,
		timeoutMs: number,
		signal?: AbortSignal,
	) => Promise<boolean>;
	isChromium?: () => boolean;
}) {
	async function activeTab(): Promise<Tab | undefined> {
		const window = await api.windows.getLastFocused({ windowTypes: ["normal"] });
		if (window.id === undefined) return undefined;
		const [tab] = await api.tabs.query({ active: true, windowId: window.id });
		return tab;
	}

	function watchTab(tab: Tab & { id: number }) {
		let changed = false;
		const onActivated = (info: { windowId: number }) => {
			if (info.windowId === tab.windowId) changed = true;
		};
		const onUpdated = (tabId: number, change: { url?: string; status?: string }) => {
			if (tabId === tab.id && (change.url !== undefined || change.status === "loading"))
				changed = true;
		};
		const onRemoved = (tabId: number) => {
			if (tabId === tab.id) changed = true;
		};
		api.tabs.onActivated.addListener(onActivated);
		api.tabs.onUpdated.addListener(onUpdated);
		api.tabs.onRemoved.addListener(onRemoved);
		return {
			changed: () => changed,
			stop() {
				api.tabs.onActivated.removeListener(onActivated);
				api.tabs.onUpdated.removeListener(onUpdated);
				api.tabs.onRemoved.removeListener(onRemoved);
			},
		};
	}

	async function inPage(tab: Tab & { id: number }, action: PwExtPageAction) {
		const [frame] = await api.scripting.executeScript({
			target: { tabId: tab.id },
			func: pwExtPageAction,
			args: [action, tab.url as string],
		});
		return pageResult(frame?.result);
	}

	async function inMain(
		tab: Tab & { id: number },
		func: (...args: never[]) => unknown,
		args: unknown[],
	): Promise<unknown> {
		const [frame] = await api.scripting.executeScript({
			target: { tabId: tab.id },
			world: "MAIN",
			func,
			args,
		});
		return frame?.result;
	}

	async function prepare(
		request: PwExtRequest,
		tab: Tab & { id: number },
		handle: string,
	): Promise<{ detail?: string } | { error: string }> {
		switch (request.verb) {
			case "current":
				return { detail: "Read the URL and title of every open tab" };
			case "open":
				return { detail: `Open ${request.url} in a new tab` };
			case "click":
			case "fill":
			case "upload": {
				if (request.verb === "upload" && new URL(tab.url as string).protocol !== "https:")
					return { error: "pw --ext uploads files only to https pages." };
				const described = await inPage(tab, {
					kind: "describe",
					target: request.target as string,
					handle,
				});
				if ("error" in described) return { error: clean(described.error) };
				if (!("element" in described))
					return { error: "The page returned an unexpected result." };
				const element = elementLines(described.element);
				if (request.verb === "click")
					return { detail: [`Click ${request.target}`, ...element].join("\n") };
				if (request.verb === "fill")
					return {
						detail: [
							`Fill ${request.target}`,
							...element,
							`With:\n${request.value ?? ""}`,
						].join("\n"),
					};
				return {
					detail: [
						`Upload ${request.filePath}`,
						`File: ${request.fileName}, ${sizeText(request.fileSize ?? 0)}, ${request.fileType}`,
						`To: ${new URL(tab.url as string).origin}`,
						...element,
					].join("\n"),
				};
			}
			case "call": {
				const listed = webMcpResult(
					await inMain(tab, pwExtWebMcp as never, [{ kind: "tools" }, tab.url]),
				);
				if ("error" in listed) return { error: clean(listed.error) };
				const tool =
					"tools" in listed
						? listed.tools.find((candidate) => candidate.name === request.tool)
						: undefined;
				if (!tool)
					return {
						error: `No WebMCP tool named ${request.tool} on this page. Run pw --ext tools.`,
					};
				return {
					detail: [
						`Call WebMCP tool ${tool.name}`,
						`Description: ${clean(tool.description)}`,
						...(tool.annotations ? [`Hints: ${tool.annotations}`] : []),
						`Args:\n${JSON.stringify(request.args, null, 2)}`,
					].join("\n"),
				};
			}
			default:
				return {};
		}
	}

	async function listTabs(active: Tab): Promise<string> {
		const tabs = (await api.tabs.query({}))
			.filter((tab) => !tab.incognito)
			.slice(0, MAX_TABS);
		const rows = tabs.map((tab) => {
			const mark = tab.id === active.id ? "[active] " : "";
			const title = shownTitle(tab);
			return `- ${mark}${tab.id}: ${title ? `${title} — ` : ""}${shownUrl(tab)}`;
		});
		return [...pageLines(active), "### Tabs", ...rows].join("\n");
	}

	async function run(
		request: PwExtRequest,
		tab: Tab & { id: number },
		watch?: { changed(): boolean },
		context?: PwExtContext,
		handle?: string,
		signal?: AbortSignal,
	): Promise<PwExtResult> {
		const ok = (text: string, image?: string): PwExtResult => ({
			ok: true,
			data: { text: clean(text), ...(image ? { image } : {}) },
		});
		switch (request.verb) {
			case "current":
				return ok(await listTabs(tab));
			case "open": {
				const opened = await api.tabs.create({
					url: request.url as string,
					windowId: tab.windowId,
					active: true,
				});
				return ok(`### Result\nOpened ${request.url} in tab ${opened.id}`);
			}
			case "upload": {
				if (!context) return { ok: false, error: "Upload needs a paired session." };
				let blob: Blob;
				try {
					blob = await context.fetchAsset(request.assetId as string);
				} finally {
					await context.deleteAsset(request.assetId as string).catch(() => {});
				}
				if (signal?.aborted) return CANCELED;
				if (blob.size !== request.fileSize)
					return {
						ok: false,
						error: "The staged file size does not match the approved size; nothing was uploaded.",
					};
				const base64 = base64Of(new Uint8Array(await blob.arrayBuffer()));
				if (signal?.aborted) return CANCELED;
				const result = await inPage(tab, {
					kind: "upload",
					target: request.target as string,
					base64,
					fileName: request.fileName as string,
					fileType: request.fileType as string,
					handle,
				});
				if ("error" in result) return { ok: false, error: clean(result.error) };
				if (!("detail" in result))
					return { ok: false, error: "The page returned an unexpected result." };
				return ok([`### Result`, result.detail, ...pageLines(tab)].join("\n"));
			}
			case "tools": {
				const listed = webMcpResult(
					await inMain(tab, pwExtWebMcp as never, [{ kind: "tools" }, tab.url]),
				);
				if ("error" in listed) return { ok: false, error: clean(listed.error) };
				if (!("tools" in listed) || listed.tools.length === 0)
					return ok(
						[...pageLines(tab), "### WebMCP tools", "This page exposes no WebMCP tools."].join("\n"),
					);
				const rows = listed.tools.flatMap((tool) => [
					`- ${tool.name}: ${tool.description}`,
					...(tool.inputSchema ? [`  input: ${tool.inputSchema}`] : []),
					...(tool.annotations ? [`  hints: ${tool.annotations}`] : []),
				]);
				return ok(
					[...pageLines(tab), `### WebMCP tools (${listed.api})`, ...rows].join("\n"),
				);
			}
			case "call": {
				const called = webMcpResult(
					await inMain(tab, pwExtWebMcp as never, [
						{
							kind: "call",
							tool: request.tool,
							args: request.args,
							timeoutMs: TOOL_TIMEOUT_MS,
						},
						tab.url,
					]),
				);
				if ("error" in called) return { ok: false, error: clean(called.error) };
				if (!("output" in called))
					return { ok: false, error: "The page returned an unexpected WebMCP result." };
				return ok(
					[`### Result`, `WebMCP tool ${request.tool} returned:`, called.output, ...pageLines(tab)].join("\n"),
				);
			}
			case "screenshot": {
				const captured = await api.tabs.captureVisibleTab(tab.windowId as number, {
					format: "jpeg",
					quality: JPEG_QUALITY,
				});
				const after = await api.tabs.get(tab.id);
				const [shown] = await api.tabs.query({
					active: true,
					windowId: tab.windowId,
				});
				if (
					watch?.changed() ||
					after.url !== tab.url ||
					after.active === false ||
					shown?.id !== tab.id
				)
					return {
						ok: false,
						error: "The tab changed during the screenshot; it was discarded.",
					};
				const fitted = await fitPreviewDataUrl(captured);
				if (!fitted.dataUrl)
					return { ok: false, error: `Screenshot failed: ${fitted.reason}.` };
				return ok(pageLines(tab).join("\n"), fitted.dataUrl);
			}
			default: {
				const action: PwExtPageAction =
					request.verb === "click"
						? { kind: "click", target: request.target as string, handle }
						: request.verb === "fill"
							? {
									kind: "fill",
									target: request.target as string,
									value: request.value as string,
									handle,
								}
							: { kind: request.verb };
				const result = await inPage(tab, action);
				if ("error" in result) return { ok: false, error: clean(result.error) };
				if ("tree" in result)
					return ok(
						[
							...pageLines(tab),
							"### Snapshot",
							result.tree,
							"### Visible text",
							result.text,
						].join("\n"),
					);
				if ("detail" in result)
					return ok([`### Result`, result.detail, ...pageLines(tab)].join("\n"));
				if ("entries" in result) {
					const hooked = (await inMain(tab, pwExtConsoleHook as never, [tab.url])) as
						| { entries?: unknown }
						| undefined;
					const warnings = Array.isArray(hooked?.entries)
						? (hooked.entries as unknown[])
								.filter((entry): entry is string => typeof entry === "string")
								.slice(-50)
								.map((entry) => (entry.length > 500 ? `${entry.slice(0, 500)}…` : entry))
						: [];
					const entries = [...result.entries, ...warnings];
					return ok(
						[
							...pageLines(tab),
							"### Console",
							result.started
								? "Capture started on this tab. Errors and console warnings from now on show on the next console call."
								: entries.length
									? entries.join("\n")
									: "No errors or warnings since capture started.",
						].join("\n"),
					);
				}
				if (!("text" in result))
					return { ok: false, error: "The page returned an unexpected result." };
				return ok([...pageLines(tab), "### Selection", result.text].join("\n"));
			}
		}
	}

	return async (
		raw: PwExtRequest,
		timeoutMs: number,
		signal?: AbortSignal,
		context?: PwExtContext,
	): Promise<PwExtResult> => {
		let request: PwExtRequest;
		try {
			request = validatePwExtRequest(raw);
		} catch {
			return { ok: false, error: "Unsupported pw --ext request." };
		}
		if (!isChromium())
			return {
				ok: false,
				error: "pw --ext works only in Chromium-family browsers (Chrome, Edge, Brave, Vivaldi).",
			};
		try {
			const tab = await activeTab();
			if (!tab || tab.id === undefined || tab.incognito)
				return {
					ok: false,
					error: "No active tab in a normal, non-private browser window.",
				};
			const scoped = request.verb !== "current" && request.verb !== "open";
			if (scoped && !allowedPage(tab.url))
				return { ok: false, error: PW_EXT_BLOCKED_ERROR };
			if (scoped && mailbox(tab.url))
				return { ok: false, error: PW_EXT_MAILBOX_ERROR };
			const handle = crypto.randomUUID();
			const prepared = await prepare(request, { ...tab, id: tab.id }, handle);
			if ("error" in prepared) return { ok: false, error: prepared.error };
			if (signal?.aborted) return CANCELED;
			const approved = await approve(
				{
					verb: request.verb,
					write: isPwExtWriteVerb(request.verb),
					tabTitle: shownTitle(tab),
					tabUrl: shownUrl(tab),
					...(prepared.detail ? { detail: prepared.detail } : {}),
				},
				timeoutMs,
				signal,
			);
			if (signal?.aborted) return CANCELED;
			if (!approved)
				return { ok: false, error: "The request was denied in the browser." };
			const target = { ...tab, id: tab.id };
			const watch = request.verb === "screenshot" ? watchTab(target) : undefined;
			try {
				if (scoped) {
					const now = await api.tabs.get(tab.id);
					if (now.url !== tab.url || now.active === false)
						return {
							ok: false,
							error: "The tab changed after approval; nothing was done. Retry.",
						};
				}
				if (signal?.aborted) return CANCELED;
				return await run(request, target, watch, context, handle, signal);
			} finally {
				watch?.stop();
			}
		} catch (error) {
			return {
				ok: false,
				error: clean(
					`pw --ext failed in the browser: ${error instanceof Error ? error.message : String(error)}`,
				).slice(0, 2048),
			};
		}
	};
}
