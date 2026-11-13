import { type PwExtDialogAction, pwExtDialogs } from "@/lib/features/pw-ext-dialog-main";
import {
	type AgentTabs,
	type AgentTabsLock,
	type AgentTabsStorage,
	type BrowserTab,
	lockedAgentGroupIds,
} from "./agent-tabs";
import { allowedPage, mailbox } from "./tab-guards";

/** The browser surface the dialog shim needs. */
export type DialogShimApi = {
	tabs: { get(tabId: number): Promise<BrowserTab> };
	scripting: {
		executeScript(details: {
			target: { tabId: number };
			world: "MAIN";
			injectImmediately?: boolean;
			func: (...args: never[]) => unknown;
			args: unknown[];
		}): Promise<unknown>;
	};
};

const RELEASE_DEADLINE_MS = 2000;
const shimmed = new Set<number>();

/** Records that a verb installed the shim in a tab, so a later group change removes it. */
export function noteDialogShim(tabId: number): void {
	shimmed.add(tabId);
}

/** Forgets a closed tab. */
export function forgetDialogShim(tabId: number): void {
	shimmed.delete(tabId);
}

function inject(api: DialogShimApi, tabId: number, args: [PwExtDialogAction, string?, number?]) {
	return api.scripting.executeScript({
		target: { tabId },
		world: "MAIN",
		injectImmediately: true,
		func: pwExtDialogs as never,
		args,
	});
}

/** Installs the shim in an agent tab and removes it from a tab that stopped being one, on each load until the tab closes, so a page restored from the back-forward cache is covered too; a removed page never takes the shim again, and a mailbox, browser or private page is never touched. */
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
		const groups = await lockedAgentGroupIds({ storage, ...(lock ? { lock } : {}) });
		const tab = await api.tabs.get(tabId);
		return { tab, agent: tab.groupId !== undefined && tab.groupId >= 0 && groups.has(tab.groupId) };
	};
	const { tab, agent } = await owned();
	if (tab.incognito || !allowedPage(tab.url) || mailbox(tab.url)) return;
	if (agent) {
		shimmed.add(tabId);
		await inject(api, tabId, [{ kind: "install" }, tab.url, tab.groupId]);
		if ((await owned()).agent) return;
	} else if (!regrouped && !shimmed.has(tabId)) return;
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
	const tabIds = new Set([...rows.map((row) => row.tabId), ...shimmed]);
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
