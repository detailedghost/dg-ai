import { afterEach, expect, mock, test } from "bun:test";
import { CHAT_PROTOCOL_VERSION, type ChatFrame } from "@dg/common";
import { Window } from "happy-dom";
import { renderChatPage } from "../src/chat/main";

const windows = new Set<Window>();

afterEach(async () => {
	await Promise.all([...windows].map((window) => window.happyDOM.close()));
	windows.clear();
});

function newRoot(): HTMLElement {
	const window = new Window();
	windows.add(window);
	const document = window.document as unknown as Document;
	const root = document.createElement("div");
	document.body.appendChild(root);
	return root as unknown as HTMLElement;
}

type FrameListener = (frame: ChatFrame) => void;

function fakeClient() {
	const listeners = new Set<FrameListener>();
	return {
		client: {
			connect: mock(() => {}),
			onConnectionChange: mock(() => {}),
			onFrame(listener: FrameListener) {
				listeners.add(listener);
			},
			sendUserMessage: mock(() => "message-id"),
			getConnectionState: () => "connected" as const,
			requestNewSession: mock(() => {}),
			closeSession: mock(() => {}),
		},
		emit(frame: unknown) {
			for (const listener of listeners) listener(frame as ChatFrame);
		},
	};
}

const SESSION = {
	port: 47823,
	sessionId: "session-a",
	token: "tok-a",
	agentIdentity: "claude-js",
};

const RECORDED_FRAMES = [
	{
		type: "session-list",
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		sessions: [
			{ sessionId: "session-a", agentIdentity: "claude-js", role: "agent" },
		],
	},
	{
		type: "agent-message",
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		body: "first recorded reply",
	},
	{
		type: "agent-message",
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		body: "second recorded reply",
	},
];

async function mountChat() {
	const root = newRoot();
	const fake = fakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => [SESSION],
	});
	return { root, fake };
}

test("renderChatPage renders a transcript from a recorded frame sequence", async () => {
	const { root, fake } = await mountChat();

	for (const frame of RECORDED_FRAMES) fake.emit(frame);

	const text = root.textContent ?? "";
	for (const frame of RECORDED_FRAMES.slice(1)) {
		expect(text).toContain(frame.body as string);
	}
	expect(text.indexOf("first recorded reply")).toBeLessThan(
		text.indexOf("second recorded reply"),
	);
	expect(root.querySelectorAll(".chat-node")).toHaveLength(1);
});

test("renderChatPage removes the node when session-closed arrives", async () => {
	const { root, fake } = await mountChat();
	for (const frame of RECORDED_FRAMES) fake.emit(frame);

	fake.emit({
		type: "session-closed",
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
	});

	expect(root.querySelectorAll(".chat-node")).toHaveLength(0);
});
