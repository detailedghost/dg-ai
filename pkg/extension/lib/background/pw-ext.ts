import {
	PW_EXT_MAX_TEXT_CHARS,
	type PW_EXT_RELAY,
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
	type PwExtPageAction,
	type PwExtPageResult,
	pwExtPageAction,
} from "@/lib/features/pw-ext-page";
import {
	AgentGroupFullError,
	type AgentTab,
	type AgentTabs,
	type AgentTabsBrowserApi,
	type AgentTabsStorage,
	type BrowserTab,
	createAgentTabs,
	MAX_AGENT_TABS,
} from "./agent-tabs";
import { fitPreviewDataUrl } from "./proto";
import type { RelayHandler } from "./relay-dispatch";
import {
	allowedPage,
	mailbox,
	PW_EXT_BLOCKED_ERROR,
	PW_EXT_MAILBOX_ERROR,
	PW_EXT_PRIVATE_ERROR,
} from "./tab-guards";

type LiveTab = BrowserTab & { id: number };

type TabEvent<T> = {
	addListener(listener: T): void;
	removeListener(listener: T): void;
};

/** Promise-based Chromium MV3 surface the handler needs. */
export type PwExtBrowserApi = AgentTabsBrowserApi & {
	windows: {
		update(
			windowId: number,
			props: { focused: boolean; state?: "normal" },
		): Promise<unknown>;
	};
	tabs: {
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
	storage: AgentTabsStorage;
};

export type PwExtResult =
	| { ok: true; data: PwExtResponse }
	| { ok: false; error: string };

const NEW_TAB_URL = "chrome://newtab/";
const CANCELED: PwExtResult = {
	ok: false,
	error: "The request was canceled before it ran.",
};
const NO_SESSION = "pw --ext needs a paired session.";
const NO_TAB = "This agent has no tab yet. Run pw --ext new <url> first.";
const SELECTED_GONE =
	"This agent's selected tab was closed or moved out of its group. Run pw --ext tabs, then pw --ext select <id>.";
const GROUP_FULL = `This agent's tab group is full (${MAX_AGENT_TABS} tabs). Close some with pw --ext close <id>.`;
const notInGroup = (tabId: number) =>
	`pw --ext: tab ${tabId} is not in this agent's tab group; run pw --ext tabs to list them.`;
const discardedTab = (tabId: number) =>
	`This agent's tab was discarded by the browser. Run pw --ext select ${tabId} again after it reloads.`;

const PAGE_VERBS = [
	"snapshot",
	"click",
	"fill",
	"upload",
	"selection",
	"console",
	"tools",
	"call",
] as const satisfies readonly PwExtVerb[];
const BLOCKS_BROWSER_PAGE: ReadonlySet<PwExtVerb> = new Set([
	...PAGE_VERBS,
	"current",
	"screenshot",
	"select",
]);
const BLOCKS_MAILBOX: ReadonlySet<PwExtVerb> = new Set([
	...PAGE_VERBS,
	"screenshot",
	"close",
	"open",
]);
const NEEDS_LOADED_TAB: ReadonlySet<PwExtVerb> = new Set([
	...PAGE_VERBS,
	"screenshot",
]);

type TabVerbRequest = PwExtRequest & {
	verb: Exclude<PwExtVerb, "tabs" | "new">;
};

function isTabVerb(request: PwExtRequest): request is TabVerbRequest {
	return request.verb !== "tabs" && request.verb !== "new";
}

class Refusal extends Error {}

const MAX_PAGE_RESULT_CHARS = 150_000;
const PAGE_RESULT_KEYS = [
	["tree", "text"],
	["detail"],
	["text"],
	["started", "entries"],
	["element"],
	["error"],
];
const ELEMENT_KEYS = ["href", "name", "role", "tag", "text"];
const TOOL_TIMEOUT_MS = 30_000;

/** Per-request seams that need the session capability. */
export type PwExtContext = {
	sessionId: string;
	agentIdentity: string;
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

function shownUrl(tab: Pick<BrowserTab, "url">): string {
	if (!allowedPage(tab.url)) return "(browser page)";
	return mailbox(tab.url) ? "(protected mailbox)" : redactText(tab.url);
}

function shownTitle(tab: Pick<BrowserTab, "url" | "title">): string {
	if (!allowedPage(tab.url) || mailbox(tab.url)) return "";
	return redactText(tab.title ?? "");
}

function pageLines(tab: Pick<BrowserTab, "url" | "title">): string[] {
	const title = shownTitle(tab);
	return [
		"### Page",
		`- Page URL: ${shownUrl(tab)}`,
		...(title ? [`- Page Title: ${title}`] : []),
	];
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

function nextFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Runs one pw --ext verb against the agent's own tab group. */
export function createPwExtHandler({
	browserApi: api,
	agentTabs = createAgentTabs({ browserApi: api, storage: api.storage }),
	isChromium = defaultIsChromium,
}: {
	browserApi: PwExtBrowserApi;
	agentTabs?: AgentTabs;
	isChromium?: () => boolean;
}) {
	const ok = (text: string, image?: string): PwExtResult => ({
		ok: true,
		data: { text: clean(text), ...(image ? { image } : {}) },
	});

	function watchTab(tab: LiveTab) {
		let changed = false;
		const onActivated = (info: { tabId: number; windowId: number }) => {
			if (info.windowId === tab.windowId && info.tabId !== tab.id) changed = true;
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

	async function inPage(tab: LiveTab, action: PwExtPageAction) {
		const [frame] = await api.scripting.executeScript({
			target: { tabId: tab.id },
			func: pwExtPageAction,
			args: [action, tab.url as string],
		});
		return pageResult(frame?.result);
	}

	async function inMain(
		tab: LiveTab,
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

	function tabListing(rows: readonly AgentTab[]): string {
		const lines = rows.slice(0, MAX_AGENT_TABS).map((row) => {
			const title = shownTitle(row);
			return `- ${row.selected ? "[selected] " : ""}${row.tabId}: ${title ? `${title} — ` : ""}${shownUrl(row)}`;
		});
		const hidden = rows.length - MAX_AGENT_TABS;
		return ["### Tabs", ...lines, ...(hidden > 0 ? [`- … ${hidden} more`] : [])].join(
			"\n",
		);
	}

	async function liveTab(tabId: number): Promise<LiveTab> {
		return { ...(await api.tabs.get(tabId)), id: tabId };
	}

	async function resolveTab(
		request: PwExtRequest,
		sessionId: string,
	): Promise<LiveTab | undefined> {
		if (request.tabId !== undefined) {
			if (!(await agentTabs.owns({ sessionId, tabId: request.tabId })))
				throw new Refusal(notInGroup(request.tabId));
			return liveTab(request.tabId);
		}
		const selected = await agentTabs.selected({ sessionId });
		return selected ? liveTab(selected.tabId) : undefined;
	}

	function guard(verb: PwExtVerb, tab: LiveTab): void {
		if (tab.incognito) throw new Refusal(PW_EXT_PRIVATE_ERROR);
		if (BLOCKS_BROWSER_PAGE.has(verb) && !allowedPage(tab.url))
			throw new Refusal(PW_EXT_BLOCKED_ERROR);
		if (BLOCKS_MAILBOX.has(verb) && mailbox(tab.url))
			throw new Refusal(PW_EXT_MAILBOX_ERROR);
		if (NEEDS_LOADED_TAB.has(verb) && tab.discarded)
			throw new Refusal(discardedTab(tab.id));
	}

	async function openInGroup(
		url: string,
		{ sessionId, agentIdentity }: PwExtContext,
	): Promise<PwExtResult> {
		const { tabId } = await agentTabs
			.open({ sessionId, agentIdentity, url })
			.catch((error: unknown) => {
				throw error instanceof AgentGroupFullError ? new Refusal(GROUP_FULL) : error;
			});
		await agentTabs.select({ sessionId, tabId });
		return ok(`### Result\nOpened ${url} in tab ${tabId}`);
	}

	async function run(
		request: TabVerbRequest,
		tab: LiveTab,
		context: PwExtContext,
		signal: AbortSignal | undefined,
	): Promise<PwExtResult> {
		switch (request.verb) {
			case "current":
				return ok(pageLines(tab).join("\n"));
			case "open": {
				await api.tabs.update(tab.id, { url: request.url as string });
				return ok(`### Result\nOpened ${request.url} in tab ${tab.id}`);
			}
			case "select": {
				await agentTabs.select({ sessionId: context.sessionId, tabId: tab.id });
				return ok(`### Result\nSelected tab ${tab.id}`);
			}
			case "close": {
				const { selectedTabId } = await agentTabs.close({
					sessionId: context.sessionId,
					tabId: tab.id,
				});
				return ok(
					[
						"### Result",
						`Closed tab ${tab.id}`,
						...(selectedTabId === undefined ? [] : [`Selected tab ${selectedTabId}`]),
					].join("\n"),
				);
			}
			case "upload": {
				if (new URL(tab.url as string).protocol !== "https:")
					return { ok: false, error: "pw --ext uploads files only to https pages." };
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
						error: "The staged file size does not match the declared size; nothing was uploaded.",
					};
				const base64 = base64Of(new Uint8Array(await blob.arrayBuffer()));
				if (signal?.aborted) return CANCELED;
				const result = await inPage(tab, {
					kind: "upload",
					target: request.target as string,
					base64,
					fileName: request.fileName as string,
					fileType: request.fileType as string,
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
				const windowId = tab.windowId as number;
				await api.tabs.update(tab.id, { active: true });
				const { state } = await api.windows.get(windowId);
				await api.windows.update(windowId, {
					focused: true,
					...(state === "minimized" ? { state: "normal" as const } : {}),
				});
				await api.scripting.executeScript({
					target: { tabId: tab.id },
					func: nextFrame,
					args: [],
				});
				const watch = watchTab(tab);
				let captured: string;
				try {
					captured = await api.tabs.captureVisibleTab(windowId, {
						format: "jpeg",
						quality: JPEG_QUALITY,
					});
					const after = await api.tabs.get(tab.id);
					const [shown] = await api.tabs.query({ active: true, windowId });
					if (
						watch.changed() ||
						after.url !== tab.url ||
						after.active === false ||
						shown?.id !== tab.id
					)
						return {
							ok: false,
							error: "The tab changed during the screenshot; it was discarded.",
						};
				} finally {
					watch.stop();
				}
				const fitted = await fitPreviewDataUrl(captured);
				if (!fitted.dataUrl)
					return { ok: false, error: `Screenshot failed: ${fitted.reason}.` };
				return ok(pageLines(tab).join("\n"), fitted.dataUrl);
			}
			default: {
				const action: PwExtPageAction =
					request.verb === "click"
						? { kind: "click", target: request.target as string }
						: request.verb === "fill"
							? {
									kind: "fill",
									target: request.target as string,
									value: request.value as string,
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

	async function execute(
		request: PwExtRequest,
		context: PwExtContext,
		signal: AbortSignal | undefined,
	): Promise<PwExtResult> {
		if (signal?.aborted) return CANCELED;
		if (request.verb === "new")
			return openInGroup(request.url ?? NEW_TAB_URL, context);
		if (!isTabVerb(request)) {
			const rows = await agentTabs.list({ sessionId: context.sessionId });
			if (!rows.length) throw new Refusal(NO_TAB);
			return ok(tabListing(rows));
		}
		const tab = await resolveTab(request, context.sessionId);
		if (!tab) {
			const rows = await agentTabs.list({ sessionId: context.sessionId });
			if (rows.length) throw new Refusal(SELECTED_GONE);
			if (request.verb === "open") return openInGroup(request.url as string, context);
			throw new Refusal(NO_TAB);
		}
		guard(request.verb, tab);
		return run(request, tab, context, signal);
	}

	return async ({
		request: raw,
		signal,
		context,
	}: Parameters<RelayHandler<typeof PW_EXT_RELAY>>[0]): Promise<PwExtResult> => {
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
		if (!context?.sessionId) return { ok: false, error: NO_SESSION };
		try {
			return await execute(request, context, signal);
		} catch (error) {
			if (error instanceof Refusal) return { ok: false, error: error.message };
			return {
				ok: false,
				error: clean(
					`pw --ext failed in the browser: ${error instanceof Error ? error.message : String(error)}`,
				).slice(0, 2048),
			};
		}
	};
}
