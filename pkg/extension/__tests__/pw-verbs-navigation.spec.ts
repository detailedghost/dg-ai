import { describe, expect, it, mock } from "bun:test";
import { PW_EXT_NO_TAB_ERROR } from "@dg/common";
import { VERBS, type NavigationVerb } from "@dg/common/pw-ext-verbs/navigation";
import { PW_EXT_BLOCKED_ERROR, PW_EXT_MAILBOX_ERROR, PW_EXT_PRIVATE_ERROR } from "@/lib/background/tab-guards";
import { createNavigationHandler, type NavigationBrowserApi } from "@/lib/background/pw-verbs/navigation";

const SESSION = "session-1";
const OWNED = 7;
const FOREIGN = 20;
const WEB = "https://app.example.test/home";

type Tab = { url?: string; incognito?: boolean };

function harness({ tabs = { [OWNED]: { url: WEB } } as Record<number, Tab>, selected = OWNED as number | null } = {}) {
	const calls: string[] = [];
	const api: NavigationBrowserApi = {
		tabs: {
			get: async (id) => tabs[id] ?? {},
			goBack: mock(async (id: number) => void calls.push(`go-back:${id}`)),
			goForward: mock(async (id: number) => void calls.push(`go-forward:${id}`)),
			reload: mock(async (id: number) => void calls.push(`reload:${id}`)),
		},
	};
	const agentTabs = {
		owns: async ({ tabId }: { sessionId: string; tabId: number }) => tabId === OWNED,
		selected: async () => (selected === null ? undefined : ({ tabId: selected } as never)),
	};
	return { calls, run: createNavigationHandler({ browserApi: api, agentTabs }) };
}

describe("navigation handler", () => {
	it.each(VERBS)("runs %s on the selected tab", async (verb) => {
		const h = harness();
		const result = await h.run({ verb }, { sessionId: SESSION });
		expect(result.ok).toBe(true);
		expect(h.calls).toEqual([`${verb}:${OWNED}`]);
	});

	it.each(VERBS)("refuses %s on a tab outside the agent tab group", async (verb) => {
		const h = harness({ tabs: { [FOREIGN]: { url: WEB } } });
		const result = await h.run({ verb, tabId: FOREIGN }, { sessionId: SESSION });
		expect(result).toEqual({
			ok: false,
			error: `pw --ext: tab ${FOREIGN} is not in this agent's tab group; run pw --ext tabs to list them.`,
		});
		expect(h.calls).toEqual([]);
	});

	it("names the verb and the tab in the result", async () => {
		const h = harness();
		const result = await h.run({ verb: "go-back", tabId: OWNED }, { sessionId: SESSION });
		expect(result).toEqual({ ok: true, data: { text: `### Result\nWent back tab ${OWNED}` } });
	});

	it("refuses when the agent has no selected tab", async () => {
		const h = harness({ selected: null });
		expect(await h.run({ verb: "reload" }, { sessionId: SESSION })).toEqual({ ok: false, error: PW_EXT_NO_TAB_ERROR });
		expect(h.calls).toEqual([]);
	});

	it.each<[string, Tab, string]>([
		["a private window", { url: WEB, incognito: true }, PW_EXT_PRIVATE_ERROR],
		["a browser page", { url: "chrome://settings" }, PW_EXT_BLOCKED_ERROR],
		["a tab with no url", {}, PW_EXT_BLOCKED_ERROR],
		["the mailbox", { url: "https://mail.proton.me/u/0/inbox" }, PW_EXT_MAILBOX_ERROR],
	])("refuses %s", async (_name, tab, error) => {
		const verb: NavigationVerb = "reload";
		const h = harness({ tabs: { [OWNED]: tab } });
		expect(await h.run({ verb }, { sessionId: SESSION })).toEqual({ ok: false, error });
		expect(h.calls).toEqual([]);
	});

	it("reports a browser failure such as an empty history", async () => {
		const api: NavigationBrowserApi = {
			tabs: {
				get: async () => ({ url: WEB }),
				goBack: async () => {
					throw new Error("Cannot find a previous page in history.");
				},
				goForward: async () => undefined,
				reload: async () => undefined,
			},
		};
		const run = createNavigationHandler({
			browserApi: api,
			agentTabs: { owns: async () => true, selected: async () => undefined },
		});
		expect(await run({ verb: "go-back", tabId: OWNED }, { sessionId: SESSION })).toEqual({
			ok: false,
			error: `pw --ext go-back failed on tab ${OWNED}: Cannot find a previous page in history.`,
		});
	});
});
