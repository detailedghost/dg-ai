import { createSerialQueue } from "@dg/common";
import { bannerTitle, pwExtBanner } from "@/lib/features/pw-ext-banner";
import { type PwExtDialogAction, pwExtDialogs } from "@/lib/features/pw-ext-dialog-main";
import { pwExtNetwork } from "@/lib/features/pw-ext-network-main";
import {
	type AgentTabs,
	type AgentTabsLock,
	type AgentTabsStorage,
	type BrowserTab,
	lockedAgentRecords,
} from "./agent-tabs";
import { allowedPage, mailbox } from "./tab-guards";

/** The browser surface the dialog shim needs. */
export type DialogShimApi = {
	tabs: { get(tabId: number): Promise<BrowserTab> };
	tabGroups: { get(groupId: number): Promise<{ title?: string }> };
	scripting: {
		executeScript(details: {
			target: { tabId: number };
			world?: "MAIN";
			injectImmediately?: boolean;
			func: (...args: never[]) => unknown;
			args: unknown[];
		}): Promise<unknown>;
	};
};

const RELEASE_DEADLINE_MS = 2000;
const SHIMMED_KEY = "pwExtDialogShims";
const enqueue = createSerialQueue();

async function shimmedTabs(storage: AgentTabsStorage): Promise<number[]> {
	const stored = (await storage.session.get(SHIMMED_KEY))[SHIMMED_KEY];
	return Array.isArray(stored) ? stored.filter((id): id is number => typeof id === "number") : [];
}

/** Records in storage.session that a tab got the shim, so a later load removes it even after a worker restart. */
function noteDialogShim(storage: AgentTabsStorage, tabId: number): Promise<void> {
	return enqueue(async () => {
		const held = await shimmedTabs(storage);
		if (!held.includes(tabId)) await storage.session.set({ [SHIMMED_KEY]: [...held, tabId] });
	});
}

/** Forgets a closed tab. */
export function forgetDialogShim(storage: AgentTabsStorage, tabId: number): Promise<void> {
	return enqueue(async () => {
		const held = await shimmedTabs(storage);
		if (held.includes(tabId)) await storage.session.set({ [SHIMMED_KEY]: held.filter((id) => id !== tabId) });
	});
}

function inject(api: DialogShimApi, tabId: number, args: [PwExtDialogAction, string?, number?], title?: string) {
	const banner = api.scripting
		.executeScript({
			target: { tabId },
			func: pwExtBanner as never,
			args: args[0].kind === "install" ? [true, title ?? ""] : [false],
		})
		.catch(() => undefined);
	return Promise.all([
		api.scripting.executeScript({
			target: { tabId },
			world: "MAIN",
			injectImmediately: true,
			func: pwExtDialogs as never,
			args,
		}),
		api.scripting.executeScript({
			target: { tabId },
			world: "MAIN",
			injectImmediately: true,
			func: pwExtNetwork as never,
			args,
		}),
		banner,
	]);
}

/** Installs the dialog shim, the network hook and the agent banner in an agent tab and removes them from a tab that stopped being one, on each load until the tab closes, so a page restored from the back-forward cache is covered too, also after a worker restart; a removed page never takes the shim again, and a mailbox, browser or private page is never touched. */
export async function syncDialogShim({
	browserApi: api,
	storage,
	tabId,
	regrouped,
	lock,
}: {
	browserApi: DialogShimApi;
	storage: AgentTabsStorage;
	tabId: number;
	regrouped: boolean;
	lock?: AgentTabsLock;
}): Promise<void> {
	const owned = async () => {
		const records = await lockedAgentRecords({ storage, ...(lock ? { lock } : {}) });
		const tab = await api.tabs.get(tabId);
		const record = tab.groupId !== undefined && tab.groupId >= 0 ? records.find((r) => r.groupId === tab.groupId) : undefined;
		return { tab, record };
	};
	const { tab, record } = await owned();
	if (tab.incognito || !allowedPage(tab.url) || mailbox(tab.url)) return;
	if (record) {
		await noteDialogShim(storage, tabId);
		const live = (await api.tabGroups.get(record.groupId).catch(() => undefined))?.title;
		await inject(api, tabId, [{ kind: "install" }, tab.url, tab.groupId], bannerTitle({ ...record, title: live?.trim() || record.title }));
		if ((await owned()).record) return;
	} else if (!regrouped && !(await shimmedTabs(storage)).includes(tabId)) return;
	await inject(api, tabId, [{ kind: "remove" }]);
}

/** Forgets a session's agent tabs and then syncs every tab it listed or that this worker shimmed, so each one that is no longer an agent tab gets its native dialogs back; each sync waits at most a short time. */
export async function forgetAgentTabsAndShims({
	browserApi: api,
	storage,
	lock,
	agentTabs,
	sessionId,
	deadlineMs = RELEASE_DEADLINE_MS,
}: {
	browserApi: DialogShimApi;
	storage: AgentTabsStorage;
	lock?: AgentTabsLock;
	agentTabs: Pick<AgentTabs, "list" | "forget">;
	sessionId: string;
	deadlineMs?: number;
}): Promise<void> {
	const rows = await agentTabs.list({ sessionId }).catch(() => []);
	await agentTabs.forget({ sessionId });
	const tabIds = new Set([...rows.map((row) => row.tabId), ...(await shimmedTabs(storage))]);
	await Promise.all(
		[...tabIds].map(async (tabId) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				syncDialogShim({ browserApi: api, storage, tabId, regrouped: true, ...(lock ? { lock } : {}) }).catch(
					() => undefined,
				),
				new Promise((resolve) => {
					timer = setTimeout(resolve, deadlineMs);
				}),
			]).finally(() => clearTimeout(timer));
		}),
	);
}
