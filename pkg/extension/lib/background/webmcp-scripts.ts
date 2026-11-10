import {
	BUILT_IN_SCRIPTS,
	createSerialQueue,
	describeError,
	validateWebMcpScriptRecord,
	WEBMCP_MAX_SCRIPTS,
	WEBMCP_SCRIPT_MAX_BYTES,
	type WebMcpScriptRecord,
} from "@dg/common";
import { defaultIsChromium } from "./pw-ext";

export const WEBMCP_RECONCILE_MESSAGE = "dg-webmcp:reconcile";

const RECORDS_KEY = "webmcpScripts";
const codeKey = (id: string) => `webmcpScriptCode:${id}`;
const approvalKey = (id: string) => `webmcpApproval:${id}`;
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
	getScripts(): Promise<{ id: string }[]>;
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
	storage,
	scripting,
	userScripts,
	digest = sha256Hex,
	newId = () => crypto.randomUUID(),
	now = Date.now,
}: {
	storage: WebMcpStorage;
	scripting: WebMcpScripting | null;
	userScripts: WebMcpUserScripts | null;
	digest?: (text: string) => Promise<string>;
	newId?: () => string;
	now?: () => number;
}) {
	const enqueue = createSerialQueue((error) =>
		console.warn("[dg-ai-extension] web mcp reconcile failed", describeError(error)),
	);
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
		const builtIns = BUILT_IN_SCRIPTS.map((script) => ({
			...script,
			matches: [...script.matches],
			sha256: EMPTY_HASH,
			source: "built-in" as const,
			enabled: stored.find((record) => record.id === script.id)?.enabled ?? true,
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

	async function quietly(task: () => Promise<void>, what: string): Promise<void> {
		try {
			await task();
		} catch (error) {
			console.warn(`[dg-ai-extension] web mcp ${what}`, describeError(error));
		}
	}

	const unregisterBuiltIn = (id: string) =>
		scripting ? scripting.unregisterContentScripts({ ids: [id] }).catch(() => undefined) : Promise.resolve();
	const unregisterUser = (id: string) =>
		userScripts ? userScripts.unregister({ ids: [id] }).catch(() => undefined) : Promise.resolve();

	async function verifiedApprovals(stored: WebMcpScriptRecord[]): Promise<Map<string, string>> {
		const verified = new Map<string, string>();
		const stale = new Set<string>();
		for (const record of stored) {
			if (builtInIds.has(record.id) || record.approvedAt === undefined) continue;
			const code = await storedCode(record.id);
			const pinned = (await storage.local.get(approvalKey(record.id)))[approvalKey(record.id)];
			if (
				code !== undefined &&
				(await digest(code)) === record.sha256 &&
				pinned === (await approvalDigest(code, record.matches))
			)
				verified.set(record.id, code);
			else stale.add(record.id);
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
			await quietly(
				() =>
					registrar.registerContentScripts([
						{
							id,
							js: [`content-scripts/webmcp-${record.id}-main.js`],
							matches: record.matches,
							world: "MAIN",
							runAt: "document_start",
						},
					]),
				`registration of ${id} failed`,
			);
		}
	}

	async function reconcileThirdParty(
		registrar: WebMcpUserScripts,
		records: WebMcpScriptRecord[],
		approved: Map<string, string>,
	): Promise<void> {
		const live = await liveIds(() => registrar.getScripts());
		if (live === null) return;
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
		for (const id of stale) if (!wanted.has(id)) await unregisterUser(id);
		for (const [id, record] of wanted) {
			await unregisterUser(id);
			await quietly(
				() =>
					registrar.register([
						{
							id,
							js: [{ file: SHIM_FILE }, { code: approved.get(record.id) }],
							matches: record.matches,
							world: "MAIN",
							runAt: "document_idle",
						},
					]),
				`registration of ${id} failed`,
			);
		}
	}

	async function runReconcile(): Promise<void> {
		const approved = await verifiedApprovals(await readStored());
		const records = merge(await readStored());
		if (scripting) await reconcileBuiltIns(scripting, records);
		if (userScripts) await reconcileThirdParty(userScripts, records, approved);
	}

	const reconcile = () => enqueue(runReconcile);

	return {
		list: async () => merge(await readStored()),

		code: storedCode,

		async addThirdParty({ name, matches, code, source = "paste" }: WebMcpScriptDraft): Promise<WebMcpScriptRecord> {
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
		},

		async approve(id: string, expectedSha256: string): Promise<void> {
			const record = await requireThirdParty(id);
			const code = await storedCode(id);
			if (code === undefined) throw new Error(`Script ${id} has no stored code`);
			assertCodeSize(code);
			const sha256 = await digest(code);
			if (sha256 !== expectedSha256 || sha256 !== record.sha256) throw new Error(REVIEW_AGAIN);
			await storage.local.set({ [approvalKey(id)]: await approvalDigest(code, record.matches) });
			await mutate((records) =>
				records.map((entry) => (entry.id === id ? { ...entry, enabled: true, approvedAt: now() } : entry)),
			);
			await reconcile();
		},

		async setEnabled(id: string, enabled: boolean): Promise<void> {
			await mutate((records) => {
				if (records.some((record) => record.id === id)) {
					return records.map((record) => (record.id === id ? { ...record, enabled } : record));
				}
				const builtIn = BUILT_IN_SCRIPTS.find((script) => script.id === id);
				if (!builtIn) throw new Error(`Unknown script ${id}`);
				return [
					...records,
					validateWebMcpScriptRecord({
						...builtIn,
						matches: [...builtIn.matches],
						sha256: EMPTY_HASH,
						source: "built-in",
						enabled,
					}),
				];
			});
			await reconcile();
		},

		async replaceCode(id: string, code: string): Promise<void> {
			await requireThirdParty(id);
			assertCodeSize(code);
			const sha256 = await digest(code);
			await storage.local.set({ [codeKey(id)]: code });
			await storage.local.remove(approvalKey(id));
			await mutate((records) =>
				records.map((record) => (record.id === id ? { ...withoutApproval(record), sha256 } : record)),
			);
			await unregisterUser(`${USER_PREFIX}${id}`);
			await reconcile();
		},

		async remove(id: string): Promise<void> {
			if (builtInIds.has(id)) throw new Error("Built-in scripts cannot be removed");
			await requireThirdParty(id);
			await mutate((records) => records.filter((record) => record.id !== id));
			await storage.local.remove([codeKey(id), approvalKey(id)]);
			await unregisterUser(`${USER_PREFIX}${id}`);
			await reconcile();
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

type ReconcileApi = {
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
				) => undefined,
			): void;
		};
	};
};

/** The one place that registers scripts: runs reconcile on install, startup and a message from the options page. */
export function registerWebMcpScripts({
	api = browser as unknown as ReconcileApi,
	scripts = createWebMcpScripts({
		storage: browser.storage as unknown as WebMcpStorage,
		scripting: browser.scripting as unknown as WebMcpScripting,
		userScripts: chromiumUserScripts(),
	}),
}: { api?: ReconcileApi; scripts?: Pick<WebMcpScripts, "reconcile"> } = {}): void {
	const run = () => void scripts.reconcile();
	api.runtime.onInstalled.addListener(run);
	api.runtime.onStartup.addListener(run);
	const page = api.runtime.getURL(OPTIONS_PAGE);
	api.runtime.onMessage.addListener((message, sender, sendResponse) => {
		if ((message as { type?: unknown } | undefined)?.type !== WEBMCP_RECONCILE_MESSAGE) return undefined;
		if (sender.id !== api.runtime.id || (sender.url ?? "").split(/[?#]/)[0] !== page) {
			sendResponse(undefined);
			return undefined;
		}
		run();
		sendResponse(true);
		return undefined;
	});
}
