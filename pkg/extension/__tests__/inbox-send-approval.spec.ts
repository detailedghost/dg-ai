import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ChatFrame } from "@dg/common";
import { Window } from "happy-dom";
import { MSG } from "@/lib/chat-messages";
import { bootRelay } from "./utils/relay-harness";

mock.module("wxt/browser", () => ({ browser: {} }));

const { mountInboxSendApproval } = await import(
	"@/lib/features/inbox-send-approval"
);

const windows = new Set<Window>();

afterEach(() => {
	for (const window of windows) window.happyDOM.close();
	windows.clear();
});

function newRoot(): HTMLElement {
	const window = new Window();
	windows.add(window);
	const root = window.document.createElement("div");
	window.document.body.append(root);
	return root as unknown as HTMLElement;
}

function requestFrame(overrides: Record<string, unknown> = {}): Extract<
	ChatFrame,
	{ type: "inbox-send-approval-request" }
> {
	return {
		type: "inbox-send-approval-request",
		sessionId: "sess-abc123",
		protocolVersion: 1,
		requestId: "req-1",
		approval: {
			provider: "outlook",
			profile: "work",
			draftId: "m_hash_abc123def456",
			to: ["person@example.test"],
			cc: ["second@example.test"],
			subject: "Quarterly update",
			text: "See the attached numbers.",
			attachments: ["report.pdf"],
			contentHash: "a".repeat(64),
		},
		...overrides,
	} as Extract<ChatFrame, { type: "inbox-send-approval-request" }>;
}

function listenerHarness() {
	let listener: ((frame: ChatFrame) => void) | undefined;
	return {
		onFrame: (next: (frame: ChatFrame) => void) => {
			listener = next;
		},
		emit: (frame: ChatFrame) => listener?.(frame),
	};
}

describe("mountInboxSendApproval — card rendering and decisions", () => {
	test("renders provider, recipients, subject, text, and attachment names", () => {
		const root = newRoot();
		const harness = listenerHarness();
		mountInboxSendApproval(root, { onFrame: harness.onFrame, send: mock(() => undefined) });
		harness.emit(requestFrame());

		const text = root.textContent ?? "";
		expect(text).toContain("outlook / work");
		expect(text).toContain("person@example.test");
		expect(text).toContain("second@example.test");
		expect(text).toContain("Quarterly update");
		expect(text).toContain("See the attached numbers.");
		expect(text).toContain("report.pdf");
	});

	test("clicking Approve send emits one approved result with the session id and requestId, then disables both buttons", () => {
		const root = newRoot();
		const harness = listenerHarness();
		const send = mock((_sessionId: string, _requestId: string, _approved: boolean) => undefined);
		mountInboxSendApproval(root, { onFrame: harness.onFrame, send });
		harness.emit(requestFrame());

		const approve = root.querySelector<HTMLButtonElement>(".inbox-approval__approve");
		const reject = root.querySelector<HTMLButtonElement>(".inbox-approval__reject");
		if (!approve || !reject) throw new Error("approval buttons not found");
		approve.click();

		expect(send.mock.calls).toEqual([["sess-abc123", "req-1", true]]);
		expect(approve.disabled).toBe(true);
		expect(reject.disabled).toBe(true);

		reject.click();
		expect(send.mock.calls).toHaveLength(1);
	});

	test("clicking Reject emits approved:false", () => {
		const root = newRoot();
		const harness = listenerHarness();
		const send = mock((_sessionId: string, _requestId: string, _approved: boolean) => undefined);
		mountInboxSendApproval(root, { onFrame: harness.onFrame, send });
		harness.emit(requestFrame());

		root.querySelector<HTMLButtonElement>(".inbox-approval__reject")?.click();
		expect(send.mock.calls).toEqual([["sess-abc123", "req-1", false]]);
	});

	test("renders a message body containing <script> as literal text, never as a parsed element", () => {
		const root = newRoot();
		const harness = listenerHarness();
		mountInboxSendApproval(root, { onFrame: harness.onFrame, send: mock(() => undefined) });
		harness.emit(
			requestFrame({
				approval: {
					...requestFrame().approval,
					text: "Click here <script>alert(1)</script> for details",
				},
			}),
		);

		expect(root.textContent ?? "").toContain("<script>alert(1)</script>");
		expect(root.querySelector("script")).toBeNull();
	});

	test("a request that expires before a click is removed, and a later click on the stale button emits nothing", async () => {
		const root = newRoot();
		const harness = listenerHarness();
		const send = mock((_sessionId: string, _requestId: string, _approved: boolean) => undefined);
		mountInboxSendApproval(root, { onFrame: harness.onFrame, send, timeoutMs: 10 });
		harness.emit(requestFrame());

		const approve = root.querySelector<HTMLButtonElement>(".inbox-approval__approve");
		if (!approve) throw new Error("approve button not found");
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(root.querySelector(".inbox-approval")).toBeNull();
		approve.click();
		expect(send.mock.calls).toHaveLength(0);
	});

	test("destroy removes a still-pending card and stops rendering further requests", () => {
		const root = newRoot();
		const harness = listenerHarness();
		const handle = mountInboxSendApproval(root, {
			onFrame: harness.onFrame,
			send: mock(() => undefined),
		});
		harness.emit(requestFrame());
		expect(root.querySelector(".inbox-approval")).not.toBeNull();

		handle.destroy();
		expect(root.querySelector(".inbox-approval")).toBeNull();

		harness.emit(requestFrame({ requestId: "req-2" }));
		expect(root.querySelector(".inbox-approval")).toBeNull();
	});
});

describe("background relay — inbox-send-approval-result", () => {
	test("forwards an approve click from the chat page to the daemon socket with the session token", async () => {
		const relay = await bootRelay();
		const response = await relay.postAsChatPage({
			type: MSG.inboxApprovalResult,
			sessionId: relay.sessionId,
			requestId: "req-1",
			approved: true,
		});
		expect(response).toEqual({ ok: true });

		const sent = relay.sentFrames().find((frame) => frame.type === "inbox-send-approval-result");
		expect(sent).toMatchObject({
			type: "inbox-send-approval-result",
			sessionId: relay.sessionId,
			token: relay.token,
			requestId: "req-1",
			approved: true,
		});
	});

	test("reports no open session when no daemon socket is connected yet", async () => {
		const relay = await bootRelay({ confirmSession: false });
		const response = await relay.postAsChatPage({
			type: MSG.inboxApprovalResult,
			sessionId: "unknown-session",
			requestId: "req-1",
			approved: false,
		});
		expect(response).toMatchObject({ ok: false });
	});
});
