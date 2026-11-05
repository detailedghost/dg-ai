import { afterEach, describe, expect, it, mock } from "bun:test";
import { Window } from "happy-dom";
import {
	createPwExtApprover,
	PW_EXT_APPROVAL_PORT,
	type PwExtApprovalApi,
	type PwExtApprovalPort,
} from "@/lib/background/pw-ext-approval";
import { mountPwApprove } from "@/lib/features/pw-approve-page";

const BASE = "chrome-extension://dg-test/";
const PROMPT = {
	verb: "click" as const,
	write: true,
	tabTitle: "Home",
	tabUrl: "https://app.example.test/",
	detail: "Click e1",
};

function fakePort(sender: { url?: string }) {
	const sent: unknown[] = [];
	const onMessage: Array<(message: unknown) => void> = [];
	const onDisconnect: Array<() => void> = [];
	const port: PwExtApprovalPort = {
		name: PW_EXT_APPROVAL_PORT,
		sender,
		postMessage: (message) => sent.push(message),
		onMessage: { addListener: (listener) => onMessage.push(listener) },
		onDisconnect: { addListener: (listener) => onDisconnect.push(listener) },
		disconnect: mock(() => {}),
	};
	return {
		port,
		sent,
		say: (message: unknown) => onMessage.forEach((listener) => listener(message)),
		drop: () => onDisconnect.forEach((listener) => listener()),
	};
}

function harness() {
	let connect: ((port: PwExtApprovalPort) => void) | undefined;
	const created: Array<{ url: string; type: string }> = [];
	const removed: number[] = [];
	const api: PwExtApprovalApi = {
		runtime: {
			getURL: (path: string) => `${BASE}${path.replace(/^\//, "")}`,
			onConnect: {
				addListener: (listener) => {
					connect = listener;
				},
			},
		},
		windows: {
			create: mock(async (options: { url: string; type: string }) => {
				created.push(options);
				return { id: 41 };
			}),
			remove: mock(async (id: number) => {
				removed.push(id);
			}),
		},
	};
	const approve = createPwExtApprover(api, { newNonce: () => "nonce-1" });
	const open = (sender: { url?: string } = { url: `${BASE}pw-approve.html#nonce-1` }) => {
		const port = fakePort(sender);
		connect?.(port.port);
		return port;
	};
	return { approve, created, removed, open };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("pw --ext approval", () => {
	it("opens a popup, sends the prompt to its own page, and resolves on approve", async () => {
		const h = harness();
		const answer = h.approve(PROMPT, 10_000);
		await tick();
		expect(h.created).toEqual([
			expect.objectContaining({
				url: `${BASE}pw-approve.html#nonce-1`,
				type: "popup",
			}),
		]);
		const page = h.open();
		page.say({ type: "hello", nonce: "nonce-1" });
		expect(page.sent).toEqual([{ type: "prompt", prompt: PROMPT }]);
		page.say({ type: "answer", nonce: "nonce-1", approved: true });
		expect(await answer).toBe(true);
		expect(h.removed).toEqual([41]);
	});

	it.each([
		["a web page", { url: "https://evil.example.test/" }],
		["another extension page", { url: `${BASE}chat.html` }],
		["the page with another nonce", { url: `${BASE}pw-approve.html#guess` }],
		["no sender", {}],
	])("ignores a port from %s", async (_label, sender) => {
		const h = harness();
		const answer = h.approve(PROMPT, 300);
		await tick();
		const page = h.open(sender);
		page.say({ type: "hello", nonce: "nonce-1" });
		page.say({ type: "answer", nonce: "nonce-1", approved: true });
		expect(page.sent).toEqual([]);
		expect(await answer).toBe(false);
	});

	it("ignores an answer with the wrong nonce or a non-boolean", async () => {
		const h = harness();
		const answer = h.approve(PROMPT, 300);
		await tick();
		const page = h.open();
		page.say({ type: "answer", nonce: "guess", approved: true });
		page.say({ type: "answer", nonce: "nonce-1", approved: "yes" });
		expect(await answer).toBe(false);
	});

	it("denies when the window closes", async () => {
		const h = harness();
		const answer = h.approve(PROMPT, 10_000);
		await tick();
		const page = h.open();
		page.say({ type: "hello", nonce: "nonce-1" });
		page.drop();
		expect(await answer).toBe(false);
	});

	it("denies on timeout and closes the window", async () => {
		const h = harness();
		expect(await h.approve(PROMPT, 50)).toBe(false);
		expect(h.removed).toEqual([41]);
	});

	it("denies and closes the window when the request is canceled", async () => {
		const h = harness();
		const controller = new AbortController();
		const answer = h.approve(PROMPT, 60_000, controller.signal);
		await tick();
		controller.abort();
		expect(await answer).toBe(false);
		expect(h.removed).toEqual([41]);
	});

	it("refuses a second prompt while one is open", async () => {
		const h = harness();
		const first = h.approve(PROMPT, 10_000);
		await tick();
		await expect(h.approve(PROMPT, 10_000)).rejects.toThrow(/waiting for approval/);
		const page = h.open();
		page.say({ type: "answer", nonce: "nonce-1", approved: false });
		expect(await first).toBe(false);
	});
});

describe("pw-approve page", () => {
	const windows: Window[] = [];
	afterEach(async () => {
		await Promise.all(windows.map((window) => window.happyDOM.close()));
		windows.length = 0;
	});

	it("renders the prompt as text and posts the answer", () => {
		const window = new Window();
		windows.push(window);
		const doc = window.document as unknown as Document;
		const page = fakePort({});
		mountPwApprove(doc, page.port, "nonce-1");
		expect(page.sent).toEqual([{ type: "hello", nonce: "nonce-1" }]);
		page.say({
			type: "prompt",
			prompt: { ...PROMPT, tabTitle: "<img src=x onerror=alert(1)>" },
		});
		expect(doc.querySelector("img")).toBeNull();
		expect(doc.body.textContent).toContain("<img src=x onerror=alert(1)>");
		expect(doc.body.textContent).toContain("change this page");
		expect(doc.body.textContent).toContain("Click e1");
		(doc.querySelector("#approve") as HTMLButtonElement).click();
		expect(page.sent.at(-1)).toEqual({
			type: "answer",
			nonce: "nonce-1",
			approved: true,
		});
	});
});
