import { type NavigationRequest, type NavigationResult, type NavigationVerb } from "@dg/common/pw-ext-verbs/navigation";
import type { AgentTabs } from "../agent-tabs";
import { guardedTab } from "../tab-guards";

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
		const found = await guardedTab({ agentTabs, tabs: api.tabs, sessionId, requested: request.tabId }, { allowDiscarded: true });
		if (!found.ok) return refused(found.error);
		const { tabId } = found;
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
