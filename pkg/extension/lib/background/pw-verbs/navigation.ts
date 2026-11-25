import { PW_EXT_NO_TAB_ERROR } from "@dg/common";
import { type NavigationRequest, type NavigationResult, type NavigationVerb } from "@dg/common/pw-ext-verbs/navigation";
import type { AgentTabs } from "../agent-tabs";
import { allowedPage, mailbox, PW_EXT_BLOCKED_ERROR, PW_EXT_MAILBOX_ERROR, PW_EXT_PRIVATE_ERROR } from "../tab-guards";

export type NavigationBrowserApi = {
	tabs: {
		get(tabId: number): Promise<{ url?: string; incognito?: boolean }>;
		goBack(tabId: number): Promise<void>;
		goForward(tabId: number): Promise<void>;
		reload(tabId: number): Promise<void>;
	};
};

const PAST_TENSE = {
	"go-back": "Went back",
	"go-forward": "Went forward",
	reload: "Reloaded",
} as const satisfies Record<NavigationVerb, string>;

const refused = (error: string): NavigationResult => ({ ok: false, error });

export function createNavigationHandler({
	browserApi: api,
	agentTabs,
}: {
	browserApi: NavigationBrowserApi;
	agentTabs: Pick<AgentTabs, "owns" | "selected">;
}) {
	return async function navigate(request: NavigationRequest, { sessionId }: { sessionId: string }): Promise<NavigationResult> {
		const tabId = request.tabId ?? (await agentTabs.selected({ sessionId }))?.tabId;
		if (tabId === undefined) return refused(PW_EXT_NO_TAB_ERROR);
		if (!(await agentTabs.owns({ sessionId, tabId })))
			return refused(`pw --ext: tab ${tabId} is not in this agent's tab group; run pw --ext tabs to list them.`);
		const tab = await api.tabs.get(tabId);
		if (tab.incognito) return refused(PW_EXT_PRIVATE_ERROR);
		if (!allowedPage(tab.url)) return refused(PW_EXT_BLOCKED_ERROR);
		if (mailbox(tab.url)) return refused(PW_EXT_MAILBOX_ERROR);
		try {
			if (request.verb === "go-back") await api.tabs.goBack(tabId);
			else if (request.verb === "go-forward") await api.tabs.goForward(tabId);
			else await api.tabs.reload(tabId);
		} catch (error) {
			return refused(`pw --ext ${request.verb} failed on tab ${tabId}: ${error instanceof Error ? error.message : "the browser refused"}`);
		}
		return { ok: true, data: { text: `### Result\n${PAST_TENSE[request.verb]} tab ${tabId}` } };
	};
}
