import {
	BUILT_IN_SCRIPTS,
	createSerialQueue,
	describeError,
	validateWebMcpScriptRecord,
	WEBMCP_MAX_MATCHES,
	WEBMCP_MAX_SCRIPTS,
	WEBMCP_SCRIPT_MAX_BYTES,
	type WebMcpScriptRecord,
} from "@dg/common";
import { defaultIsChromium } from "@/lib/browser-call";
import { createWebMcpSigner, type WebMcpSigner } from "./webmcp-signing";

export const WEBMCP_MESSAGES = {
	list: "dg-webmcp:list",
	code: "dg-webmcp:code",
	add: "dg-webmcp:add",
	approve: "dg-webmcp:approve",
	setEnabled: "dg-webmcp:set-enabled",
	replace: "dg-webmcp:replace",
	remove: "dg-webmcp:remove",
} as const;

export type WebMcpReply = { ok: true; value?: unknown } | { ok: false; error: string };

/** A listed script; problem says why an enabled script is not running. */
export type WebMcpScriptRow = WebMcpScriptRecord & { problem?: string };

export const USER_SCRIPTS_OFF =
	"Not running: Allow User Scripts is off for dg-ai-extension (chrome://extensions, or brave://extensions in Brave). Turn it on, then reopen this page.";
const NOT_KEPT = "The browser did not keep the registration.";

const RECORDS_KEY = "webmcpScripts";
export const STOPPED_SCRIPTS_KEY = "webmcpStoppedScripts";
const STOPPED_MAX = 100;

/** Sites of a third-party script that stopped; documents loaded before stoppedAt may still hold its tools. */
export type WebMcpStoppedScript = { matches: string[]; stoppedAt: number };
/** Folds the oldest entries into one that covers all their sites until the latest of them stopped. */
function foldOldest(entries: WebMcpStoppedScript[]): WebMcpStoppedScript[] {
	const folded = entries.slice(0, entries.length - STOPPED_MAX + 1);
	return [
		{
			matches: [...new Set(folded.flatMap((entry) => entry.matches))],
			stoppedAt: Math.max(...folded.map((entry) => entry.stoppedAt)),
		},
		...entries.slice(entries.length - STOPPED_MAX + 1),
	];
}
const codeKey = (id: string) => `webmcpScriptCode:${id}`;
const approvalKey = (id: string) => `webmcpApproval:${id}`;
const macKey = (id: string) => `webmcpMac:${id}`;
const SHIM_FILE = "webmcp-shim.js";
const OPTIONS_PAGE = "/options.html";
const EMPTY_HASH = "0".repeat(64);

export type WebMcpStorage = {
	local: {
		get(keys: string | string[] | null): Promise<Record<string, unknown>>;
		set(items: Record<string, unknown>): Promise<void>;
		remove(keys: string | string[]): Promise<void>;
	};
};

export type WebMcpScripting = {
	registerContentScripts(scripts: Record<string, unknown>[]): Promise<void>;
	unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
	getRegisteredContentScripts(): Promise<{ id: string }[]>;
};

export type WebMcpUserScripts = {
	register(scripts: Record<string, unknown>[]): Promise<void>;
	unregister(filter: { ids: string[] }): Promise<void>;
	getScripts(): Promise<{ id: string; matches?: string[] }[]>;
};

export type WebMcpScriptDraft = {
	name: string;
	matches: string[];
	code: string;
	source?: "paste" | "file";
};

export type WebMcpScripts = ReturnType<typeof createWebMcpScripts>;

const REVIEW_AGAIN = "Script code changed; review it again.";
const BUILT_IN_PREFIX = "dg-webmcp-";
const USER_PREFIX = "dg-webmcp-user-";

async function sha256Hex(text: string): Promise<string> {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** True only in a Chromium build where chrome.userScripts.getScripts() answers. */
export function userScriptsAvailable({
	isChromium = defaultIsChromium,
	chromeApi = (globalThis as { chrome?: object }).chrome ?? {},
}: { isChromium?: () => boolean; chromeApi?: object } = {}): boolean {
	if (!isChromium()) return false;
	try {
		const api = (chromeApi as { userScripts?: { getScripts(): unknown } }).userScripts;
		if (!api) return false;
		const probe = api.getScripts();
		if (probe instanceof Promise) probe.catch(() => undefined);
		return true;
	} catch {
		return false;
	}
}

function withoutApproval({ approvedAt: _cleared, ...rest }: WebMcpScriptRecord): WebMcpScriptRecord {
	return rest;
}

function assertCodeSize(code: string): void {
	if (new TextEncoder().encode(code).length > WEBMCP_SCRIPT_MAX_BYTES)
		throw new Error(`Script code exceeds ${WEBMCP_SCRIPT_MAX_BYTES} bytes`);
}

/** Script records and code in storage.local; only the injected scripting and userScripts seams register anything. */
export function createWebMcpScripts({
	signer,
	storage,
	scripting,
	userScripts,
	digest = sha256Hex,
	newId = () => crypto.randomUUID(),
	now = Date.now,
}: {
	signer: WebMcpSigner;
	storage: WebMcpStorage;
	scripting: WebMcpScripting | null;
	userScripts: (() => WebMcpUserScripts | null | undefined) | null;
	digest?: (text: string) => Promise<string>;
	newId?: () => string;
	now?: () => number;
}) {
	const enqueue = createSerialQueue((error) =>
		console.warn("[dg-ai-extension] web mcp reconcile failed", describeError(error)),
	);
	function locked<T>(task: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			void enqueue(async () => {
				try {
					resolve(await task());
				} catch (error) {
					reject(error);
				}
			});
		});
	}
	const builtInIds = new Set<string>(BUILT_IN_SCRIPTS.map((script) => script.id));

	async function readStored(): Promise<WebMcpScriptRecord[]> {
		const stored = (await storage.local.get(RECORDS_KEY))[RECORDS_KEY];
		if (!Array.isArray(stored)) return [];
		return stored.flatMap((entry) => {
			try {
				const record = validateWebMcpScriptRecord(entry);
				return (record.source === "built-in") === builtInIds.has(record.id) ? [record] : [];
			} catch {
				return [];
			}
		});
	}

	const writeStored = (records: WebMcpScriptRecord[]) => storage.local.set({ [RECORDS_KEY]: records });

	const approvalDigest = (code: string, matches: string[]) => digest(`${code}\n${JSON.stringify(matches)}`);

	async function storedCode(id: string): Promise<string | undefined> {
		const code = (await storage.local.get(codeKey(id)))[codeKey(id)];
		return typeof code === "string" ? code : undefined;
	}

	function merge(stored: WebMcpScriptRecord[]): WebMcpScriptRecord[] {
		const builtIns = BUILT_IN_SCRIPTS.map(({ enabledByDefault, ...script }) => ({
			...script,
			matches: [...script.matches],
			sha256: EMPTY_HASH,
			source: "built-in" as const,
			enabled: stored.find((record) => record.id === script.id)?.enabled ?? enabledByDefault,
		}));
		return [...builtIns, ...stored.filter((record) => !builtInIds.has(record.id))];
	}

	async function mutate(change: (records: WebMcpScriptRecord[]) => WebMcpScriptRecord[]): Promise<void> {
		await writeStored(change(await readStored()));
	}

	async function requireThirdParty(id: string): Promise<WebMcpScriptRecord> {
		const record = (await readStored()).find((entry) => entry.id === id && !builtInIds.has(id));
		if (!record) throw new Error(`Unknown script ${id}`);
		return record;
	}

	const failures = new Map<string, string>();

	async function recorded(recordId: string, scriptId: string, task: () => Promise<void>): Promise<void> {
		try {
			await task();
		} catch (error) {
			failures.set(recordId, describeError(error));
			console.warn(`[dg-ai-extension] web mcp registration of ${scriptId} failed`, describeError(error));
		}
	}

	function keptOrFailed(wanted: Map<string, WebMcpScriptRecord>, live: string[] | null): void {
		for (const [id, record] of wanted)
			if (!failures.has(record.id) && !live?.includes(id)) {
				failures.set(record.id, NOT_KEPT);
				console.warn(`[dg-ai-extension] web mcp registration of ${id} failed`, NOT_KEPT);
			}
	}

	const unregisterBuiltIn = (id: string) =>
		scripting ? scripting.unregisterContentScripts({ ids: [id] }).catch(() => undefined) : Promise.resolve();
	function userRegistrar(): WebMcpUserScripts | null {
		try {
			return userScripts?.() ?? null;
		} catch {
			return null;
		}
	}
	const unregisterUser = async (id: string): Promise<void> => {
		await userRegistrar()
			?.unregister({ ids: [id] })
			.catch(() => undefined);
	};

	async function noteStopped(matches: string[]): Promise<void> {
		const stored = (await storage.local.get(STOPPED_SCRIPTS_KEY))[STOPPED_SCRIPTS_KEY];
		const held = Array.isArray(stored) ? (stored as WebMcpStoppedScript[]) : [];
		const all = [...held, { matches: [...matches], stoppedAt: now() }];
		await storage.local.set({ [STOPPED_SCRIPTS_KEY]: all.length > STOPPED_MAX ? foldOldest(all) : all });
	}

	async function stopUser(id: string, matches: string[]): Promise<void> {
		await unregisterUser(id);
		await noteStopped(matches);
	}

	const macPayload = async (record: WebMcpScriptRecord, code: string, approvedAt: number) =>
		new TextEncoder().encode(
			JSON.stringify([record.id, record.sha256, record.matches, approvedAt, await approvalDigest(code, record.matches)]),
		);

	type ApprovalCheck = { verified: Map<string, string>; stale: Set<string>; keyFailed: boolean };

	async function checkApprovals(stored: WebMcpScriptRecord[]): Promise<ApprovalCheck> {
		const verified = new Map<string, string>();
		const stale = new Set<string>();
		for (const record of stored) {
			if (builtInIds.has(record.id) || record.approvedAt === undefined) continue;
			const code = await storedCode(record.id);
			const local = await storage.local.get([approvalKey(record.id), macKey(record.id)]);
			const mac = local[macKey(record.id)];
			if (
				code === undefined ||
				typeof mac !== "string" ||
				(await digest(code)) !== record.sha256 ||
				local[approvalKey(record.id)] !== (await approvalDigest(code, record.matches))
			) {
				stale.add(record.id);
				continue;
			}
			try {
				if (await signer.verify(await macPayload(record, code, record.approvedAt), mac)) verified.set(record.id, code);
				else stale.add(record.id);
			} catch {
				return { verified: new Map(), stale: new Set(), keyFailed: true };
			}
		}
		return { verified, stale, keyFailed: false };
	}

	let keyWarned = false;

	async function verifiedApprovals(stored: WebMcpScriptRecord[]): Promise<Map<string, string>> {
		const { verified, stale, keyFailed } = await checkApprovals(stored);
		if (keyFailed && !keyWarned) {
			keyWarned = true;
			console.warn("[dg-ai-extension] web mcp signing key unavailable: third-party scripts stay off");
		}
		if (stale.size > 0)
			await mutate((records) => records.map((record) => (stale.has(record.id) ? withoutApproval(record) : record)));
		return verified;
	}

	async function liveIds(read: () => Promise<{ id: string }[]>): Promise<string[] | null> {
		try {
			return (await read()).map((entry) => entry.id);
		} catch {
			return null;
		}
	}

	async function reconcileBuiltIns(registrar: WebMcpScripting, records: WebMcpScriptRecord[]): Promise<void> {
		const own = records.filter((record) => builtInIds.has(record.id));
		const wanted = new Map<string, WebMcpScriptRecord>(own.filter((record) => record.enabled).map((record) => [`${BUILT_IN_PREFIX}${record.id}`, record] as const));
		const live = (await liveIds(() => registrar.getRegisteredContentScripts())) ?? [];
		const stale = new Set<string>([
			...live.filter((id) => id.startsWith(BUILT_IN_PREFIX) && !id.startsWith(USER_PREFIX)),
			...own.map((record) => `${BUILT_IN_PREFIX}${record.id}`),
		]);
		for (const id of stale) if (!wanted.has(id)) await unregisterBuiltIn(id);
		for (const [id, record] of wanted) {
			await unregisterBuiltIn(id);
			await recorded(record.id, id, () =>
					registrar.registerContentScripts([
						{
							id,
							js: [`content-scripts/webmcp-${record.id}-main.js`],
							matches: record.matches,
							world: "MAIN",
							runAt: "document_start",
						},
					]),
			);
		}
		keptOrFailed(wanted, await liveIds(() => registrar.getRegisteredContentScripts()));
	}

	async function reconcileThirdParty(
		registrar: WebMcpUserScripts,
		records: WebMcpScriptRecord[],
		approved: Map<string, string>,
	): Promise<boolean> {
		let entries: { id: string; matches?: string[] }[];
		try {
			entries = await registrar.getScripts();
		} catch {
			return false;
		}
		const live = entries.map((entry) => entry.id);
		const own = records.filter((record) => !builtInIds.has(record.id));
		const wanted = new Map<string, WebMcpScriptRecord>(
			own
				.filter((record) => record.enabled && approved.has(record.id))
				.map((record) => [`${USER_PREFIX}${record.id}`, record] as const),
		);
		const stale = new Set<string>([
			...live.filter((id) => id.startsWith(USER_PREFIX)),
			...own.map((record) => `${USER_PREFIX}${record.id}`),
		]);
		for (const id of stale) {
			if (wanted.has(id)) continue;
			const running = entries.find((entry) => entry.id === id);
			if (running) await stopUser(id, running.matches ?? []);
			else await unregisterUser(id);
		}
		for (const [id, record] of wanted) {
			await unregisterUser(id);
			await recorded(record.id, id, () =>
					registrar.register([
						{
							id,
							js: [{ file: SHIM_FILE }, { code: approved.get(record.id) }],
							matches: record.matches,
							world: "MAIN",
							runAt: "document_idle",
						},
					]),
			);
		}
		keptOrFailed(wanted, await liveIds(() => registrar.getScripts()));
		return true;
	}

	async function runReconcile(): Promise<void> {
		failures.clear();
		const approved = await verifiedApprovals(await readStored());
		const records = merge(await readStored());
		if (scripting) await reconcileBuiltIns(scripting, records);
		if (!userScripts) return;
		const registrar = userRegistrar();
		if (registrar && (await reconcileThirdParty(registrar, records, approved))) return;
		if (approved.size > 0)
			console.warn(
				"[dg-ai-extension] web mcp third-party scripts skipped: turn on Allow User Scripts for dg-ai-extension on chrome://extensions",
			);
	}

	const reconcile = () => locked(runReconcile);

	async function listed(): Promise<WebMcpScriptRecord[]> {
		const stored = await readStored();
		const { verified } = await checkApprovals(stored);
		return merge(
			stored.map((record) =>
				!builtInIds.has(record.id) && record.approvedAt !== undefined && !verified.has(record.id)
					? withoutApproval(record)
					: record,
			),
		);
	}

	const userId = (record: WebMcpScriptRecord) => `${USER_PREFIX}${record.id}`;

	async function liveUser(): Promise<string[] | null> {
		const registrar = userScripts ? userRegistrar() : null;
		return registrar ? liveIds(() => registrar.getScripts()) : null;
	}

	const notRunning = (record: WebMcpScriptRecord): WebMcpScriptRow => ({
		...record,
		problem: `Not running: ${failures.get(record.id) ?? NOT_KEPT}`,
	});

	function withProblem(record: WebMcpScriptRecord, liveUserIds: string[] | null, liveBuiltIns: string[] | null): WebMcpScriptRow {
		if (!record.enabled) return record;
		if (builtInIds.has(record.id))
			return liveBuiltIns === null || liveBuiltIns.includes(`${BUILT_IN_PREFIX}${record.id}`) ? record : notRunning(record);
		if (record.approvedAt === undefined) return record;
		if (liveUserIds === null) return { ...record, problem: USER_SCRIPTS_OFF };
		return liveUserIds.includes(userId(record)) ? record : notRunning(record);
	}

	return {
		/** Lists every script with why an enabled one is not running; first registers an approved script the browser lacks. */
		async list(): Promise<WebMcpScriptRow[]> {
			let records = await listed();
			let liveUserIds = await liveUser();
			const missing = (ids: string[]) =>
				records.some(
					(record) =>
						!builtInIds.has(record.id) && record.enabled && record.approvedAt !== undefined && !ids.includes(userId(record)),
				);
			if (liveUserIds !== null && missing(liveUserIds)) {
				await reconcile();
				records = await listed();
				liveUserIds = await liveUser();
			}
			const liveBuiltIns = scripting ? await liveIds(() => scripting.getRegisteredContentScripts()) : null;
			return records.map((record) => withProblem(record, liveUserIds, liveBuiltIns));
		},

		code: storedCode,

		addThirdParty({ name, matches, code, source = "paste" }: WebMcpScriptDraft): Promise<WebMcpScriptRecord> {
			return locked(async () => {
				if (source !== "paste" && source !== "file")
					throw new Error("Third-party scripts use the paste or file source");
				assertCodeSize(code);
				const stored = await readStored();
				if (stored.filter((record) => !builtInIds.has(record.id)).length >= WEBMCP_MAX_SCRIPTS)
					throw new Error(`At most ${WEBMCP_MAX_SCRIPTS} third-party scripts are allowed`);
				const record = validateWebMcpScriptRecord({
					id: newId(),
					name,
					matches,
					sha256: await digest(code),
					source,
					enabled: false,
				});
				await storage.local.set({ [codeKey(record.id)]: code });
				await writeStored([...stored, record]);
				return record;
			});
		},

		approve(id: string, expectedSha256: string): Promise<void> {
			return locked(async () => {
				const record = await requireThirdParty(id);
				const code = await storedCode(id);
				if (code === undefined) throw new Error(`Script ${id} has no stored code`);
				assertCodeSize(code);
				const sha256 = await digest(code);
				if (sha256 !== expectedSha256 || sha256 !== record.sha256) throw new Error(REVIEW_AGAIN);
				const approvedAt = now();
				const mac = await signer.sign(await macPayload(record, code, approvedAt));
				await storage.local.set({
					[approvalKey(id)]: await approvalDigest(code, record.matches),
					[macKey(id)]: mac,
				});
				await mutate((records) =>
					records.map((entry) => (entry.id === id ? { ...entry, enabled: true, approvedAt } : entry)),
				);
				await runReconcile();
			});
		},

		setEnabled(id: string, enabled: boolean): Promise<void> {
			return locked(async () => {
				let stopping: WebMcpScriptRecord | undefined;
				await mutate((records) => {
					const before = records.find((record) => record.id === id);
					if (before && !builtInIds.has(id) && before.enabled && !enabled) stopping = before;
					if (before) {
						return records.map((record) => (record.id === id ? { ...record, enabled } : record));
					}
					const builtIn = BUILT_IN_SCRIPTS.find((script) => script.id === id);
					if (!builtIn) throw new Error(`Unknown script ${id}`);
					return [
						...records,
						validateWebMcpScriptRecord({
							id: builtIn.id,
							name: builtIn.name,
							matches: [...builtIn.matches],
							sha256: EMPTY_HASH,
							source: "built-in",
							enabled,
						}),
					];
				});
				if (stopping) await stopUser(`${USER_PREFIX}${id}`, stopping.matches);
				await runReconcile();
			});
		},

		replaceCode(id: string, code: string): Promise<void> {
			return locked(async () => {
				const before = await requireThirdParty(id);
				assertCodeSize(code);
				const sha256 = await digest(code);
				await storage.local.set({ [codeKey(id)]: code });
				await storage.local.remove([approvalKey(id), macKey(id)]);
				await mutate((records) =>
					records.map((record) => (record.id === id ? { ...withoutApproval(record), sha256 } : record)),
				);
				await stopUser(`${USER_PREFIX}${id}`, before.matches);
				await runReconcile();
			});
		},

		remove(id: string): Promise<void> {
			return locked(async () => {
				if (builtInIds.has(id)) throw new Error("Built-in scripts cannot be removed");
				const before = await requireThirdParty(id);
				await mutate((records) => records.filter((record) => record.id !== id));
				await storage.local.remove([codeKey(id), approvalKey(id), macKey(id)]);
				await stopUser(`${USER_PREFIX}${id}`, before.matches);
				await runReconcile();
			});
		},

		reconcile,
	};
}

function chromiumUserScripts(): WebMcpUserScripts | null {
	if (!defaultIsChromium()) return null;
	try {
		return (globalThis as unknown as { chrome?: { userScripts?: WebMcpUserScripts } }).chrome?.userScripts ?? null;
	} catch {
		return null;
	}
}

const ID_MAX_CHARS = 64;
const SHA256_CHARS = 64;
const NAME_MAX_CHARS = 100;
const MATCH_MAX_CHARS = 200;

function text(message: Record<string, unknown>, key: string, max: number): string {
	const value = message[key];
	if (typeof value !== "string" || value.length > max)
		throw new Error(`Invalid request: ${key} must be text of at most ${max} characters`);
	return value;
}

function matchList(message: Record<string, unknown>): string[] {
	const value = message.matches;
	if (
		!Array.isArray(value) ||
		value.length > WEBMCP_MAX_MATCHES ||
		value.some((entry) => typeof entry !== "string" || entry.length > MATCH_MAX_CHARS)
	)
		throw new Error(`Invalid request: matches must be a list of at most ${WEBMCP_MAX_MATCHES} patterns`);
	return value as string[];
}

async function dispatch(scripts: WebMcpScripts, message: Record<string, unknown>): Promise<unknown> {
	switch (message.type) {
		case WEBMCP_MESSAGES.list:
			return scripts.list();
		case WEBMCP_MESSAGES.code:
			return scripts.code(text(message, "id", ID_MAX_CHARS));
		case WEBMCP_MESSAGES.add:
			return scripts.addThirdParty({
				name: text(message, "name", NAME_MAX_CHARS),
				matches: matchList(message),
				code: text(message, "code", WEBMCP_SCRIPT_MAX_BYTES),
				source: message.source === "file" ? "file" : "paste",
			});
		case WEBMCP_MESSAGES.approve:
			return scripts.approve(text(message, "id", ID_MAX_CHARS), text(message, "sha256", SHA256_CHARS));
		case WEBMCP_MESSAGES.setEnabled:
			if (typeof message.enabled !== "boolean") throw new Error("Invalid request: enabled must be true or false");
			return scripts.setEnabled(text(message, "id", ID_MAX_CHARS), message.enabled);
		case WEBMCP_MESSAGES.replace:
			return scripts.replaceCode(text(message, "id", ID_MAX_CHARS), text(message, "code", WEBMCP_SCRIPT_MAX_BYTES));
		case WEBMCP_MESSAGES.remove:
			return scripts.remove(text(message, "id", ID_MAX_CHARS));
		default:
			throw new Error("Unknown request");
	}
}

/** Validates one options-page request and runs it through the shared registry. */
export async function handleWebMcpRequest(scripts: WebMcpScripts, message: unknown): Promise<WebMcpReply> {
	try {
		return { ok: true, value: await dispatch(scripts, (message ?? {}) as Record<string, unknown>) };
	} catch (error) {
		return { ok: false, error: describeError(error) };
	}
}

type RegistryApi = {
	runtime: {
		id: string;
		getURL(path: string): string;
		onInstalled: { addListener(listener: () => void): void };
		onStartup: { addListener(listener: () => void): void };
		onMessage: {
			addListener(
				listener: (
					message: unknown,
					sender: { id?: string; url?: string },
					sendResponse: (response?: unknown) => void,
				) => true | undefined,
			): void;
		};
	};
};

const REQUEST_TYPES = new Set<string>(Object.values(WEBMCP_MESSAGES));

/** The only writer of the script registry: serves the options page, and reconciles on install and startup. */
export function registerWebMcpScripts({
	api = browser as unknown as RegistryApi,
	scripts = createWebMcpScripts({
		signer: createWebMcpSigner(),
		storage: browser.storage as unknown as WebMcpStorage,
		scripting: browser.scripting as unknown as WebMcpScripting,
		userScripts: chromiumUserScripts,
	}),
}: { api?: RegistryApi; scripts?: WebMcpScripts } = {}): void {
	const run = () => void scripts.reconcile();
	api.runtime.onInstalled.addListener(run);
	api.runtime.onStartup.addListener(run);
	const page = api.runtime.getURL(OPTIONS_PAGE);
	api.runtime.onMessage.addListener((message, sender, sendResponse) => {
		const type = (message as { type?: unknown } | null)?.type;
		if (typeof type !== "string" || !REQUEST_TYPES.has(type)) return undefined;
		if (sender.id !== api.runtime.id || (sender.url ?? "").split(/[?#]/)[0] !== page) {
			sendResponse(undefined);
			return undefined;
		}
		void handleWebMcpRequest(scripts, message).then(sendResponse);
		return true;
	});
}
