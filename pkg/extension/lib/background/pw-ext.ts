import {
	PW_EXT_NO_TAB_ERROR as NO_TAB,
	approvalClassOf,
	BUILT_IN_SCRIPTS,
	formatNetwork,
	formatStorage,
	isDgToolName,
	PW_EXT_CREDENTIAL_SITE,
	isPwExtModuleVerb,
	isPwExtWebUrl,
	mailboxToolAllowed,
	matchesCoverOrigin,
	isPwExtSecretTooShort,
	PW_EXT_MAX_TEXT_CHARS,
	PW_EXT_MAX_TOOLS,
	PW_EXT_MIN_SECRET_CHARS,
	PW_EXT_UNMASK_DEFAULT_MINUTES,
	type PW_EXT_RELAY,
	type PwExtModuleVerb,
	type PwExtRequest,
	type PwExtResponse,
	type PwExtTool,
	type PwExtVerb,
	maskJsonStrings,
	redactLiterals,
	redactSecrets,
	redactText,
	validateNetworkEntries,
	validatePwExtRequest,
	validateStorageResult,
	type KeyChord,
	parseKeyChord,
} from "@dg/common";
import { VERBS as INPUT_VERBS } from "../../../common/src/pw-ext-verbs/input";
import { VERBS as NAVIGATION_VERBS } from "../../../common/src/pw-ext-verbs/navigation";
import { VERBS as PAGE_MODULE_VERBS } from "../../../common/src/pw-ext-verbs/page";
import { VERBS as POINTER_VERBS } from "../../../common/src/pw-ext-verbs/pointer";
import {
	type PwExtDialogAction,
	type PwExtDialogRecord,
	type PwExtDialogState,
	pwExtDialogs,
} from "@/lib/features/pw-ext-dialog-main";
import { pwExtNetwork } from "@/lib/features/pw-ext-network-main";
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
import { createInputHandler } from "./pw-verbs/input";
import { createNavigationHandler } from "./pw-verbs/navigation";
import { createPageVerbHandler } from "./pw-verbs/page";
import { createPointerHandler } from "./pw-verbs/pointer";
import { createStorageVerbHandler } from "./pw-verbs/storage";
import { siteOf } from "./site-key";
import { PhiCaptureRefusedError, type SiteAllow } from "./site-allow-prompt";
import { runningThirdPartyMatches, STOPPED_SCRIPTS_KEY, type WebMcpStoppedScript } from "./webmcp-scripts";
import {
	createRememberedWebMcpGrants,
	createWebMcpGrants,
	type RememberedWebMcpGrants,
	type RememberStorage,
	requestWebMcpApproval,
	type WebMcpGrants,
} from "./webmcp-approval";
import { createWebMcpSigner } from "./webmcp-signing";
import { createIdbGrantNonces } from "./webmcp-grant-nonces";
import { createUnmaskGrants, MAX_FILLED_SECRETS, type UnmaskGrant, type UnmaskGrants } from "./unmask-grants";
import {
	allowedPage,
	mailbox,
	outlookWeb,
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
	tabGroups: AgentTabsBrowserApi["tabGroups"] & {
		onUpdated: TabEvent<(group: { id: number }) => void>;
	};
	storage: AgentTabsStorage;
	cookies?: {
		get(details: { url: string; name: string }): Promise<{ value: string; expirationDate?: number } | null>;
	};
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
const NO_SITE_ASK: ReadonlySet<PwExtVerb> = new Set(["tabs", "select", "close"]);
const WEB_MCP_VERBS: ReadonlySet<PwExtVerb> = new Set(["tools", "call"]);
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
	"press",
	"upload",
	"selection",
	"console",
	"tools",
	"call",
	"dialog",
	"network",
	"storage",
	"fetch",
	"credential",
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

type WebMcpVerb = "webmcp-tools" | "webmcp-call";
type TabVerbRequest = PwExtRequest & {
	verb: Exclude<PwExtVerb, "tabs" | "new" | WebMcpVerb | PwExtModuleVerb>;
};
type WebMcpRequest = PwExtRequest & { verb: WebMcpVerb };
type ModuleRequest = PwExtRequest & { verb: PwExtModuleVerb };
const MODULE_SITE_ASK: ReadonlySet<PwExtVerb> = new Set([...NAVIGATION_VERBS, ...POINTER_VERBS, ...INPUT_VERBS]);
const CAPTURE_VERBS: ReadonlySet<PwExtVerb> = new Set(["snapshot", "screenshot"]);

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

/** Sites of enabled third-party scripts, and of stopped ones whose tools may live on in documents loaded earlier. */
export type ThirdPartySites = { active: string[]; stopped: WebMcpStoppedScript[] };

const textList = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

async function storedThirdPartySites(storage: unknown): Promise<ThirdPartySites> {
	const local = (storage as { local?: { get(keys: string[]): Promise<Record<string, unknown>> } }).local;
	if (!local) return { active: [], stopped: [] };
	const stored = await local.get([BUILT_INS_KEY, STOPPED_SCRIPTS_KEY]);
	const records = Array.isArray(stored[BUILT_INS_KEY])
		? (stored[BUILT_INS_KEY] as { source?: unknown; enabled?: unknown; matches?: unknown }[])
		: [];
	const stopped = Array.isArray(stored[STOPPED_SCRIPTS_KEY])
		? (stored[STOPPED_SCRIPTS_KEY] as { matches?: unknown; stoppedAt?: unknown }[])
		: [];
	return {
		active: records.flatMap((record) =>
			record?.source !== "built-in" && record?.enabled === true ? textList(record.matches) : [],
		),
		stopped: stopped.map((entry) => ({
			matches: textList(entry?.matches),
			stoppedAt: typeof entry?.stoppedAt === "number" ? entry.stoppedAt : Number.POSITIVE_INFINITY,
		})),
	};
}

function pwExtDocumentStart(): number {
	return performance.timeOrigin;
}

function isTabVerb(request: PwExtRequest): request is TabVerbRequest {
	return request.verb !== "tabs" && request.verb !== "new" && !isWebMcpVerb(request) && !isModuleRequest(request);
}

function isModuleRequest(request: PwExtRequest): request is ModuleRequest {
	return isPwExtModuleVerb(request.verb);
}

function isWebMcpVerb(request: PwExtRequest): request is WebMcpRequest {
	return request.verb === "webmcp-tools" || request.verb === "webmcp-call";
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
const BAD_NETWORK = "The page returned an unexpected network result.";
const VALUES_REFUSED = {
	deny: "The user clicked Deny in the browser",
	closed: "The approval window was closed without an answer",
	timeout: "No answer in the browser within 60 seconds",
	unopened: "The approval window could not open",
} satisfies Record<Exclude<ApprovalAnswer, "allow">, string>;
const valuesRefused = (answer: Exclude<ApprovalAnswer, "allow">, site: string) =>
	`${VALUES_REFUSED[answer]}; pw --ext network --values shows values on ${site} only after the user clicks Allow in the dg approval window. Run it again to ask once more. Without --values, network shows the shape only.`;
const valuesSiteOf = (url: string) => siteOf(url).key;
const BAD_STORAGE = "The page returned an unexpected storage result.";
const FETCH_DEADLINE_MS = 35_000;
const NOT_SAVED = "Nothing was saved.";

/** The site segment of a saved credential name: the registrable domain, or the host when it has none. */
function credentialSite(url: string): string | undefined {
	const site = siteOf(url);
	const host = site.grouped ? site.key.replace(/^[a-z]+:\/\//, "").replace(/:\d+$/, "") : new URL(url).hostname;
	return PW_EXT_CREDENTIAL_SITE.test(host) ? host : undefined;
}

function jsonPath(raw: string, path: string): string | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	for (const part of path.split(".")) {
		if (typeof value !== "object" || value === null || !Object.hasOwn(value, part)) return undefined;
		value = (value as Record<string, unknown>)[part];
	}
	return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function jwtExpiry(value: string): string | undefined {
	const part = value.replace(/^Bearer\s+/i, "").split(".")[1];
	if (!part) return undefined;
	try {
		const exp = (JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: unknown }).exp;
		return typeof exp === "number" && Number.isFinite(exp) ? new Date(exp * 1000).toISOString() : undefined;
	} catch {
		return undefined;
	}
}
const DIALOG_ANSWERS = ["accept", "dismiss"];

/** Per-request seams that need the session capability. */
export type PwExtContext = {
	sessionId: string;
	agentIdentity: string;
	fetchAsset(assetId: string): Promise<Blob>;
	deleteAsset(assetId: string): Promise<void>;
	/** Sends a captured value to dg daemon's credential store and resolves to its store name; the value goes nowhere else. */
	storeCredential(entry: { site: string; name: string; value: string; meta: Record<string, unknown> }): Promise<string>;
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
const CAPTURE_DEADLINE_MS = 10_000;
const BRING_FORWARD = "Bring the browser window with the agent tab to the front, then retry.";
const SHOT_INACTIVE = `The agent tab did not become the active tab in its window, so it cannot be captured. ${BRING_FORWARD}`;
const SHOT_MINIMIZED = `The browser window stayed minimized, so the agent tab cannot be captured. Restore the window, then retry.`;
const shotStuck = (seconds: number, reason: string) =>
	`The screenshot did not finish within ${seconds} seconds because ${reason}. ${BRING_FORWARD}`;

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
function mask(
	text: string,
	{ unmasked = false, secrets = [] }: { unmasked?: boolean; secrets?: string[] } = {},
): string {
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

/** Masks a JSON tool output value by value so it stays valid JSON; other text goes through maskRaw. */
function maskOutput(raw: string, options: { unmasked: boolean; secrets: string[] }): string {
	const masked = maskJsonStrings(raw, (value) => mask(value, options)) ?? maskRaw(raw, RAW_OUTPUT_MAX, options);
	return clip(masked, TOOL_OUTPUT_MAX);
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

const OUTLOOK_WORDS = new Set([
	"mail",
	"inbox",
	"calendar",
	"people",
	"tasks",
	"to do",
	"files",
	"search",
	"settings",
	"outlook",
]);

function outlookTitle(title: string): string {
	const [first = "", ...rest] = title.split(" - ");
	const count = /^\(\d+\) /.exec(first)?.[0] ?? "";
	const word = first.slice(count.length);
	const head = count + (OUTLOOK_WORDS.has(word.trim().toLowerCase()) ? word : "[redacted]");
	return rest.length ? `${head} - [redacted]` : head;
}

/** The title parts outlookTitle hides, as literals to mask elsewhere on the page. */
function outlookIdentity(title: string | undefined): string[] {
	const [, ...rest] = (title ?? "").split(" - ");
	return rest
		.map((part) => part.trim())
		.filter((part) => part.length >= 3 && !OUTLOOK_WORDS.has(part.toLowerCase()));
}

function shownTitle(tab: Pick<BrowserTab, "url" | "title">, unmasked = false, secrets: string[] = []): string {
	if (!allowedPage(tab.url) || mailbox(tab.url)) return "";
	const title = tab.title ?? "";
	return mask(!unmasked && outlookWeb(tab.url) && title ? outlookTitle(title) : title, { unmasked, secrets });
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
const MAX_WEBMCP_TABS = 20;
const MAX_WEBMCP_LIST_BYTES = 600_000;
const noWebMcpTab = (tool: string) =>
	`No open browser tab exposes ${tool}. Open the site in a normal browser tab with its Web MCP script turned on, then retry.`;

function approvalTabTitle(tab: Pick<BrowserTab, "url" | "title">): string {
	if (mailbox(tab.url)) return "(protected mailbox)";
	return shownTitle(tab) || "(no title)";
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
		nonces: createIdbGrantNonces(),
		now,
	}),
	enabledBuiltIns = () => storedEnabledBuiltIns(api.storage),
	thirdPartySites = () => storedThirdPartySites(api.storage),
	runningThirdParty = () => runningThirdPartyMatches(),
	pageDeadlineMs = PAGE_DEADLINE_MS,
	captureDeadlineMs = CAPTURE_DEADLINE_MS,
	lock,
	control = createSessionControl({ storage: api.storage }),
	siteAllow,
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
	thirdPartySites?: () => Promise<ThirdPartySites>;
	runningThirdParty?: () => Promise<string[]>;
	pageDeadlineMs?: number;
	captureDeadlineMs?: number;
	lock?: AgentTabsLock;
	control?: SessionControl;
	siteAllow?: Pick<SiteAllow, "requestSiteAllow" | "assertCaptureAllowed">;
}) {
	const navigation = createNavigationHandler({ browserApi: api as never, agentTabs });
	const pointer = createPointerHandler({ browserApi: api as never, agentTabs });
	const input = createInputHandler({ browserApi: api as never, agentTabs });
	const pageVerbs = createPageVerbHandler({ browserApi: api as never, agentTabs, control });
	const storageVerbs = createStorageVerbHandler({ browserApi: api as never, agentTabs, control });
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
		if (siteAllow) {
			const answer = await siteAllow.requestSiteAllow({ sessionId: context.sessionId, siteKey: site.key });
			if (signal.aborted) throw new Refusal("The request was canceled before it ran.");
			if (answer !== "allow") {
				deniedThrough.set(key, verbs);
				throw new Refusal(`${SITE_REFUSED.deny}; the agent may not use ${named}. Nothing ran.`);
			}
			await control.allow(context.sessionId, site.key);
			return;
		}
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

	/** Asks the person once per site and session before values show or the site's sign-in is used or saved; one Allow lasts until the session ends or Stop. */
	async function allowValues(tab: LiveTab, context: PwExtContext, signal: AbortSignal | undefined): Promise<PwExtResult | undefined> {
		const site = valuesSiteOf(tab.url as string);
		if (await control.valuesAllowed(context.sessionId, site)) return undefined;
		const ownsLive = async () =>
			(await agentTabs.owns({ sessionId: context.sessionId, tabId: tab.id })) && !(await isStopped(context.sessionId));
		const key = `values\n${context.sessionId}\n${site}`;
		let pending = asking.get(key);
		if (!pending) {
			pending = (async () => {
				const answer = await (approvals ?? browserApprovals()).request({
					title: "Let the agent see values and use your sign-in on this site?",
					origin: site,
					lines: [
						`Agent: ${context.agentIdentity}`,
						`Tab group: ${groupTitle(context)}`,
						"The agent sees request, response and storage values on this site. They can contain personal or health data.",
						"The agent can send its own requests to this site with your sign-in, and they can change data here.",
						"The agent can save a sign-in cookie, header or stored value into the dg credential store. It never sees that value.",
						"Passwords, cookies, sign-in headers and known secrets stay masked in what the agent sees.",
						"You are asked once. It lasts until this dg session ends or you click Stop.",
					],
				});
				if (answer === "allow" && (await ownsLive())) await control.allowValues(context.sessionId, site);
				return answer;
			})();
			asking.set(key, pending);
			void pending.finally(() => asking.delete(key)).catch(() => undefined);
		}
		const answer = await pending;
		if (signal?.aborted) return CANCELED;
		if (answer !== "allow") return { ok: false, error: valuesRefused(answer, site) };
		if (!(await ownsLive()))
			return { ok: false, error: "The tab left the agent's group while the approval was open; nothing was read." };
		const live = await api.tabs.get(tab.id).catch(() => undefined);
		if (!live || live.groupId !== tab.groupId || live.url !== tab.url)
			return { ok: false, error: "The tab changed while the approval was open; nothing was read. Retry." };
		await inMain(tab, pwExtNetwork as never, [{ kind: "seal" }, tab.url, tab.groupId ?? -1]).catch(() => undefined);
		return undefined;
	}

	/** True when the session that owns the tab's group approved the tab's site. */
	async function sealFor(tab: BrowserTab): Promise<boolean> {
		if (tab.groupId === undefined || tab.groupId < 0 || !tab.url) return false;
		const sessionId = await agentSessionOfGroup({ storage: api.storage, groupId: tab.groupId });
		return sessionId ? control.valuesAllowed(sessionId, valuesSiteOf(tab.url)) : false;
	}

	/** Ends a session's control at once: verbs in flight end, unmask and value grants and sites go, and its tabs return to the person; Web MCP grants stay. */
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

	async function withDeadline<T>(ms: number, work: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				work,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Refusal(`The request did not finish within ${Math.round(ms / 1000)} seconds.`)), ms);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

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

	async function stuckReason(tabId: number, windowId: number): Promise<string> {
		const [shown, window] = await Promise.all([
			api.tabs.get(tabId).catch(() => undefined),
			api.windows.get(windowId).catch(() => undefined),
		]);
		if (window?.state === "minimized") return "the browser window is minimized";
		if (shown?.active === false) return "the agent tab is not the active tab in its window";
		if (window?.focused === false) return "the browser window is not focused";
		return "the browser did not draw the tab; the window may be behind another window or on another desktop";
	}

	async function beforeCaptureDeadline<T>(work: Promise<T>, tabId: number, windowId: number): Promise<T> {
		const late = Symbol("late");
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				work,
				new Promise<typeof late>((resolve) => {
					timer = setTimeout(() => resolve(late), captureDeadlineMs);
				}),
			]);
			if (result === late)
				throw new Refusal(shotStuck(Math.round(captureDeadlineMs / 1000), await stuckReason(tabId, windowId)));
			return result;
		} finally {
			clearTimeout(timer);
		}
	}

	const syncShim = (tabId: number, regrouped: boolean) =>
		syncDialogShim({ browserApi: api, storage: api.storage, tabId, regrouped, seal: sealFor, ...(lock ? { lock } : {}) }).catch(
			() => undefined,
		);

	api.tabs.onUpdated.addListener((tabId, change) => {
		const regrouped = change.groupId !== undefined;
		if (regrouped || change.status === "loading" || change.status === "complete") void syncShim(tabId, regrouped);
	});
	api.tabGroups.onUpdated.addListener((group) => {
		void api.tabs
			.query({ groupId: group.id })
			.then((groupTabs) => Promise.all(groupTabs.flatMap((tab) => (tab.id === undefined ? [] : [syncShim(tab.id, false)]))))
			.catch(() => undefined);
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
		const { tabId, recoveredTabIds } = await agentTabs
			.open({ sessionId, agentIdentity, url, canceled: () => signal.aborted })
			.catch((error: unknown) => {
				if (error instanceof AgentGroupFullError) throw new Refusal(GROUP_FULL);
				if (error instanceof AgentTabOpenCanceledError) throw new Refusal(error.message);
				throw error;
			});
		await agentTabs.select({ sessionId, tabId });
		void syncShim(tabId, false);
		for (const recovered of recoveredTabIds) void syncShim(recovered, true);
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
		const hidden = !unmasked && outlookWeb(tab.url) ? [...secrets, ...outlookIdentity(tab.title)] : secrets;
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
			data: { text: clean(grant ? `${unmaskLine(grant)}\n${text}` : text, { unmasked, secrets: hidden }) },
		});
		const shownOutput = (head: string, output: string, tail: string): PwExtResult => {
			const options = { unmasked, secrets: hidden };
			const top = mask(grant ? `${unmaskLine(grant)}\n${head}` : head, options);
			return { ok: true, data: { text: cap([top, output, mask(tail, options)].join("\n")) } };
		};
		const failed = (error: string): PwExtResult => ({ ok: false, error: clean(error, { unmasked, secrets: hidden }) });
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
				if ("error" in called)
					return mailboxToolAllowed(tool, new URL(tab.url as string).origin, await enabledOrNone())
						? failed(maskRaw(called.error, RAW_ERROR_MAX, { unmasked, secrets }))
						: pageError(called.error);
				if (!("output" in called))
					return { ok: false, error: "The page returned an unexpected WebMCP result." };
				return shownOutput(
					`### Result\nWebMCP tool ${request.tool} returned:`,
					maskOutput(called.output, { unmasked, secrets: hidden }),
					page().join("\n"),
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
			case "network": {
				const options = { unmasked, secrets };
				const values = request.values === true;
				if (values) {
					const refused = await allowValues(tab, context, signal);
					if (refused) return refused;
				}
				await beforeDeadline(syncShim(tab.id, false));
				const action =
					request.since === "clear"
						? { kind: "clear" as const }
						: { kind: "read" as const, values, ...(request.since === undefined ? {} : { since: request.since }) };
				const raw = (await beforeDeadline(
					inMain(tab, pwExtNetwork as never, [action, tab.url, tab.groupId ?? -1]),
				)) as { error?: unknown; cleared?: unknown } | null;
				if (typeof raw?.error === "string") return failed(maskRaw(raw.error, RAW_ERROR_MAX, options));
				if (request.since === "clear") {
					if (!Number.isSafeInteger(raw?.cleared)) throw new Refusal(BAD_NETWORK);
					return shown([...page(), "### Network", `Cleared ${raw?.cleared} captured requests on this page.`].join("\n"));
				}
				let entries: ReturnType<typeof validateNetworkEntries>;
				try {
					entries = validateNetworkEntries(raw);
				} catch {
					throw new Refusal(BAD_NETWORK);
				}
				const lines = formatNetwork(entries, {
					values,
					value: (text) => maskRaw(maskRaw(text, RAW_OUTPUT_MAX, options).replace(/%40/gi, "@"), RAW_OUTPUT_MAX, options),
					...(request.filter === undefined ? {} : { filter: request.filter }),
					...(request.limit === undefined ? {} : { limit: request.limit }),
				});
				return shown([...page(), "### Network", ...lines].join("\n"));
			}
			case "storage": {
				const options = { unmasked, secrets };
				const values = request.values === true;
				if (values) {
					const refused = await allowValues(tab, context, signal);
					if (refused) return refused;
				}
				const area = request.area ?? "local";
				await beforeDeadline(syncShim(tab.id, false));
				const raw = (await beforeDeadline(
					inMain(tab, pwExtNetwork as never, [
						{
							kind: "storage",
							area,
							...(request.key === undefined ? {} : { key: request.key }),
							...(request.keysOnly ? { keysOnly: true } : {}),
							values,
						},
						tab.url,
						tab.groupId ?? -1,
					]),
				)) as { error?: unknown } | null;
				if (typeof raw?.error === "string") return failed(maskRaw(raw.error, RAW_ERROR_MAX, options));
				let result: ReturnType<typeof validateStorageResult>;
				try {
					result = validateStorageResult(raw);
				} catch {
					throw new Refusal(BAD_STORAGE);
				}
				const lines = formatStorage(result.items, result.total, {
					values,
					value: (text) => maskRaw(maskRaw(text, RAW_OUTPUT_MAX, options).replace(/%40/gi, "@"), RAW_OUTPUT_MAX, options),
				});
				return shown([...page(), `### Storage (${area})`, ...lines].join("\n"));
			}
			case "fetch": {
				const options = { unmasked, secrets };
				const values = request.values === true;
				const method = request.method ?? "GET";
				let target: URL;
				try {
					target = new URL(request.url as string, tab.url);
				} catch {
					return failed("The address is not valid; nothing was sent.");
				}
				if (target.origin !== new URL(tab.url as string).origin)
					return failed(`pw --ext fetch sends requests only to the tab's own origin, ${new URL(tab.url as string).origin}; nothing was sent.`);
				if (values || request.auth === "page" || (method !== "GET" && method !== "HEAD")) {
					const refused = await allowValues(tab, context, signal);
					if (refused) return refused;
				}
				await beforeDeadline(syncShim(tab.id, false));
				const raw = (await withDeadline(FETCH_DEADLINE_MS, inMain(tab, pwExtNetwork as never, [
					{
						kind: "fetch",
						url: target.href,
						method,
						...(request.body === undefined ? {} : { body: request.body }),
						...(request.contentType === undefined ? {} : { contentType: request.contentType }),
						headers: request.headers ?? [],
						auth: request.auth === "page",
						values,
					},
					tab.url,
					tab.groupId ?? -1,
				]))) as { error?: unknown } | null;
				if (typeof raw?.error === "string") return failed(maskRaw(raw.error, RAW_ERROR_MAX, options));
				let entries: ReturnType<typeof validateNetworkEntries>;
				try {
					entries = validateNetworkEntries(raw);
				} catch {
					throw new Refusal(BAD_NETWORK);
				}
				const lines = formatNetwork(entries, {
					values,
					value: (text) => maskRaw(maskRaw(text, RAW_OUTPUT_MAX, options).replace(/%40/gi, "@"), RAW_OUTPUT_MAX, options),
				}).slice(1, -1);
				return shown([...page(), "### Fetch", ...lines].join("\n"));
			}
			case "credential": {
				const refused = await allowValues(tab, context, signal);
				if (refused) return refused;
				if (new URL(tab.url as string).protocol !== "https:")
					return failed(`pw --ext credential save works only on https pages. ${NOT_SAVED}`);
				const site = credentialSite(tab.url as string);
				if (!site) return failed(`pw --ext credential save needs a site with a domain name or an IP address. ${NOT_SAVED}`);
				const source = request.source as NonNullable<PwExtRequest["source"]>;
				const key = request.key as string;
				const label = `${source} ${source === "header" ? key.toLowerCase() : key}`;
				let value: string | undefined;
				let expiresAt: string | undefined;
				try {
					if (source === "cookie") {
						if (!api.cookies) return failed(`This browser gives pw --ext no cookie access. ${NOT_SAVED}`);
						const cookie = await api.cookies.get({ url: tab.url as string, name: key });
						value = cookie?.value || undefined;
						if (cookie?.expirationDate !== undefined) expiresAt = new Date(cookie.expirationDate * 1000).toISOString();
					} else {
						await beforeDeadline(syncShim(tab.id, false));
						const raw = (await beforeDeadline(
							inMain(tab, pwExtNetwork as never, [
								source === "header"
									? { kind: "sealed-get", name: key.toLowerCase() }
									: { kind: "storage-get", area: source, key },
								tab.url,
								tab.groupId ?? -1,
							]),
						)) as { value?: unknown } | null;
						value = typeof raw?.value === "string" && raw.value !== "" ? raw.value : undefined;
					}
				} catch (error) {
					if (error instanceof Refusal) throw error;
					return failed(`Could not read the ${label}. ${NOT_SAVED}`);
				}
				if (value === undefined)
					return failed(
						source === "header"
							? `No ${key.toLowerCase()} header was seen on this page since the approval. Act in the page, for example open a folder, then retry. ${NOT_SAVED}`
							: `No ${label} on this site. ${NOT_SAVED}`,
					);
				if (request.path !== undefined) {
					value = jsonPath(value, request.path);
					if (value === undefined || value === "")
						return failed(`The ${label} has no string or number at --path ${request.path}. ${NOT_SAVED}`);
				}
				expiresAt ??= jwtExpiry(value);
				const meta = {
					site: new URL(tab.url as string).origin,
					source: `${source}:${source === "header" ? key.toLowerCase() : key}${request.path === undefined ? "" : `#${request.path}`}`,
					createdBy: "pw --ext credential save",
					capturedAt: new Date(now()).toISOString(),
					...(expiresAt === undefined ? {} : { expiresAt }),
				};
				if (signal?.aborted) return CANCELED;
				if (await isStopped(context.sessionId)) return STOPPED;
				const live = await api.tabs.get(tab.id).catch(() => undefined);
				if (
					!live ||
					live.url !== tab.url ||
					!(await agentTabs.owns({ sessionId: context.sessionId, tabId: tab.id })) ||
					!(await control.valuesAllowed(context.sessionId, valuesSiteOf(tab.url as string)))
				)
					return failed(`The tab or its approval changed during the save. ${NOT_SAVED}`);
				if ((await grants.reserve(context.sessionId, value)) === "full")
					return failed(`This session already holds ${MAX_FILLED_SECRETS} secret values; start a new dg session to save more. ${NOT_SAVED}`);
				if (signal?.aborted) return CANCELED;
				if (await isStopped(context.sessionId)) return STOPPED;
				let stored: string;
				try {
					stored = await context.storeCredential({ site, name: request.name as string, value, meta });
				} catch (error) {
					const reason = error instanceof Error ? error.message : "dg daemon refused the save.";
					return { ok: false, error: clip(redactLiterals(reason, [value]), 300) };
				}
				return ok(
					[
						"### Result",
						`Saved ${stored} from the ${label}${request.path === undefined ? "" : ` at ${request.path}`}${expiresAt === undefined ? "" : `, expires ${expiresAt}`}.`,
						`The value was not shown. Use it with: dg credentials exec ${stored}=NAME -- <command>`,
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
				const [front, frontWindow] = await Promise.all([api.tabs.get(tab.id), api.windows.get(windowId)]);
				if (frontWindow.state === "minimized") return { ok: false, error: SHOT_MINIMIZED };
				if (front.active === false) return { ok: false, error: SHOT_INACTIVE };
				await beforeCaptureDeadline(
					api.scripting.executeScript({
						target: { tabId: tab.id },
						func: nextFrame,
						args: [],
					}),
					tab.id,
					windowId,
				);
				if (signal?.aborted) return CANCELED;
				const watch = watchTab(tab);
				let captured: string;
				try {
					captured = await beforeCaptureDeadline(
						api.tabs.captureVisibleTab(windowId, {
							format: "jpeg",
							quality: JPEG_QUALITY,
						}),
						tab.id,
						windowId,
					);
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
							: request.verb === "press"
								? { kind: "press", chord: request.key as string, ...(parseKeyChord(request.key as string) as KeyChord) }
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
				const result = await inPage(tab, action, unmasked, hidden);
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

	/** A tool keeps its class-table class only when its enabled built-in covers the origin and no third-party script ran in this document. */
	async function builtInOwned(tab: LiveTab, tool: string, origin: string): Promise<boolean> {
		if (!mailboxToolAllowed(tool, origin, await enabledOrNone())) return false;
		const sites = await thirdPartySites().catch(() => undefined);
		if (!sites || matchesCoverOrigin(sites.active, origin)) return false;
		const stopped = sites.stopped.filter((entry) => matchesCoverOrigin(entry.matches, origin));
		if (stopped.length === 0) return true;
		const started = await api.scripting
			.executeScript({ target: { tabId: tab.id }, func: pwExtDocumentStart, args: [] })
			.then(([frame]) => frame?.result)
			.catch(() => undefined);
		return typeof started === "number" && stopped.every((entry) => entry.stoppedAt < started);
	}

	async function askDgTool(
		tool: string,
		args: Record<string, unknown>,
		tab: LiveTab,
		context: PwExtContext,
		tabTitle?: string,
	): Promise<PwExtResult | undefined> {
		if (tab.url === undefined) return { ok: false, error: `This tab has no page address; ${tool} did not run.` };
		const origin = new URL(tab.url).origin;
		const tableClass = approvalClassOf(tool, origin) ?? "each";
		const approvalClass = tableClass !== "each" && (await builtInOwned(tab, tool, origin)) ? tableClass : "each";
		if (approvalClass === "read") return undefined;
		const answer = await requestWebMcpApproval({
			approvals: approvals ?? browserApprovals(),
			grants: webmcpGrants,
			remembered: rememberedWebMcpGrants,
			sessionId: context.sessionId,
			agentIdentity: context.agentIdentity,
			tool,
			args,
			origin,
			class: approvalClass,
			...(tabTitle === undefined ? {} : { tabTitle }),
		});
		if (answer === "allow") return undefined;
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

	async function approveDgTool(
		request: TabVerbRequest,
		tab: LiveTab,
		context: PwExtContext,
		signal: AbortSignal | undefined,
	): Promise<PwExtResult | undefined> {
		const tool = request.tool as string;
		const refused = await askDgTool(tool, request.args ?? {}, tab, context);
		if (signal?.aborted) return CANCELED;
		if (refused) return refused;
		const live = await api.tabs.get(tab.id).catch(() => undefined);
		if (
			!live ||
			live.groupId !== tab.groupId ||
			!(await agentTabs.owns({ sessionId: context.sessionId, tabId: tab.id }))
		)
			return { ok: false, error: `The tab left the agent's group; ${tool} did not run.` };
		if (live.url !== tab.url)
			return { ok: false, error: `The page changed while the approval was open; ${tool} did not run. Retry.` };
		return undefined;
	}

	/** The person's normal tabs that an enabled built-in or approved third-party script covers, the focused one first, then the most recently used. */
	async function webMcpTabs(): Promise<LiveTab[]> {
		const [all, enabled, running, focused] = await Promise.all([
			api.tabs.query({}),
			enabledOrNone(),
			runningThirdParty().catch(() => []),
			api.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined),
		]);
		const covered = (url: string) => {
			const origin = new URL(url).origin;
			return (
				BUILT_IN_SCRIPTS.some((script) => enabled.has(script.id) && matchesCoverOrigin(script.matches, origin)) ||
				matchesCoverOrigin(running, origin)
			);
		};
		const focusedFirst = (tab: BrowserTab) => (tab.active && focused?.id !== undefined && tab.windowId === focused.id ? 1 : 0);
		return all
			.filter(
				(tab): tab is LiveTab =>
					tab.id !== undefined && !tab.incognito && !tab.discarded && allowedPage(tab.url) && covered(tab.url),
			)
			.sort((a, b) => focusedFirst(b) - focusedFirst(a) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
			.slice(0, MAX_WEBMCP_TABS);
	}

	/** The dg_ tools a tab exposes; on a mailbox tab only those of an enabled built-in that covers it. */
	async function webMcpToolsOf(tab: LiveTab, secrets: string[]): Promise<PwExtTool[]> {
		const listed = await beforeDeadline(inMain(tab, pwExtWebMcp as never, [{ kind: "tools" }, tab.url]))
			.then(webMcpResult)
			.catch(() => undefined);
		if (!listed || !("tools" in listed)) return [];
		const origin = new URL(tab.url as string).origin;
		const enabled = mailbox(tab.url) ? await enabledOrNone() : undefined;
		return boundTools(
			listed.tools.filter((tool) => isDgToolName(tool.name) && (!enabled || mailboxToolAllowed(tool.name, origin, enabled))),
			{ unmasked: false, secrets },
		);
	}

	/** Lists or calls Web MCP dg_ tools on the person's own tabs; it never opens, focuses, groups or injects into a tab. */
	async function webMcp(request: WebMcpRequest, context: PwExtContext, signal: AbortSignal): Promise<PwExtResult> {
		const [tabs, secrets] = await Promise.all([webMcpTabs(), grants.secrets(context.sessionId)]);
		if (signal.aborted) return CANCELED;
		const toolsOf = (tab: LiveTab) => webMcpToolsOf(tab, secrets);
		if (request.verb === "webmcp-tools") {
			const found = new Map<string, PwExtTool>();
			let bytes = 0;
			for (const tools of await Promise.all(tabs.map(toolsOf)))
				for (const tool of tools) {
					if (found.has(tool.name) || found.size >= PW_EXT_MAX_TOOLS) continue;
					const size = new TextEncoder().encode(JSON.stringify(tool)).length;
					if (bytes + size > MAX_WEBMCP_LIST_BYTES) continue;
					bytes += size;
					found.set(tool.name, tool);
				}
			const tools = [...found.values()];
			const rows = tools.length
				? tools.map((tool) => `- ${tool.name}`)
				: ["No open browser tab exposes a dg Web MCP tool."];
			return { ok: true, data: { text: clean(["### WebMCP tools", ...rows].join("\n"), { secrets }), tools } };
		}
		const tool = request.tool as string;
		const listings = await Promise.all(tabs.map(toolsOf));
		if (signal.aborted) return CANCELED;
		const tab = tabs.find((_, index) => listings[index]?.some((entry) => entry.name === tool));
		if (!tab) return { ok: false, error: noWebMcpTab(tool) };
		await guard("call", tab, tool);
		const refused = await askDgTool(tool, request.args ?? {}, tab, context, approvalTabTitle(tab));
		if (signal.aborted) return CANCELED;
		if (refused) return refused;
		const live = await api.tabs.get(tab.id).catch(() => undefined);
		if (!live || live.incognito || live.url !== tab.url)
			return { ok: false, error: `The page changed while the approval was open; ${tool} did not run. Retry.` };
		tab.signal = signal;
		const called = webMcpResult(
			await inMain(tab, pwExtWebMcp as never, [
				{ kind: "call", tool, args: request.args, timeoutMs: TOOL_TIMEOUT_MS },
				tab.url,
			]),
		);
		const options = { unmasked: false, secrets };
		if ("error" in called)
			return { ok: false, error: mailbox(tab.url) ? MAILBOX_TOOL_FAILED : clean(maskRaw(called.error, RAW_ERROR_MAX, options), options) };
		if (!("output" in called)) return { ok: false, error: "The page returned an unexpected WebMCP result." };
		return {
			ok: true,
			data: {
				text: cap(`${mask(`### Result\nWebMCP tool ${tool} returned:`, options)}\n${maskOutput(called.output, options)}`),
			},
		};
	}

	async function runModule(request: ModuleRequest, sessionId: string): Promise<PwExtResult> {
		const at = { sessionId };
		if ((NAVIGATION_VERBS as readonly string[]).includes(request.verb)) return navigation(request as never, at);
		if ((POINTER_VERBS as readonly string[]).includes(request.verb)) return pointer(request as never, at);
		if ((INPUT_VERBS as readonly string[]).includes(request.verb)) return input(request, at);
		if ((PAGE_MODULE_VERBS as readonly string[]).includes(request.verb)) {
			const result = await pageVerbs(request, at);
			if (result.ok && request.verb === "tab-select") void syncShim(request.tabId as number, false);
			return result;
		}
		return storageVerbs(request, at);
	}

	/** Navigation, pointer and input ask the site question first; eval and storage writes need a site already allowed. */
	async function moduleVerb(
		request: ModuleRequest,
		context: PwExtContext,
		signal: AbortSignal,
		verb: number,
	): Promise<PwExtResult> {
		if (MODULE_SITE_ASK.has(request.verb)) {
			const tab = await resolveTab(request, context.sessionId);
			if (!tab) throw new Refusal((await agentTabs.list({ sessionId: context.sessionId })).length ? SELECTED_GONE : NO_TAB);
			if (tab.incognito) throw new Refusal(PW_EXT_PRIVATE_ERROR);
			if (!allowedPage(tab.url)) throw new Refusal(PW_EXT_BLOCKED_ERROR);
			if (mailbox(tab.url)) throw new Refusal(PW_EXT_MAILBOX_ERROR);
			if (tab.discarded) throw new Refusal(discardedTab(tab.id));
			await allowSite(tab.url, context, signal, verb);
			const live = await api.tabs.get(tab.id).catch(() => undefined);
			if (!live || live.groupId !== tab.groupId || !(await agentTabs.owns({ sessionId: context.sessionId, tabId: tab.id })))
				throw new Refusal(SELECTED_GONE);
			if (live.url !== tab.url) throw new Refusal("The page changed while the site question was open; nothing ran. Retry.");
		}
		if (signal.aborted) return CANCELED;
		const result = await runModule(request, context.sessionId);
		const options = { secrets: await grants.secrets(context.sessionId).catch(() => []) };
		return result.ok
			? { ok: true, data: { ...result.data, text: clean(result.data.text, options) } }
			: { ok: false, error: clean(result.error, options) };
	}

	async function execute(
		request: PwExtRequest,
		context: PwExtContext,
		signal: AbortSignal,
		verb: number,
	): Promise<PwExtResult> {
		if (signal.aborted) return CANCELED;
		if (isWebMcpVerb(request)) return webMcp(request, context, signal);
		if (isModuleRequest(request)) return moduleVerb(request, context, signal, verb);
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
		if (siteAllow && CAPTURE_VERBS.has(request.verb))
			await siteAllow.assertCaptureAllowed(context.sessionId, tab.url as string).catch((error: unknown) => {
				throw error instanceof PhiCaptureRefusedError ? new Refusal(error.message) : error;
			});
		if (!NO_SITE_ASK.has(request.verb)) {
			if (!WEB_MCP_VERBS.has(request.verb))
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
