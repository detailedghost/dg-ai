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

const LONG_SESSION = { ...SESSION, sessionId: "0123abcd-ef01-4567-89ab-cdef01234567" };

const PRESENCE_LABELS: readonly (readonly [string | undefined, string])[] = [
	["cli", "Agent attached"],
	["gone", "Agent gone"],
	["idle", "No agent listening"],
	["waiting", "No agent listening"],
	[undefined, "No agent listening"],
];
const ALL_LABELS = [...new Set(PRESENCE_LABELS.map(([, label]) => label))];

for (const [presence, label] of PRESENCE_LABELS) {
	test(`renderChatPage header shows ${label} for session-list presence ${presence ?? "missing"} with identity and short session id`, async () => {
		const root = newRoot();
		const fake = fakeClient();
		await renderChatPage({
			root,
			createClient: () => fake.client as never,
			loadBootstraps: async () => [LONG_SESSION],
		});

		fake.emit({
			type: "session-list",
			sessionId: LONG_SESSION.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			sessions: [
				{
					sessionId: LONG_SESSION.sessionId,
					agentIdentity: LONG_SESSION.agentIdentity,
					role: "agent",
					...(presence === undefined ? {} : { presence }),
				},
			],
		});

		const text = root.textContent ?? "";
		expect(text).toContain(label);
		for (const other of ALL_LABELS.filter((entry) => entry !== label)) {
			expect(text).not.toContain(other);
		}
		expect(text).toContain(LONG_SESSION.agentIdentity);
		expect(text).toContain(LONG_SESSION.sessionId.slice(0, 8));
		expect(text).not.toContain(LONG_SESSION.sessionId.slice(0, 9));
	});
}
