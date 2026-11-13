import {
	PW_EXT_NO_TAB_ERROR as NO_TAB,
	approvalClassOf,
	BUILT_IN_SCRIPTS,
	isDgToolName,
	isPwExtWebUrl,
	mailboxToolAllowed,
	isPwExtSecretTooShort,
	PW_EXT_MAX_TEXT_CHARS,
	PW_EXT_MIN_SECRET_CHARS,
	PW_EXT_UNMASK_DEFAULT_MINUTES,
	type PW_EXT_RELAY,
	type PwExtRequest,
	type PwExtResponse,
	type PwExtTool,
	type PwExtVerb,
	redactLiterals,
	redactSecrets,
	redactText,
	validatePwExtRequest,
} from "@dg/common";
import {
	type PwExtDialogAction,
	type PwExtDialogRecord,
	type PwExtDialogState,
	pwExtDialogs,
} from "@/lib/features/pw-ext-dialog-main";
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
	AgentTabOpenCanceledError,
	agentSessionOfGroup,
	type AgentTab,
	type AgentTabs,
	type AgentTabsBrowserApi,
	type AgentTabsLock,
	type AgentTabsStorage,
	type BrowserTab,
	createAgentTabs,
	groupTitle,
	MAX_AGENT_TABS,
} from "./agent-tabs";
import { defaultIsChromium } from "@/lib/browser-call";
import { type ApprovalAnswer, type Approvals, browserApprovals } from "./approval";
import { forgetAgentTabsAndShims, forgetDialogShim, syncDialogShim } from "./dialog-shim";
import { createSessionControl, type SessionControl } from "./session-control";
import { fitPreviewDataUrl } from "./proto";
import type { RelayHandler } from "./relay-dispatch";
import { siteOf } from "./site-key";
import {
	createRememberedWebMcpGrants,
	createWebMcpGrants,
	type RememberedWebMcpGrants,
	type RememberStorage,
	requestWebMcpApproval,
	type WebMcpGrants,
} from "./webmcp-approval";
import { createWebMcpSigner } from "./webmcp-signing";
import { createUnmaskGrants, MAX_FILLED_SECRETS, type UnmaskGrant, type UnmaskGrants } from "./unmask-grants";
import {
	allowedPage,
	mailbox,
	PW_EXT_BLOCKED_ERROR,
	PW_EXT_MAILBOX_ERROR,
	PW_EXT_PRIVATE_ERROR,
} from "./tab-guards";

type LiveTab = BrowserTab & { id: number; signal?: AbortSignal };
const STOPPED_WORK = "The request was canceled before it ran.";

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
		onUpdated: TabEvent<(tabId: number, change: { url?: string; status?: string; groupId?: number }) => void>;
		onRemoved: TabEvent<(tabId: number) => void>;
	};
	scripting: {
		executeScript(details: {
			target: { tabId: number };
			world?: "MAIN" | "ISOLATED";
			injectImmediately?: boolean;
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
const STOPPED: PwExtResult = {
	ok: false,
	error:
		"The person clicked Stop in the browser. This dg session no longer controls the browser; start a new dg session to drive it again.",
};
const SITE_REFUSED = {
	deny: "The user clicked Deny in the browser",
	closed: "The approval window was closed without an answer",
	timeout: "No answer in the browser within 60 seconds",
	unopened: "The approval window could not open",
} satisfies Record<Exclude<ApprovalAnswer, "allow">, string>;
const NO_SITE_ASK: ReadonlySet<PwExtVerb> = new Set(["tabs", "select", "close", "tools", "call"]);
const UNMASK_REFUSED = {
	deny: "The user clicked Deny in the browser; nothing was unmasked.",
	closed: "The approval window was closed without an answer; nothing was unmasked.",
	timeout: "No answer in the browser within 60 seconds; nothing was unmasked.",
	unopened: "The approval window could not open; nothing was unmasked.",
} satisfies Record<Exclude<ApprovalAnswer, "allow">, string>;
const SECRET_TOO_SHORT = `pw --ext fills a secret of at least ${PW_EXT_MIN_SECRET_CHARS} characters only.`;
const SECRETS_FULL = `This session already filled ${MAX_FILLED_SECRETS} secret values; start a new dg session to fill more.`;
const UNMASK_ENDED = "The unmask ended before the fill ran; nothing was filled. Run pw --ext unmask again.";
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
	"count",
	"fill",
	"upload",
	"selection",
	"console",
	"tools",
	"call",
	"dialog",
] as const satisfies readonly PwExtVerb[];
const BLOCKS_BROWSER_PAGE: ReadonlySet<PwExtVerb> = new Set([
	...PAGE_VERBS,
	"current",
	"screenshot",
	"select",
	"unmask",
]);
const BLOCKS_MAILBOX: ReadonlySet<PwExtVerb> = new Set([
	...PAGE_VERBS,
	"screenshot",
	"close",
	"open",
	"unmask",
]);
const NEEDS_LOADED_TAB: ReadonlySet<PwExtVerb> = new Set([
	...PAGE_VERBS,
	"screenshot",
]);

type TabVerbRequest = PwExtRequest & {
	verb: Exclude<PwExtVerb, "tabs" | "new">;
};

const BUILT_INS_KEY = "webmcpScripts";

async function storedEnabledBuiltIns(storage: unknown): Promise<Set<string>> {
	const local = (storage as { local?: { get(key: string): Promise<Record<string, unknown>> } }).local;
	if (!local) return new Set();
	const stored = (await local.get(BUILT_INS_KEY))[BUILT_INS_KEY];
	const records = Array.isArray(stored) ? (stored as { id?: unknown; source?: unknown; enabled?: unknown }[]) : [];
	return new Set(
		BUILT_IN_SCRIPTS.filter((script) => {
			const record = records.find((entry) => entry?.id === script.id && entry.source === "built-in");
			return typeof record?.enabled === "boolean" ? record.enabled : script.enabledByDefault;
		}).map((script) => script.id),
	);
}

function isTabVerb(request: PwExtRequest): request is TabVerbRequest {
	return request.verb !== "tabs" && request.verb !== "new";
}

class Refusal extends Error {}

/** A page failure; the handler masks it again with the held secrets of the moment. */
class PageError extends Error {}

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
const PAGE_DEADLINE_MS = 15_000;
const pageStuck = (seconds: number) =>
	`The page did not answer within ${seconds} seconds. It may show a dialog that pw --ext could not catch, for example one that opened while the page loaded. Close it in the browser, then retry.`;
const DIALOG_TEXT_SECRET =
	"pw --ext dialog --text holds a value that this session filled as a secret; the page could read it. Nothing was set.";
const DIALOG_TYPES = ["alert", "confirm", "prompt"];
const DIALOG_ANSWERS = ["accept", "dismiss"];

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

const SECRET_PAIR = {
	pattern: /\b((?:access_|refresh_|id_)?token|secret|password|passwd|api[-_]?key|session)(\s*[:=]\s*)[^\s&,;"']+/gi,
	replacement: "$1$2[redacted]",
};

const NAMED_SECRET = {
	pattern: /((?:password|passwd|secret|token|api[-_]?key|session)\s*[:=]\s*)[^\s&,;"']+/gi,
	replacement: "$1[redacted]",
};

const UNSIGNED_JWT = {
	pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g,
	replacement: "[redacted]",
};

/** Redacts page output; an unmask grant leaves email addresses, and a secret fill value is always removed. */
function mask(text: string, { unmasked = false, secrets = [] }: { unmasked?: boolean; secrets?: string[] } = {}): string {
	const redact = unmasked ? redactSecrets : redactText;
	return redactLiterals(
		redact(text, [], { literals: secrets, extraPatterns: [SECRET_PAIR, NAMED_SECRET, UNSIGNED_JWT] }),
		secrets,
	);
}

function clean(text: string, options: { unmasked?: boolean; secrets?: string[] } = {}): string {
	return cap(mask(text, options));
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

const CONSOLE_ENTRIES = 50;
const RAW_ENTRY_MAX = 2000;
const RAW_ERROR_MAX = 2000;
const ENTRY_MAX = 500;
const TOOL_OUTPUT_MAX = 50_000;
const RAW_OUTPUT_MAX = 100_000;

/** Masks raw MAIN-world text cut at rawMax; the word at the cut is masked too, as a partial token may not match. */
function maskRaw(raw: string, rawMax: number, options: { unmasked: boolean; secrets: string[] }): string {
	const masked = mask(clip(raw, rawMax), options);
	if (!masked.endsWith("…") || (raw.length <= rawMax && !raw.endsWith("…"))) return masked;
	let start = masked.length - 1;
	while (start > 0 && !/\s/.test(masked[start - 1] as string)) start--;
	return `${masked.slice(0, start)}[redacted]…`;
}

/** Masks raw MAIN-world console entries before it shortens them, so a cut cannot split a held secret. */
function consoleWarnings(raw: unknown, options: { unmasked: boolean; secrets: string[] }): string[] {
	const entries = (raw as { entries?: unknown } | null | undefined)?.entries;
	if (!Array.isArray(entries)) return [];
	return entries
		.slice(-CONSOLE_ENTRIES)
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => clip(maskRaw(entry, RAW_ENTRY_MAX, options).replace(/\s+/g, " "), ENTRY_MAX));
}

function wholeJson(raw: string | undefined, max: number, options: { unmasked: boolean; secrets: string[] }): string | undefined {
	if (raw === undefined) return undefined;
	const out = mask(raw, options);
	if (out.length > max) return undefined;
	try {
		JSON.parse(out);
		return out;
	} catch {
		return undefined;
	}
}

/** Masks raw MAIN-world tool text, then bounds each field. */
function boundTools(tools: PwExtTool[], options: { unmasked: boolean; secrets: string[] }): PwExtTool[] {
	return tools.map((tool) => {
		const entry: PwExtTool = {
			name: clip(maskRaw(tool.name, 256, options), 128),
			description: clip(maskRaw(tool.description, 2000, options), 1000),
		};
		if (tool.title !== undefined) entry.title = clip(maskRaw(tool.title, 400, options), 200);
		const schema = wholeJson(tool.inputSchema, 4000, options);
		if (schema) entry.inputSchema = schema;
		const annotations = wholeJson(tool.annotations, 500, options);
		if (annotations) entry.annotations = annotations;
		return entry;
	});
}

const clock = (at: number) => new Date(at).toTimeString().slice(0, 5);

function unmaskLine(grant: UnmaskGrant): string {
	return `### Unmask
unmasked on ${grant.origin} until ${clock(grant.until)} (approved in the browser)`;
}

function shownUrl(tab: Pick<BrowserTab, "url">, unmasked = false, secrets: string[] = []): string {
	if (!allowedPage(tab.url)) return "(browser page)";
	if (mailbox(tab.url)) return "(protected mailbox)";
	return mask(tab.url as string, { unmasked, secrets });
}

function shownTitle(tab: Pick<BrowserTab, "url" | "title">, unmasked = false, secrets: string[] = []): string {
	if (!allowedPage(tab.url) || mailbox(tab.url)) return "";
	return mask(tab.title ?? "", { unmasked, secrets });
}

function pageLines(tab: Pick<BrowserTab, "url" | "title">, unmasked = false, secrets: string[] = []): string[] {
	const title = shownTitle(tab, unmasked, secrets);
	return [
		"### Page",
		`- Page URL: ${shownUrl(tab, unmasked, secrets)}`,
		...(title ? [`- Page Title: ${title}`] : []),
	];
}

function base64Of(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

function withTools(result: PwExtResult, tools: PwExtTool[]): PwExtResult {
	return result.ok ? { ok: true, data: { ...result.data, tools } } : result;
}

function mapTools(tools: PwExtTool[], transform: (value: string) => string): PwExtTool[] {
	return tools.map(
		(tool) => Object.fromEntries(Object.entries(tool).map(([key, value]) => [key, transform(value)])) as PwExtTool,
	);
}

const MAILBOX_TOOL_FAILED = "The WebMCP tool failed on the protected mailbox tab.";

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

const BAD_DIALOG = "The page returned an unexpected dialog result.";

function dialogState(raw: unknown): PwExtDialogState | { error: string } {
	const fail = () => {
		throw new Refusal(BAD_DIALOG);
	};
	const value = raw as { dialogs?: unknown; pending?: unknown; error?: unknown } | null;
	if (typeof value !== "object" || value === null) fail();
	const state = value as { dialogs?: unknown; pending?: unknown; error?: unknown };
	if (typeof state.error === "string") return { error: state.error };
	if (!Array.isArray(state.dialogs) || state.dialogs.length > 10) fail();
	for (const entry of state.dialogs as unknown[]) {
		const dialog = entry as Record<string, unknown> | null;
		if (
			typeof dialog !== "object" ||
			dialog === null ||
			!DIALOG_TYPES.includes(dialog.type as string) ||
			typeof dialog.message !== "string" ||
			(dialog.defaultValue !== undefined && typeof dialog.defaultValue !== "string") ||
			!DIALOG_ANSWERS.includes(dialog.answer as string) ||
			(dialog.by !== "policy" && dialog.by !== "default") ||
			typeof dialog.seen !== "boolean" ||
			typeof dialog.at !== "number"
		)
			fail();
	}
	const pending = state.pending as { answer?: unknown; withText?: unknown } | undefined;
	if (
		pending !== undefined &&
		(typeof pending !== "object" ||
			pending === null ||
			!DIALOG_ANSWERS.includes(pending.answer as string) ||
			typeof pending.withText !== "boolean")
	)
		fail();
	return state as PwExtDialogState;
}

function dialogLine(dialog: PwExtDialogRecord, options: { unmasked: boolean; secrets: string[] }): string {
	const quoted = (text: string) => `"${maskRaw(text, RAW_ENTRY_MAX, options).replace(/\s+/g, " ")}"`;
	const given = dialog.defaultValue === undefined ? "" : ` (default ${quoted(dialog.defaultValue)})`;
	const how = dialog.by === "policy" ? "by your answer" : "by default";
	return `${dialog.type} ${quoted(dialog.message)}${given}, ${dialog.answer === "accept" ? "accepted" : "dismissed"} ${how}`;
}

function dialogNotice(
	state: PwExtDialogState | undefined,
	options: { unmasked: boolean; secrets: string[] },
): string[] {
	if (!state) return [];
	const fresh = state.dialogs.filter((dialog) => !dialog.seen).map((dialog) => `- ${dialogLine(dialog, options)}`);
	const lines = [...fresh, ...pendingLine(state)];
	return lines.length ? ["### Dialog", ...lines] : [];
}

function pendingLine(state: PwExtDialogState): string[] {
	return state.pending ? [`- next: ${state.pending.answer}${state.pending.withText ? ", with your text" : ""}`] : [];
}

function nextFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Runs one pw --ext verb against the agent's own tab group. */
export function createPwExtHandler({
	browserApi: api,
	agentTabs = createAgentTabs({ browserApi: api, storage: api.storage }),
	isChromium = defaultIsChromium,
	approvals,
	now = Date.now,
	grants = createUnmaskGrants({ storage: api.storage, now }),
	webmcpGrants = createWebMcpGrants({ storage: api.storage }),
	rememberedWebMcpGrants = createRememberedWebMcpGrants({
		storage: api.storage as unknown as RememberStorage,
		signer: createWebMcpSigner(),
		now,
	}),
	enabledBuiltIns = () => storedEnabledBuiltIns(api.storage),
	pageDeadlineMs = PAGE_DEADLINE_MS,
	lock,
	control = createSessionControl({ storage: api.storage }),
}: {
	browserApi: PwExtBrowserApi;
	agentTabs?: AgentTabs;
	isChromium?: () => boolean;
	approvals?: Pick<Approvals, "request" | "ask">;
	now?: () => number;
	grants?: UnmaskGrants;
	webmcpGrants?: WebMcpGrants;
	rememberedWebMcpGrants?: RememberedWebMcpGrants;
	enabledBuiltIns?: () => Promise<Set<string>>;
	pageDeadlineMs?: number;
	lock?: AgentTabsLock;
	control?: SessionControl;
}) {
	type Running = { controller: AbortController; stopped(): void };
	const live = new Map<string, Set<Running>>();
	const halted = new Set<string>();
	const isStopped = async (sessionId: string) => halted.has(sessionId) || (await control.stopped(sessionId));
	const asking = new Map<string, Promise<ApprovalAnswer>>();
	const deniedThrough = new Map<string, number>();
	let verbs = 0;

	/** Asks the person once per registrable domain and session before the agent reads or changes a page there. */
	async function allowSite(url: string | undefined, context: PwExtContext, signal: AbortSignal, verb: number): Promise<void> {
		if (!url || !isPwExtWebUrl(url)) return;
		const site = siteOf(url);
		const named = site.grouped ? `${site.name} and its subdomains` : site.name;
		if (await control.allowed(context.sessionId, site.key)) return;
		const key = `${context.sessionId}\n${site.key}`;
		if ((deniedThrough.get(key) ?? 0) >= verb)
			throw new Refusal(`${SITE_REFUSED.deny}; the agent may not use ${named}. Nothing ran.`);
		let pending = asking.get(key);
		if (!pending) {
			const { origin, host } = new URL(url);
			pending = (async () => {
				const answer = await (approvals ?? browserApprovals()).request({
					title: `Allow the agent on ${named} for this session?`,
					origin,
					lines: [
						`Host: ${host}`,
						`Agent: ${context.agentIdentity}`,
						`Tab group: ${groupTitle(context)}`,
						`The agent can read and change pages on ${named}, in its own tab group only.`,
						"Until this dg session ends, or until you click Stop on the page.",
					],
				});
				if (answer === "deny") deniedThrough.set(key, verbs);
				if (answer === "allow" && !signal.aborted) await control.allow(context.sessionId, site.key);
				return answer;
			})();
			asking.set(key, pending);
			void pending.finally(() => asking.delete(key)).catch(() => undefined);
		}
		const answer = await pending;
		if (signal.aborted) throw new Refusal("The request was canceled before it ran.");
		if (answer !== "allow") throw new Refusal(`${SITE_REFUSED[answer]}; the agent may not use ${named}. Nothing ran.`);
		await control.allow(context.sessionId, site.key);
	}

	/** Ends a session's control at once: verbs in flight end, unmask grants and sites go, and its tabs return to the person; Web MCP grants stay. */
	async function stop(sessionId: string): Promise<void> {
		halted.add(sessionId);
		for (const run of live.get(sessionId) ?? []) {
			run.controller.abort();
			run.stopped();
		}
		await control.stop(sessionId);
		for (const key of deniedThrough.keys()) if (key.startsWith(`${sessionId}\n`)) deniedThrough.delete(key);
		await Promise.allSettled([
			grants.forget(sessionId),
			forgetAgentTabsAndShims({ browserApi: api, storage: api.storage, agentTabs, sessionId, ...(lock ? { lock } : {}) }),
		]);
	}

	/** Stops the session whose agent group holds this tab; a tab of no agent group stops nothing. */
	async function stopTab(tabId: number): Promise<void> {
		const tab = await api.tabs.get(tabId);
		if (tab.groupId === undefined || tab.groupId < 0) return;
		const sessionId = await agentSessionOfGroup({ storage: api.storage, groupId: tab.groupId });
		if (sessionId) await stop(sessionId);
	}
	const enabledOrNone = () => enabledBuiltIns().catch(() => new Set<string>());

	async function beforeDeadline<T>(work: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				work,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Refusal(pageStuck(Math.round(pageDeadlineMs / 1000)))), pageDeadlineMs);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	const syncShim = (tabId: number, regrouped: boolean) =>
		syncDialogShim({ browserApi: api, storage: api.storage, tabId, regrouped, ...(lock ? { lock } : {}) }).catch(
			() => undefined,
		);

	api.tabs.onUpdated.addListener((tabId, change) => {
		const regrouped = change.groupId !== undefined;
		if (regrouped || change.status === "loading" || change.status === "complete") void syncShim(tabId, regrouped);
	});
	api.tabs.onRemoved.addListener((tabId) => void forgetDialogShim(api.storage, tabId).catch(() => undefined));

	function scrub(result: PwExtResult, secrets: string[]): PwExtResult {
		if (result.ok)
			return {
				...result,
				data: {
					...result.data,
					text: cap(redactLiterals(result.data.text, secrets)),
					...(result.data.tools ? { tools: mapTools(result.data.tools, (value) => redactLiterals(value, secrets)) } : {}),
				},
			};
		return secrets.length ? { ...result, error: redactLiterals(result.error, secrets) } : result;
	}

	const ok = (text: string, image?: string): PwExtResult => ({
		ok: true,
		data: { text: mask(text), ...(image ? { image } : {}) },
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

	const fills = new Map<string, { active: number; kept: boolean }>();

	/** Counts in-flight secret fills of one value, so one failed fill cannot unmask a value another fill wrote. */
	function holdFill(sessionId: string, secret: string) {
		const key = `${sessionId}\n${secret}`;
		const entry = fills.get(key) ?? { active: 0, kept: false };
		entry.active++;
		fills.set(key, entry);
		return {
			alone: () => entry.active === 1 && !entry.kept,
			done(kept: boolean) {
				if (kept) entry.kept = true;
				if (--entry.active === 0) fills.delete(key);
			},
		};
	}

	async function inPage(tab: LiveTab, action: PwExtPageAction, unmasked = false, secrets: string[] = []) {
		if (tab.signal?.aborted) throw new Refusal(STOPPED_WORK);
		const [frame] = await beforeDeadline(
			api.scripting.executeScript({
				target: { tabId: tab.id },
				func: pwExtPageAction,
				args: [action, tab.url as string, unmasked, secrets, Date.now() + pageDeadlineMs],
			}),
		);
		return pageResult(frame?.result);
	}

	async function dialogs(
		tab: LiveTab,
		action: PwExtDialogAction,
		options: { unmasked: boolean; secrets: string[] },
	): Promise<PwExtDialogState> {
		await beforeDeadline(syncShim(tab.id, false));
		const state = dialogState(
			await beforeDeadline(inMain(tab, pwExtDialogs as never, [action, tab.url, tab.groupId ?? -1])),
		);
		if ("error" in state) throw new PageError(maskRaw(state.error, RAW_ERROR_MAX, options));
		return state;
	}

	async function inMain(
		tab: LiveTab,
		func: (...args: never[]) => unknown,
		args: unknown[],
	): Promise<unknown> {
		if (tab.signal?.aborted) throw new Refusal(STOPPED_WORK);
		const [frame] = await api.scripting.executeScript({
			target: { tabId: tab.id },
			world: "MAIN",
			func,
			args,
		});
		return frame?.result;
	}

	function tabListing(rows: readonly AgentTab[], secrets: string[]): string {
		const lines = rows.slice(0, MAX_AGENT_TABS).map((row) => {
			const title = shownTitle(row, false, secrets);
			return `- ${row.selected ? "[selected] " : ""}${row.tabId}: ${title ? `${title} — ` : ""}${shownUrl(row, false, secrets)}`;
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

	async function guard(verb: PwExtVerb, tab: LiveTab, tool?: string): Promise<void> {
		if (tab.incognito) throw new Refusal(PW_EXT_PRIVATE_ERROR);
		if (BLOCKS_BROWSER_PAGE.has(verb) && !allowedPage(tab.url))
			throw new Refusal(PW_EXT_BLOCKED_ERROR);
		if (BLOCKS_MAILBOX.has(verb) && mailbox(tab.url) && !(await mailboxPasses(verb, tab, tool)))
			throw new Refusal(PW_EXT_MAILBOX_ERROR);
		if (NEEDS_LOADED_TAB.has(verb) && tab.discarded)
			throw new Refusal(discardedTab(tab.id));
	}

	async function mailboxPasses(verb: PwExtVerb, tab: LiveTab, tool: string | undefined): Promise<boolean> {
		if (verb === "tools") return true;
		return verb === "call" && tool !== undefined && mailboxToolAllowed(tool, new URL(tab.url as string).origin, await enabledOrNone());
	}

	async function openInGroup(
		url: string,
		{ sessionId, agentIdentity }: PwExtContext,
		signal: AbortSignal,
	): Promise<PwExtResult> {
		const { tabId } = await agentTabs
			.open({ sessionId, agentIdentity, url, canceled: () => signal.aborted })
			.catch((error: unknown) => {
				if (error instanceof AgentGroupFullError) throw new Refusal(GROUP_FULL);
				if (error instanceof AgentTabOpenCanceledError) throw new Refusal(error.message);
				throw error;
			});
		await agentTabs.select({ sessionId, tabId });
		void syncShim(tabId, false);
		return ok(`### Result\nOpened ${url} in tab ${tabId}`);
	}

	async function run(
		request: TabVerbRequest,
		tab: LiveTab,
		context: PwExtContext,
		signal: AbortSignal | undefined,
	): Promise<PwExtResult> {
		const grant = await grants.active(context.sessionId, tab);
		const filling = request.verb === "fill" && request.secret ? (request.value as string) : undefined;
		const hold = filling === undefined ? undefined : holdFill(context.sessionId, filling);
		let dropped = false;
		let result: PwExtResult;
		try {
			const reserved = filling === undefined ? "held" : await grants.reserve(context.sessionId, filling);
			if (reserved === "full") throw new Refusal(SECRETS_FULL);
			const release = async () => {
				dropped = true;
				if (reserved === "added" && hold?.alone()) await grants.release(context.sessionId, filling as string);
			};
			result = await perform(request, tab, context, signal, grant, release);
		} finally {
			hold?.done(!dropped);
		}
		if (!grant) return result;
		const live = await api.tabs.get(tab.id).catch(() => undefined);
		if (live && (await grants.active(context.sessionId, live))) return result;
		return result.ok
			? {
					...result,
					data: {
						...result.data,
						text: mask(result.data.text.replace(`${unmaskLine(grant)}\n`, "")),
						...(result.data.tools ? { tools: mapTools(result.data.tools, (value) => mask(value)) } : {}),
					},
				}
			: { ...result, error: mask(result.error) };
	}

	async function perform(
		request: TabVerbRequest,
		tab: LiveTab,
		context: PwExtContext,
		signal: AbortSignal | undefined,
		grant: UnmaskGrant | undefined,
		release: () => Promise<void>,
	): Promise<PwExtResult> {
		const unmasked = grant !== undefined;
		const secrets = await grants.secrets(context.sessionId);
		if (signal?.aborted) {
			await release();
			return CANCELED;
		}
		const page = () => pageLines(tab, unmasked, secrets);
		const pageError = (error: string): PwExtResult =>
			mailbox(tab.url)
				? { ok: false, error: MAILBOX_TOOL_FAILED }
				: failed(maskRaw(error, RAW_ERROR_MAX, { unmasked, secrets }));
		const shown = (text: string): PwExtResult => ({
			ok: true,
			data: { text: clean(grant ? `${unmaskLine(grant)}\n${text}` : text, { unmasked, secrets }) },
		});
		const failed = (error: string): PwExtResult => ({ ok: false, error: clean(error, { unmasked, secrets }) });
		switch (request.verb) {
			case "current":
				return shown(page().join("\n"));
			case "unmask": {
				const origin = new URL(tab.url as string).origin;
				if (request.off) {
					const ended = await grants.revoke(context.sessionId, origin);
					return ok(`### Result\n${ended ? "Ended the unmask" : "No unmask was active"} on ${origin}.`);
				}
				const minutes = request.minutes ?? PW_EXT_UNMASK_DEFAULT_MINUTES;
				const answer = await (approvals ?? browserApprovals()).request({
					title: "Let the agent see personal data?",
					origin,
					lines: [
						`Agent: ${context.agentIdentity}`,
						`Tab group: ${groupTitle(context)}`,
						"Shows email addresses in pw --ext output on this site.",
						"Lets the agent fill password fields here, from a value it never echoes.",
						`Ends in ${minutes} minutes, on pw --ext unmask --off, or when the agent's tab group closes.`,
					],
				});
				if (signal?.aborted) return CANCELED;
				if (answer !== "allow") return { ok: false, error: UNMASK_REFUSED[answer] };
				const until = now() + minutes * 60_000;
				await grants.grant(context.sessionId, { origin, groupId: tab.groupId ?? -1, until });
				return ok(`### Result\nUnmasked on ${origin} until ${clock(until)}, approved in the browser.`);
			}
			case "open": {
				if (signal?.aborted) return CANCELED;
				await api.tabs.update(tab.id, { url: request.url as string });
				return ok(`### Result\nOpened ${request.url} in tab ${tab.id}`);
			}
			case "select": {
				await agentTabs.select({ sessionId: context.sessionId, tabId: tab.id, canceled: () => signal?.aborted === true });
				void syncShim(tab.id, false);
				return ok(`### Result\nSelected tab ${tab.id}`);
			}
			case "close": {
				const { selectedTabId } = await agentTabs.close({
					sessionId: context.sessionId,
					tabId: tab.id,
					canceled: () => signal?.aborted === true,
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
				if ("error" in result) return failed(result.error);
				if (!("detail" in result))
					return { ok: false, error: "The page returned an unexpected result." };
				return shown([`### Result`, result.detail, ...page()].join("\n"));
			}
			case "tools": {
				const listed = webMcpResult(
					await inMain(tab, pwExtWebMcp as never, [{ kind: "tools" }, tab.url]),
				);
				if ("error" in listed) return pageError(listed.error);
				const found = "tools" in listed ? listed.tools : [];
				const enabled = mailbox(tab.url) ? await enabledOrNone() : undefined;
				const origin = new URL(tab.url as string).origin;
				const listedTools = boundTools(
					enabled ? found.filter((tool) => mailboxToolAllowed(tool.name, origin, enabled)) : found,
					{ unmasked, secrets },
				);
				if (listedTools.length === 0)
					return withTools(
						shown([...page(), "### WebMCP tools", "This page exposes no WebMCP tools."].join("\n")),
						[],
					);
				const rows = listedTools.flatMap((tool) => [
					`- ${tool.name}: ${tool.description}`,
					...(tool.inputSchema ? [`  input: ${tool.inputSchema}`] : []),
					...(tool.annotations ? [`  hints: ${tool.annotations}`] : []),
				]);
				return withTools(
					shown([...page(), `### WebMCP tools (${listed.api})`, ...rows].join("\n")),
					listedTools,
				);
			}
			case "call": {
				const tool = request.tool as string;
				if (tool.startsWith("dg_") && !isDgToolName(tool)) return failed(`Unknown dg tool name ${tool}.`);
				const withheld = await approveDgTool(request, tab, context, signal);
				if (withheld) return withheld;
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
				if ("error" in called) return pageError(called.error);
				if (!("output" in called))
					return { ok: false, error: "The page returned an unexpected WebMCP result." };
				return shown(
					[
						`### Result`,
						`WebMCP tool ${request.tool} returned:`,
						clip(maskRaw(called.output, RAW_OUTPUT_MAX, { unmasked, secrets }), TOOL_OUTPUT_MAX),
						...page(),
					].join("\n"),
				);
			}
			case "dialog": {
				if (request.answer === undefined) {
					const state = await dialogs(tab, { kind: "read", markSeen: true }, { unmasked, secrets });
					const last = state.dialogs.at(-1);
					return shown(
						[
							...page(),
							"### Dialog",
							last
								? `- last: ${dialogLine(last, { unmasked, secrets })}`
								: "No dialog on this page since pw --ext began to watch it.",
							...pendingLine(state),
						].join("\n"),
					);
				}
				if (request.text !== undefined && redactLiterals(request.text, secrets) !== request.text)
					return { ok: false, error: DIALOG_TEXT_SECRET };
				await dialogs(
					tab,
					{
						kind: "answer",
						answer: request.answer,
						...(request.text === undefined ? {} : { text: request.text }),
						until: Date.now() + pageDeadlineMs,
					},
					{ unmasked, secrets },
				);
				return shown(
					[
						"### Result",
						`The next dialog on this page gets ${request.answer}${request.text === undefined ? "" : ", with your text"}. A new page starts again at dismiss.`,
						...page(),
					].join("\n"),
				);
			}
			case "screenshot": {
				if (signal?.aborted) return CANCELED;
				const windowId = tab.windowId as number;
				await api.tabs.update(tab.id, { active: true });
				const { state } = await api.windows.get(windowId);
				if (signal?.aborted) return CANCELED;
				await api.windows.update(windowId, {
					focused: true,
					...(state === "minimized" ? { state: "normal" as const } : {}),
				});
				if (signal?.aborted) return CANCELED;
				await api.scripting.executeScript({
					target: { tabId: tab.id },
					func: nextFrame,
					args: [],
				});
				if (signal?.aborted) return CANCELED;
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
				return ok(pageLines(tab, false, secrets).join("\n"), fitted.dataUrl);
			}
			default: {
				const action: PwExtPageAction =
					request.verb === "click" || request.verb === "count"
						? { kind: request.verb, target: request.target as string }
						: request.verb === "fill"
							? {
									kind: "fill",
									target: request.target as string,
									value: request.value as string,
									...(request.secret ? { secret: true, ...(grant ? { until: grant.until } : {}) } : {}),
								}
							: { kind: request.verb };
				if (request.verb === "fill" && request.secret && grant) {
					const live = await api.tabs.get(tab.id).catch(() => undefined);
					if (!live || !(await grants.active(context.sessionId, live))) {
						await release();
						return failed(UNMASK_ENDED);
					}
				}
				const seen =
					request.verb === "snapshot"
						? await dialogs(tab, { kind: "read", markSeen: true }, { unmasked, secrets }).catch((error: unknown) => {
								if (error instanceof Refusal && error.message.startsWith("The page did not answer")) throw error;
								return undefined;
							})
						: undefined;
				const result = await inPage(tab, action, unmasked, secrets);
				if ("error" in result) {
					await release();
					return failed(result.error);
				}
				if ("tree" in result)
					return shown(
						[
							...page(),
							...dialogNotice(seen, { unmasked, secrets }),
							"### Snapshot",
							result.tree,
							"### Visible text",
							result.text,
						].join("\n"),
					);
				if ("detail" in result)
					return shown([`### Result`, result.detail, ...page()].join("\n"));
				if ("entries" in result) {
					const warnings = consoleWarnings(await inMain(tab, pwExtConsoleHook as never, [tab.url]), {
						unmasked,
						secrets,
					});
					const entries = [...result.entries, ...warnings];
					return shown(
						[
							...page(),
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
				return shown([...page(), "### Selection", result.text].join("\n"));
			}
		}
	}

	async function approveDgTool(
		request: TabVerbRequest,
		tab: LiveTab,
		context: PwExtContext,
		signal: AbortSignal | undefined,
	): Promise<PwExtResult | undefined> {
		const tool = request.tool as string;
		if (tab.url === undefined) return { ok: false, error: `This tab has no page address; ${tool} did not run.` };
		const origin = new URL(tab.url).origin;
		const approvalClass = approvalClassOf(tool, origin) ?? "each";
		if (approvalClass === "read") return undefined;
		const answer = await requestWebMcpApproval({
			approvals: approvals ?? browserApprovals(),
			grants: webmcpGrants,
			remembered: rememberedWebMcpGrants,
			sessionId: context.sessionId,
			agentIdentity: context.agentIdentity,
			tool,
			args: request.args ?? {},
			origin,
			class: approvalClass,
		});
		if (signal?.aborted) return CANCELED;
		if (answer !== "allow") {
			const reason =
				answer === "timeout"
					? "No answer in the browser within 60 seconds"
					: answer === "closed"
						? "The approval window was closed"
						: answer === "unopened"
							? "The approval window could not open"
							: "";
			return {
				ok: false,
				error: answer === "deny" ? `The user denied ${tool} in the browser.` : `${reason || "The approval was not given"}; ${tool} did not run.`,
			};
		}
		const live = await api.tabs.get(tab.id).catch(() => undefined);
		if (
			!live ||
			live.groupId !== tab.groupId ||
			!(await agentTabs.owns({ sessionId: context.sessionId, tabId: tab.id }))
		)
			return { ok: false, error: `The tab left the agent's group; ${tool} did not run.` };
		return undefined;
	}

	async function execute(
		request: PwExtRequest,
		context: PwExtContext,
		signal: AbortSignal,
		verb: number,
	): Promise<PwExtResult> {
		if (signal.aborted) return CANCELED;
		if (request.verb === "new") {
			await allowSite(request.url, context, signal, verb);
			if (signal.aborted) return CANCELED;
			return openInGroup(request.url ?? NEW_TAB_URL, context, signal);
		}
		if (!isTabVerb(request)) {
			const rows = await agentTabs.list({ sessionId: context.sessionId });
			if (!rows.length) throw new Refusal(NO_TAB);
			return ok(tabListing(rows, await grants.secrets(context.sessionId)));
		}
		const tab = await resolveTab(request, context.sessionId);
		if (signal?.aborted) return CANCELED;
		if (!tab) {
			const rows = await agentTabs.list({ sessionId: context.sessionId });
			if (rows.length) throw new Refusal(SELECTED_GONE);
			if (request.verb === "open") {
				await allowSite(request.url, context, signal, verb);
				if (signal.aborted) return CANCELED;
				return openInGroup(request.url as string, context, signal);
			}
			throw new Refusal(NO_TAB);
		}
		await guard(request.verb, tab, request.tool);
		if (!NO_SITE_ASK.has(request.verb)) {
			await allowSite(request.verb === "open" ? request.url : tab.url, context, signal, verb);
			const live = await api.tabs.get(tab.id).catch(() => undefined);
			if (!live || live.groupId !== tab.groupId || !(await agentTabs.owns({ sessionId: context.sessionId, tabId: tab.id })))
				throw new Refusal(SELECTED_GONE);
			if (live.url !== tab.url)
				throw new Refusal("The page changed while the site question was open; nothing ran. Retry.");
		}
		tab.signal = signal;
		if (signal.aborted) return CANCELED;
		return run(request, tab, context, signal);
	}

	const handler = async ({
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
		if (request.verb === "fill" && request.secret && isPwExtSecretTooShort(request.value as string))
			return { ok: false, error: SECRET_TOO_SHORT };
		const { sessionId } = context;
		if (halted.has(sessionId)) return STOPPED;
		const typed = request.verb === "fill" && request.secret ? [request.value as string] : [];
		const held = async () => [...typed, ...(await grants.secrets(sessionId).catch(() => []))];
		const verb = ++verbs;
		const controller = new AbortController();
		const relay = () => controller.abort();
		signal?.addEventListener("abort", relay, { once: true });
		if (signal?.aborted) controller.abort();
		let markStopped = () => undefined as void;
		const stopped = new Promise<"stopped">((resolve) => {
			markStopped = () => resolve("stopped");
		});
		const run: Running = { controller, stopped: markStopped };
		const running = live.get(sessionId) ?? new Set<Running>();
		running.add(run);
		live.set(sessionId, running);
		const outcome = await (async (): Promise<PwExtResult> => {
			try {
				if (await isStopped(sessionId)) return STOPPED;
				const result = await Promise.race([execute(request, context, controller.signal, verb), stopped]);
				if (result === "stopped" || (await isStopped(sessionId))) return STOPPED;
				return scrub(result, await held());
			} catch (error) {
				if (await isStopped(sessionId).catch(() => false)) return STOPPED;
				if (error instanceof Refusal || error instanceof AgentTabOpenCanceledError) return { ok: false, error: error.message };
				if (error instanceof PageError) return { ok: false, error: clean(error.message, { secrets: await held() }) };
				return {
					ok: false,
					error: clean(
						`pw --ext failed in the browser: ${error instanceof Error ? error.message : String(error)}`,
						{ secrets: await held() },
					).slice(0, 2048),
				};
			}
		})();
		signal?.removeEventListener("abort", relay);
		running.delete(run);
		if (running.size === 0) live.delete(sessionId);
		return halted.has(sessionId) ? STOPPED : outcome;
	};
	return Object.assign(handler, { stop, stopTab });
}
