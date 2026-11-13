import { type PwExtDialogAction, pwExtDialogs } from "@/lib/features/pw-ext-dialog-main";
import { type AgentTabs, type AgentTabsStorage, agentGroupIds, type BrowserTab } from "./agent-tabs";
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
const turns = new Map<number, number>();
const shimmed = new Set<number>();

/** Records that a verb installed the shim in a tab, so a later group change removes it. */
export function noteDialogShim(tabId: number): void {
	shimmed.add(tabId);
}

/** Forgets a closed tab. */
export function forgetDialogShim(tabId: number): void {
	turns.delete(tabId);
	shimmed.delete(tabId);
}

function inject(api: DialogShimApi, tabId: number, action: PwExtDialogAction, url: string | undefined) {
	return api.scripting.executeScript({
		target: { tabId },
		world: "MAIN",
		injectImmediately: true,
		func: pwExtDialogs as never,
		args: [action, url],
	});
}

/** Installs the shim in an agent tab and removes it from a tab that stopped being one; a later call for the tab cancels an earlier one, and a mailbox, browser or private page is never touched. */
export async function syncDialogShim({
	browserApi: api,
	storage,
	tabId,
	regrouped,
}: {
	browserApi: DialogShimApi;
	storage: AgentTabsStorage;
	tabId: number;
	regrouped: boolean;
}): Promise<void> {
	const turn = (turns.get(tabId) ?? 0) + 1;
	turns.set(tabId, turn);
	const groups = await agentGroupIds({ storage });
	const tab = await api.tabs.get(tabId);
	if (turns.get(tabId) !== turn) return;
	if (tab.incognito || !allowedPage(tab.url) || mailbox(tab.url)) return;
	const agent = tab.groupId !== undefined && tab.groupId >= 0 && groups.has(tab.groupId);
	if (agent) {
		shimmed.add(tabId);
		await inject(api, tabId, { kind: "install" }, tab.url);
		return;
	}
	if (!regrouped && !shimmed.has(tabId)) return;
	shimmed.delete(tabId);
	await inject(api, tabId, { kind: "remove" }, tab.url);
}

/** Restores native dialogs in the tabs of a session that ends, waiting at most a short time on each tab; call it before its agent tab record is forgotten. */
export async function releaseDialogShims({
	browserApi: api,
	agentTabs,
	sessionId,
	deadlineMs = RELEASE_DEADLINE_MS,
}: {
	browserApi: DialogShimApi;
	agentTabs: Pick<AgentTabs, "list">;
	sessionId: string;
	deadlineMs?: number;
}): Promise<void> {
	const rows = (await agentTabs.list({ sessionId })).filter((row) => allowedPage(row.url) && !mailbox(row.url));
	await Promise.all(
		rows.map(async (row) => {
			shimmed.delete(row.tabId);
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				inject(api, row.tabId, { kind: "remove" }, row.url).catch(() => undefined),
				new Promise((resolve) => {
					timer = setTimeout(resolve, deadlineMs);
				}),
			]).finally(() => clearTimeout(timer));
		}),
	);
}
