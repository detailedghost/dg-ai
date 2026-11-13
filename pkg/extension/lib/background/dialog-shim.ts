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

/** Installs the shim in an agent tab and removes it from a tab that stopped being one; a removed page never takes the shim again, and a mailbox, browser or private page is never touched. */
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
	const groups = await lockedAgentGroupIds({ storage, ...(lock ? { lock } : {}) });
	const tab = await api.tabs.get(tabId);
	if (tab.incognito || !allowedPage(tab.url) || mailbox(tab.url)) return;
	const agent = tab.groupId !== undefined && tab.groupId >= 0 && groups.has(tab.groupId);
	if (agent) {
		shimmed.add(tabId);
		await inject(api, tabId, [{ kind: "install" }, tab.url, tab.groupId]);
		return;
	}
	if (!regrouped && !shimmed.has(tabId)) return;
	shimmed.delete(tabId);
	await inject(api, tabId, [{ kind: "remove" }]);
}

/** Forgets a session's agent tabs and then restores native dialogs in them; each removal waits at most a short time. */
export async function forgetAgentTabsAndShims({
	browserApi: api,
	agentTabs,
	sessionId,
	deadlineMs = RELEASE_DEADLINE_MS,
}: {
	browserApi: DialogShimApi;
	agentTabs: Pick<AgentTabs, "list" | "forget">;
	sessionId: string;
	deadlineMs?: number;
}): Promise<void> {
	const rows = await agentTabs.list({ sessionId }).catch(() => []);
	for (const row of rows) shimmed.delete(row.tabId);
	await agentTabs.forget({ sessionId });
	await Promise.all(
		rows
			.filter((row) => allowedPage(row.url) && !mailbox(row.url))
			.map(async (row) => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([
					inject(api, row.tabId, [{ kind: "remove" }]).catch(() => undefined),
					new Promise((resolve) => {
						timer = setTimeout(resolve, deadlineMs);
					}),
				]).finally(() => clearTimeout(timer));
			}),
	);
}
