import { describe, expect, it, mock } from "bun:test";
import type { PwExtRequest } from "@dg/common";
import { createAgentTabs } from "@/lib/background/agent-tabs";
import type { ApprovalRequest } from "@/lib/background/approval";
import { createPwExtHandler } from "@/lib/background/pw-ext";
import { createSessionControl } from "@/lib/background/session-control";
import { PhiCaptureRefusedError } from "@/lib/background/site-allow-prompt";
import { createUnmaskGrants } from "@/lib/background/unmask-grants";
import { createFakeBrowser, createLock, recordOf, tabOf, windowOf } from "./utils/fake-browser";

const SESSION = "session-1";
const WINDOW = 3;
const GROUP = 10;
const SITE = "https://app.example.test/home";

type Options = {
	url?: string;
	approve?: "allow" | "deny";
	siteAnswer?: "allow" | "deny";
	approveSite?: boolean;
	flagged?: boolean;
	flagOnAllow?: boolean;
	script?: (details: { func?: { name?: string }; args: unknown[] }) => unknown;
	secrets?: string[];
};

async function harness(options: Options = {}) {
	const fake = createFakeBrowser({
		windows: [windowOf({ id: WINDOW })],
		lastFocusedWindowId: WINDOW,
		tabs: [
			tabOf({ id: 7, windowId: WINDOW, groupId: GROUP, url: options.url ?? SITE, active: true }),
			tabOf({ id: 8, windowId: WINDOW, groupId: GROUP, url: SITE }),
			tabOf({ id: 21, windowId: WINDOW, url: SITE }),
		],
		groups: [{ id: GROUP, windowId: WINDOW, title: "agent" }],
	});
	fake.seedRecord(recordOf({ sessionId: SESSION, groupId: GROUP, selectedTabId: 7 }));
	const calls: string[] = [];
	const raw = fake.raw as unknown as { tabs: Record<string, unknown>; windows: Record<string, unknown> };
	for (const name of ["goBack", "goForward", "reload"])
		raw.tabs[name] = mock(async (id: number) => void calls.push(`${name}:${id}`));
	raw.windows["get"] = mock(async () => ({ id: WINDOW, incognito: false }));
	raw.windows["update"] = mock(async (id: number, props: unknown) => void calls.push(`resize:${id}:${JSON.stringify(props)}`));
	fake.state.script = (details) =>
		(options.script ?? (() => ({ detail: "done" })))(details as { func?: { name?: string }; args: unknown[] });
	const storage = fake.api.storage;
	const control = createSessionControl({ storage });
	if (options.approveSite) await control.allow(SESSION, "https://example.test");
	const asked: ApprovalRequest[] = [];
	const siteAsked: string[] = [];
	let phi = options.flagged === true;
	const grants = createUnmaskGrants({ storage });
	for (const secret of options.secrets ?? []) await grants.reserve(SESSION, secret);
	const lock = createLock();
	const handler = createPwExtHandler({
		browserApi: fake.api,
		agentTabs: createAgentTabs({ browserApi: fake.api, storage, lock }),
		approvals: {
			request: async (request) => {
				asked.push(request);
				return options.approve ?? "deny";
			},
			ask: async (request) => ({ answer: options.approve ?? "deny", remember: false }),
		},
		grants,
		lock,
		control,
		siteAllow: {
			requestSiteAllow: async ({ sessionId, siteKey }) => {
				siteAsked.push(siteKey);
				const answer = options.siteAnswer ?? "deny";
				if (answer === "allow") await control.allow(sessionId, siteKey);
				if (answer === "allow" && options.flagOnAllow) phi = true;
				return answer;
			},
			assertCaptureAllowed: async (_session, url) => {
				if (phi) throw new PhiCaptureRefusedError(new URL(url).host);
			},
		},
	});
	const run = (request: PwExtRequest) =>
		handler({
			request,
			timeoutMs: 60_000,
			signal: new AbortController().signal,
			progress: () => undefined,
			context: {
				sessionId: SESSION,
				agentIdentity: "agent",
				fetchAsset: async () => new Blob(),
				deleteAsset: async () => undefined,
				storeCredential: async () => "",
			},
		} as never);
	return { run, calls, asked, siteAsked, fake, scriptRuns: () => fake.raw.scripting.executeScript.mock.calls.length };
}

describe("registered verb modules", () => {
	it.each(["go-back", "go-forward", "reload"] as const)("runs %s on an allowed site", async (verb) => {
		const h = await harness({ approveSite: true });
		const result = await h.run({ verb });
		expect(result).toMatchObject({ ok: true });
		expect(h.calls).toEqual([`${verb === "go-back" ? "goBack" : verb === "go-forward" ? "goForward" : "reload"}:7`]);
		expect(h.siteAsked).toEqual([]);
	});

	it.each<PwExtRequest>([
		{ verb: "go-back" },
		{ verb: "reload" },
		{ verb: "hover", target: "e1" },
		{ verb: "dblclick", target: "e1" },
		{ verb: "drag", target: "e1", to: "e2" },
		{ verb: "mousemove", x: 1, y: 1 },
		{ verb: "mousedown" },
		{ verb: "mousewheel", dx: 0, dy: 5 },
		{ verb: "check", target: "e1" },
		{ verb: "uncheck", target: "e1" },
		{ verb: "type", text: "hi" },
		{ verb: "keydown", key: "Shift" },
	])("asks about a new site before $verb and does nothing on Deny", async (request) => {
		const h = await harness({ siteAnswer: "deny" });
		const result = await h.run(request);
		expect(result).toMatchObject({ ok: false });
		expect(h.siteAsked).toEqual(["https://example.test"]);
		expect(h.calls).toEqual([]);
		expect(h.scriptRuns()).toBe(0);
	});

	it("runs hover after the person allows the site", async () => {
		const h = await harness({ siteAnswer: "allow", script: () => ({ detail: "hovered <a>" }) });
		expect(await h.run({ verb: "hover", target: "e1" })).toEqual({ ok: true, data: { text: "### Result\nhovered <a>" } });
		expect(h.siteAsked).toEqual(["https://example.test"]);
	});

	it("never prompts for a browser page", async () => {
		const h = await harness({ url: "chrome://settings/", siteAnswer: "allow" });
		expect(await h.run({ verb: "reload" })).toMatchObject({ ok: false });
		expect(h.siteAsked).toEqual([]);
		expect(h.asked).toEqual([]);
		expect(h.calls).toEqual([]);
	});

	it.each<PwExtRequest>([
		{ verb: "eval", expression: "1+1" },
		{ verb: "localstorage-set", key: "a", value: "b" },
		{ verb: "sessionstorage-delete", key: "a" },
		{ verb: "localstorage-clear" },
	])("refuses $verb on an unapproved site without prompting", async (request) => {
		const h = await harness({ siteAnswer: "allow", approve: "allow" });
		const result = await h.run(request);
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("not on this session's allowed sites") });
		expect(h.siteAsked).toEqual([]);
		expect(h.asked).toEqual([]);
		expect(h.scriptRuns()).toBe(0);
	});

	it("runs eval on an approved site", async () => {
		const h = await harness({ approveSite: true, script: () => ({ ok: true, text: "2" }) });
		expect(await h.run({ verb: "eval", expression: "1+1" })).toEqual({ ok: true, data: { text: "### Result\n2" } });
	});

	it("masks a held secret in an eval result", async () => {
		const h = await harness({
			approveSite: true,
			secrets: ["hunter2-secret"],
			script: () => ({ ok: true, text: "token=hunter2-secret" }),
		});
		const result = await h.run({ verb: "eval", expression: "document.title" });
		expect(JSON.stringify(result)).not.toContain("hunter2-secret");
	});

	it("masks a held secret in a type result", async () => {
		const h = await harness({
			siteAnswer: "allow",
			secrets: ["hunter2-secret"],
			script: () => ({ detail: "typed hunter2-secret" }),
		});
		const result = await h.run({ verb: "type", text: "x" });
		expect(JSON.stringify(result)).not.toContain("hunter2-secret");
	});

	it("selects a tab of the group with tab-select and asks nothing", async () => {
		const h = await harness();
		expect(await h.run({ verb: "tab-select", tabId: 8 })).toMatchObject({ ok: true });
		expect(h.fake.record(SESSION)?.selectedTabId).toBe(8);
		expect(h.siteAsked).toEqual([]);
	});

	it("refuses tab-select for a tab outside the group", async () => {
		const h = await harness();
		expect(await h.run({ verb: "tab-select", tabId: 21 })).toMatchObject({ ok: false });
		expect(h.fake.record(SESSION)?.selectedTabId).toBe(7);
	});

	it("resizes the agent window without asking about a site", async () => {
		const h = await harness();
		expect(await h.run({ verb: "resize", width: 800, height: 600 })).toMatchObject({ ok: true });
		expect(h.siteAsked).toEqual([]);
		expect(h.calls[0]).toStartWith(`resize:${WINDOW}`);
	});

	it.each(["snapshot", "screenshot"] as const)("refuses the first %s when the person flags the site as PHI in the allow prompt", async (verb) => {
		const h = await harness({ siteAnswer: "allow", flagOnAllow: true });
		const result = await h.run({ verb });
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("PHI") });
		expect(h.siteAsked).toEqual(["https://example.test"]);
		expect(h.scriptRuns()).toBe(0);
	});

	it.each(["snapshot", "screenshot"] as const)("refuses %s on a site flagged as PHI before any capture", async (verb) => {
		const h = await harness({ approveSite: true, flagged: true });
		const result = await h.run({ verb });
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("PHI") });
		expect(h.scriptRuns()).toBe(0);
	});
});
