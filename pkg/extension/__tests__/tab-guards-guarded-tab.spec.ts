import { describe, expect, it } from "bun:test";
import { PW_EXT_NO_TAB_ERROR } from "@dg/common";
import { discardedTab, guardedTab, notInGroup, ownedTab, PW_EXT_BLOCKED_ERROR, PW_EXT_PRIVATE_ERROR } from "@/lib/background/tab-guards";

type Tab = { url?: string; incognito?: boolean; discarded?: boolean };

function lookup({ tab = { url: "https://app.example.test/" }, owned = [7], selected = 7, requested }: {
	tab?: Tab | "throws";
	owned?: number[];
	selected?: number;
	requested?: number;
} = {}) {
	return {
		agentTabs: {
			owns: async ({ tabId }: { tabId: number }) => owned.includes(tabId),
			selected: async () => (selected === undefined ? undefined : { tabId: selected }),
		},
		tabs: { get: async (): Promise<Tab> => (tab === "throws" ? Promise.reject(new Error("gone")) : tab) },
		sessionId: "s1",
		requested,
	};
}

describe("ownedTab", () => {
	it("returns the selected tab when none is requested", async () => {
		expect(await ownedTab(lookup())).toMatchObject({ ok: true, tabId: 7 });
	});

	it("says there is no tab when nothing is selected", async () => {
		expect(await ownedTab({ ...lookup(), agentTabs: { ...lookup().agentTabs, selected: async () => undefined } })).toEqual({
			ok: false,
			error: PW_EXT_NO_TAB_ERROR,
		});
	});

	it("refuses a tab outside the agent group", async () => {
		expect(await ownedTab(lookup({ requested: 9 }))).toEqual({ ok: false, error: notInGroup(9) });
	});

	it("treats a tab the browser cannot read as outside the group", async () => {
		expect(await ownedTab(lookup({ tab: "throws" }))).toEqual({ ok: false, error: notInGroup(7) });
	});
});

describe("guardedTab", () => {
	it("passes an ordinary web page", async () => {
		expect(await guardedTab(lookup())).toMatchObject({ ok: true, tabId: 7, tab: { url: "https://app.example.test/" } });
	});

	it.each([
		["a private window", { url: "https://app.example.test/", incognito: true }, PW_EXT_PRIVATE_ERROR],
		["a browser page", { url: "chrome://settings/" }, PW_EXT_BLOCKED_ERROR],
		["a discarded tab", { url: "https://app.example.test/", discarded: true }, discardedTab(7)],
	])("refuses %s", async (_name, tab, error) => {
		expect(await guardedTab(lookup({ tab }))).toEqual({ ok: false, error });
	});

	it("lets a discarded tab through when the verb allows it", async () => {
		const tab = { url: "https://app.example.test/", discarded: true };
		expect(await guardedTab(lookup({ tab }), { allowDiscarded: true })).toMatchObject({ ok: true });
	});
});
