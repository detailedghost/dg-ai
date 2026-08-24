import { expect, mock, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CHAT_PROTOCOL_VERSION, type ChatFrame } from "@dg/common";
import { Window } from "happy-dom";
import { MSG } from "@/lib/chat-messages";
import { stubChromeStorage } from "./utils/chrome-storage";
import { click, keydown, typeValue } from "./utils/dom-events";
import { buildSessionListFrame as sessionListFrame } from "./utils/frame-fixtures";

let relayMessageListener: ((message: unknown) => void) | undefined;
const relaySentMessages: unknown[] = [];
mock.module("wxt/browser", () => ({
	browser: {
		storage: { session: { get: mock(() => Promise.resolve({})) } },
		runtime: {
			onMessage: {
				addListener: mock((cb: (message: unknown) => void) => {
					relayMessageListener = cb;
				}),
			},
			sendMessage: mock((message: unknown) => {
				relaySentMessages.push(message);
				return Promise.resolve({ ok: true, state: "connected" });
			}),
		},
	},
}));

const { renderChatPage } = await import("../entrypoints/chat/main");

function newRoot(): HTMLElement {
	const window = new Window();
	const document = window.document as unknown as Document;
	const root = document.createElement("div");
	document.body.appendChild(root);
	return root as unknown as HTMLElement;
}

type FrameListener = (frame: ChatFrame) => void;

function makeFakeClient(
	initialState: "connected" | "daemon-not-running" = "connected",
) {
	const listeners = new Set<FrameListener>();
	const requestedSessions: Array<{ requestingSessionId: string }> = [];
	const closedSessions: string[] = [];
	const state = initialState;
	return {
		client: {
			connect: mock(() => {}),
			onFrame(listener: FrameListener) {
				listeners.add(listener);
			},
			sendUserMessage: mock(() => "message-id"),
			getConnectionState: () => state,
			requestNewSession: mock((requestingSessionId: string) => {
				requestedSessions.push({ requestingSessionId });
			}),
			closeSession: mock((sessionId: string) => {
				closedSessions.push(sessionId);
			}),
		},
		emit(frame: ChatFrame) {
			for (const listener of listeners) listener(frame);
		},
		requestedSessions,
		closedSessions,
	};
}

function progressFrame(
	sessionId: string,
	state: "running" | "awaiting-input" | "agent-gone",
): ChatFrame {
	return {
		type: "progress",
		sessionId,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		state,
	} as ChatFrame;
}

function bootstraps() {
	return [
		{
			port: 47823,
			sessionId: "session-a",
			token: "tok-a",
			agentIdentity: "claude-js",
		},
	];
}

test("renders one node per live session and removes it when session-closed arrives", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});

	fake.emit(
		sessionListFrame([
			{
				sessionId: "session-a",
				agentIdentity: "claude-js",
				role: "orchestrator",
			},
			{
				sessionId: "session-b",
				agentIdentity: "claude-security",
				role: "agent",
			},
		]),
	);

	expect(root.querySelectorAll(".chat-node").length).toBe(2);

	fake.emit({
		type: "session-closed",
		sessionId: "session-b",
		protocolVersion: CHAT_PROTOCOL_VERSION,
	} as ChatFrame);

	expect(root.querySelectorAll(".chat-node").length).toBe(1);
	expect(root.textContent).not.toContain("claude-security");
});

test("each rendered node exposes a composer input element the autocomplete can attach to", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([{ sessionId: "session-a", agentIdentity: "claude-js" }]),
	);

	const inputs = root.querySelectorAll(".chat-node input");
	expect(inputs.length).toBeGreaterThan(0);
});

test("the status badge on each node reflects that session's own state, including agent-gone", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([
			{ sessionId: "session-a", agentIdentity: "claude-js" },
			{ sessionId: "session-b", agentIdentity: "claude-security" },
		]),
	);
	fake.emit(progressFrame("session-a", "running"));
	fake.emit(progressFrame("session-b", "agent-gone"));

	const nodes = Array.from(root.querySelectorAll(".chat-node"));
	const nodeFor = (name: string) =>
		nodes.find((n) => n.textContent?.includes(name));

	expect(
		nodeFor("claude-js")
			?.querySelector("[data-status]")
			?.getAttribute("data-status"),
	).toBe("running");
	expect(
		nodeFor("claude-security")
			?.querySelector("[data-status]")
			?.getAttribute("data-status"),
	).toBe("agent-gone");
});

test("the create-chat affordance asks the client for a new session bound to the requesting session", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([
			{
				sessionId: "session-a",
				agentIdentity: "claude-js",
				role: "orchestrator",
			},
		]),
	);

	const createButton = root.querySelector<HTMLButtonElement>(
		"[data-action='create-chat']",
	);
	expect(createButton).not.toBeNull();
	createButton?.click();

	expect(fake.requestedSessions.length).toBe(1);
});

test("the close control on a node emits a session-close frame for that session, not a local hide", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([{ sessionId: "session-a", agentIdentity: "claude-js" }]),
	);

	const closeButton = root.querySelector<HTMLButtonElement>(
		".chat-node [data-action='close']",
	);
	expect(closeButton).not.toBeNull();
	closeButton?.click();

	expect(fake.closedSessions).toEqual(["session-a"]);
	expect(root.querySelectorAll(".chat-node").length).toBe(1);
});

test("every rail row exposes a keyboard-operable Move control that reorders without a drag gesture", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([
			{ sessionId: "session-a", agentIdentity: "claude-js", role: "agent" },
			{
				sessionId: "session-b",
				agentIdentity: "claude-security",
				role: "agent",
			},
		]),
	);

	const moveButtons = Array.from(
		root.querySelectorAll<HTMLButtonElement>("[data-action='move']"),
	);
	expect(moveButtons.length).toBe(2);
	expect(moveButtons.every((b) => b.tagName === "BUTTON")).toBe(true);

	keydown(moveButtons[0] as HTMLButtonElement, "Enter");
	keydown(root.ownerDocument, "ArrowDown");
	keydown(root.ownerDocument, "Enter");

	const orderAfter = Array.from(root.querySelectorAll(".chat-node")).map(
		(n) => n.textContent,
	);
	expect(orderAfter[0]).toContain("claude-security");
	expect(orderAfter[1]).toContain("claude-js");
});

test("Escape cancels an in-progress move and restores the original order", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([
			{ sessionId: "session-a", agentIdentity: "claude-js", role: "agent" },
			{
				sessionId: "session-b",
				agentIdentity: "claude-security",
				role: "agent",
			},
		]),
	);

	const moveButton = root.querySelector<HTMLButtonElement>(
		"[data-action='move']",
	);
	moveButton && keydown(moveButton, "Enter");
	keydown(root.ownerDocument, "ArrowDown");
	keydown(root.ownerDocument, "Escape");

	const orderAfter = Array.from(root.querySelectorAll(".chat-node")).map(
		(n) => n.textContent,
	);
	expect(orderAfter[0]).toContain("claude-js");
	expect(orderAfter[1]).toContain("claude-security");
});

test("clicking a different row while a move is armed places it there with a single pointer action, no drag events", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([
			{ sessionId: "session-a", agentIdentity: "claude-js", role: "agent" },
			{
				sessionId: "session-b",
				agentIdentity: "claude-security",
				role: "agent",
			},
		]),
	);

	const rows = Array.from(root.querySelectorAll<HTMLElement>(".chat-node"));
	const moveButton = rows[0]?.querySelector<HTMLButtonElement>(
		"[data-action='move']",
	);
	moveButton && keydown(moveButton, "Enter");
	rows[1]?.click();

	const orderAfter = Array.from(root.querySelectorAll(".chat-node")).map(
		(n) => n.textContent,
	);
	expect(orderAfter[0]).toContain("claude-security");
	expect(orderAfter[1]).toContain("claude-js");
});

test("regression: a progress frame arriving mid-typing does not move focus off the composer input", async () => {
	const root = newRoot();
	const doc = root.ownerDocument;
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([{ sessionId: "session-a", agentIdentity: "claude-js" }]),
	);

	const input = root.querySelector<HTMLInputElement>(".chat-node input");
	input?.focus();
	expect(doc.activeElement).toBe(input);

	fake.emit(progressFrame("session-a", "running"));

	expect(doc.activeElement).toBe(input);
});

test("regression: the arrow-key move sequence survives more than one frame arriving while armed", async () => {
	const root = newRoot();
	const doc = root.ownerDocument;
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([
			{ sessionId: "session-a", agentIdentity: "claude-js", role: "agent" },
			{
				sessionId: "session-b",
				agentIdentity: "claude-security",
				role: "agent",
			},
		]),
	);

	const moveButton = root.querySelector<HTMLButtonElement>(
		"[data-action='move']",
	);
	moveButton?.focus();
	moveButton && keydown(moveButton, "Enter");
	expect(doc.activeElement).toBe(moveButton);

	fake.emit(progressFrame("session-a", "running"));
	expect(doc.activeElement).toBe(moveButton);
	expect(doc.activeElement).not.toBe(doc.body);

	keydown(doc, "ArrowDown");
	keydown(doc, "Enter");

	const orderAfter = Array.from(root.querySelectorAll(".chat-node")).map(
		(n) => n.textContent,
	);
	expect(orderAfter[0]).toContain("claude-security");
	expect(orderAfter[1]).toContain("claude-js");
});

test("prefers-reduced-motion flips data-motion on the board root via the injected matchMedia seam", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	let changeListener: (() => void) | undefined;
	let matches = false;
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
		matchMedia: () => ({
			get matches() {
				return matches;
			},
			addEventListener: (_type: "change", cb: () => void) => {
				changeListener = cb;
			},
		}),
	});

	expect(root.getAttribute("data-motion")).toBe("full");

	matches = true;
	changeListener?.();

	expect(root.getAttribute("data-motion")).toBe("reduced");
});

test("the rail renders sections in workset order, orchestrator first, with a trailing loose-chats section", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([
			{
				sessionId: "s1",
				agentIdentity: "claude-js",
				role: "agent",
				workset: "001_chat_harness",
			},
			{
				sessionId: "orch1",
				agentIdentity: "orchestrator",
				role: "orchestrator",
				workset: "001_chat_harness",
			},
			{ sessionId: "loose1", agentIdentity: "shell", role: "agent" },
		]),
	);

	const sectionHeaders = Array.from(
		root.querySelectorAll(".chat-rail__section-header"),
	).map((el) => el.textContent);
	expect(sectionHeaders[0]).toContain("001_chat_harness");
	expect(sectionHeaders.at(-1)).toContain("loose");

	const firstSection = root.querySelectorAll(".chat-rail__section")[0];
	const firstSessionInSection = firstSection?.querySelector(
		".chat-node, [data-session-id]",
	);
	expect(firstSessionInSection?.textContent).toContain("orchestrator");
});

test("the primary rail-and-thread surface is the default view, reachable in document order with nothing hidden inside it", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([{ sessionId: "session-a", agentIdentity: "claude-js" }]),
	);

	expect(root.dataset.view).toBe("rail");
	const primary = root.querySelector(".chat-rail")?.parentElement;
	expect(primary).toBe(root);
	expect(
		root.querySelector(
			".chat-rail [aria-hidden='true'], .chat-thread [aria-hidden='true']",
		),
	).toBeNull();
	expect(root.querySelector(".chat-thread")?.hasAttribute("hidden")).toBe(
		false,
	);
	expect(root.textContent).toContain("claude-js");
});

const CHAT_ENTRY_DIR = join(import.meta.dir, "..", "entrypoints", "chat");
const CHAT_NODE_FILE = join(
	import.meta.dir,
	"..",
	"lib",
	"features",
	"chat-node.ts",
);

function collectChatPageSourceFiles(): string[] {
	const files: string[] = [CHAT_NODE_FILE];
	let entries: string[] = [];
	try {
		entries = readdirSync(CHAT_ENTRY_DIR);
	} catch {
		return files;
	}
	for (const name of entries) {
		const full = join(CHAT_ENTRY_DIR, name);
		if (statSync(full).isFile() && /\.(ts|css)$/.test(name)) files.push(full);
	}
	return files;
}

test("the chat page's own source files contain no hard-coded hex colors", () => {
	const files = collectChatPageSourceFiles();
	expect(files.length).toBeGreaterThan(0);
	const hexColorPattern = /#[0-9a-fA-F]{3,8}\b/;
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		expect(hexColorPattern.test(text)).toBe(false);
	}
});

test("the chat page's source files import nothing from ui-helpers.ts", () => {
	const files = collectChatPageSourceFiles();
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		expect(text.includes("ui-helpers")).toBe(false);
	}
});

test("the chat page's source files use neither aria-grabbed nor aria-dropeffect", () => {
	const files = collectChatPageSourceFiles();
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		expect(text.includes("aria-grabbed")).toBe(false);
		expect(text.includes("aria-dropeffect")).toBe(false);
	}
});

test("both inversion blocks remap the accent tokens too, not just bg/panel/ink/muted/line", () => {
	const css = readFileSync(join(CHAT_ENTRY_DIR, "style.css"), "utf8");
	const darkBlock = /\[data-theme=["']dark["']\]\s*\{([^}]*)\}/.exec(css)?.[1];
	const lightBlock = /\[data-theme=["']light["']\]\s*\{([^}]*)\}/.exec(
		css,
	)?.[1];
	expect(darkBlock).toBeDefined();
	expect(lightBlock).toBeDefined();

	const accentIn = (block: string, name: string): string | undefined =>
		new RegExp(`${name}:\\s*var\\((--[\\w-]+)\\)`).exec(block)?.[1];

	const darkAccent = accentIn(darkBlock as string, "--chat-accent");
	const lightAccent = accentIn(lightBlock as string, "--chat-accent");
	const darkAccent2 = accentIn(darkBlock as string, "--chat-accent-secondary");
	const lightAccent2 = accentIn(
		lightBlock as string,
		"--chat-accent-secondary",
	);

	expect(darkAccent).toBeDefined();
	expect(lightAccent).toBeDefined();
	expect(darkAccent2).toBeDefined();
	expect(lightAccent2).toBeDefined();
	expect(darkAccent).not.toBe(lightAccent);
	expect(darkAccent2).not.toBe(lightAccent2);
});

test("renders the 'no session ever registered' zero-state when there are no stored bootstraps", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => [],
	});

	const empty = root.querySelector("[data-empty-state]");
	expect(empty).not.toBeNull();
	expect(empty?.getAttribute("data-empty-state")).toBe("no-session");
});

test("renders the 'daemon unreachable' zero-state, with distinct copy, when a session is known but disconnected", async () => {
	const root = newRoot();
	const fake = makeFakeClient("daemon-not-running");
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});

	const empty = root.querySelector("[data-empty-state]");
	expect(empty).not.toBeNull();
	expect(empty?.getAttribute("data-empty-state")).toBe("daemon-unreachable");

	const otherRoot = newRoot();
	const otherFake = makeFakeClient();
	await renderChatPage({
		root: otherRoot,
		createClient: () => otherFake.client as never,
		loadBootstraps: async () => [],
	});
	expect(empty?.textContent).not.toBe(
		otherRoot.querySelector("[data-empty-state]")?.textContent,
	);
});

test("regression: a relayed session-list populates the rail and lets messages send even with no stored bootstraps", async () => {
	const root = newRoot();
	relaySentMessages.length = 0;
	await renderChatPage({ root, loadBootstraps: async () => [] });

	expect(
		root.querySelector("[data-empty-state]")?.getAttribute("data-empty-state"),
	).toBe("no-session");

	relayMessageListener?.({
		type: MSG.frame,
		frame: sessionListFrame([
			{ sessionId: "session-a", agentIdentity: "claude-js" },
		]),
	});

	expect(root.querySelector("[data-empty-state]")).toBeNull();
	const input = root.querySelector<HTMLInputElement>(".chat-node input");
	expect(input).not.toBeNull();

	if (!input) throw new Error("the composer input is missing");
	input.value = "hello after restart";
	keydown(input, "Enter");
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(relaySentMessages).toContainEqual(
		expect.objectContaining({
			type: MSG.userMessage,
			sessionId: "session-a",
			body: "hello after restart",
		}),
	);
	expect(
		root.querySelector(".chat-transcript__message--user")?.textContent,
	).toContain("hello after restart");
});

test("a send that is accepted still appends the user message to the transcript", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([{ sessionId: "session-a", agentIdentity: "claude-js" }]),
	);

	const input = root.querySelector<HTMLInputElement>(".chat-node input");
	if (!input) throw new Error("the composer input is missing");
	input.value = "hello agent";
	keydown(input, "Enter");
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(
		root.querySelector(".chat-transcript__message--user")?.textContent,
	).toContain("hello agent");
});

test("regression: a rejected send does not render as delivered, and shows a visible error", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	fake.client.sendUserMessage = mock(() => {
		throw new Error("session not available in this chat page");
	});
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([{ sessionId: "session-a", agentIdentity: "claude-js" }]),
	);

	const input = root.querySelector<HTMLInputElement>(".chat-node input");
	if (!input) throw new Error("the composer input is missing");
	input.value = "will this vanish?";
	keydown(input, "Enter");
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(root.textContent).not.toContain("will this vanish?");
	const error = root.querySelector(".chat-thread__error");
	expect(error).not.toBeNull();
	expect(error?.hasAttribute("hidden")).toBe(false);
	expect(error?.textContent).toContain("session not available");
});

test("a daemon error frame renders into a visible surface, not the screen-reader-only move status", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([{ sessionId: "session-a", agentIdentity: "claude-js" }]),
	);

	fake.emit({
		type: "error",
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		message: "command-invocation is not implemented yet",
	} as ChatFrame);

	const error = root.querySelector(".chat-thread__error");
	expect(error).not.toBeNull();
	expect(error?.hasAttribute("hidden")).toBe(false);
	expect(error?.textContent).toContain("not implemented yet");
	expect(
		root.querySelector(".chat-move-status")?.textContent ?? "",
	).not.toContain("not implemented yet");
});

test("regression: the daemon-unreachable zero-state does not flash when connect() settles to connected before the check", async () => {
	const root = newRoot();
	let state: "connected" | "reconnecting" | "daemon-not-running" =
		"daemon-not-running";
	const client = {
		connect: mock(() => {
			setTimeout(() => {
				state = "connected";
			}, 0);
		}),
		onFrame: mock(() => {}),
		sendUserMessage: mock(() => "message-id"),
		getConnectionState: () => state,
		requestNewSession: mock(() => {}),
		closeSession: mock(() => {}),
	};
	await renderChatPage({
		root,
		createClient: () => client as never,
		loadBootstraps: async () => bootstraps(),
	});

	expect(root.querySelector("[data-empty-state]")).toBeNull();
});

test("mounts command autocomplete on a node's composer, offering the published manifest's commands", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([{ sessionId: "session-a", agentIdentity: "claude-js" }]),
	);
	fake.emit({
		type: "manifest-publish",
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		commands: [
			{ label: "review", argv: ["gh", "pr", "review"], params: [] },
			{ label: "deploy", argv: ["make", "deploy"], params: [] },
		],
	} as ChatFrame);

	const input = root.querySelector(
		".chat-composer__input",
	) as unknown as HTMLInputElement;
	expect(input).toBeDefined();
	typeValue(input, "$rev");

	const listbox = input.ownerDocument.querySelector("[role='listbox']");
	expect(listbox).not.toBeNull();
	expect(listbox?.textContent).toContain("review");
	expect(listbox?.textContent).not.toContain("deploy");
});

test("Enter on a $ match dispatches a command instead of sending it as a chat message", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	const dispatched: Array<{ sessionId: string; commandLabel: string }> = [];
	const client = {
		...fake.client,
		sendCommandInvocation: (sessionId: string, commandLabel: string) => {
			dispatched.push({ sessionId, commandLabel });
			return Promise.resolve({ ok: true as const });
		},
	};
	await renderChatPage({
		root,
		createClient: () => client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([{ sessionId: "session-a", agentIdentity: "claude-js" }]),
	);
	fake.emit({
		type: "manifest-publish",
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		commands: [{ label: "review", argv: ["gh", "pr", "review"], params: [] }],
	} as ChatFrame);

	const input = root.querySelector(
		".chat-composer__input",
	) as unknown as HTMLInputElement;
	typeValue(input, "$rev");
	keydown(input, "ArrowDown");
	keydown(input, "Enter");

	expect(dispatched).toEqual([
		{ sessionId: "session-a", commandLabel: "review" },
	]);
	expect(fake.client.sendUserMessage).not.toHaveBeenCalled();
	expect(input.value).toBe("");
});

test("a session's manifest never offers another session's commands", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([
			{ sessionId: "session-a", agentIdentity: "claude-js" },
			{ sessionId: "session-b", agentIdentity: "claude-security" },
		]),
	);
	fake.emit({
		type: "manifest-publish",
		sessionId: "session-b",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		commands: [{ label: "audit", argv: ["audit"], params: [] }],
	} as ChatFrame);

	const inputs = Array.from(
		root.querySelectorAll(".chat-composer__input"),
	) as unknown as HTMLInputElement[];
	const first = inputs[0] as HTMLInputElement;
	typeValue(first, "$aud");

	const listbox = first.ownerDocument.querySelector("[role='listbox']");
	expect(listbox?.textContent ?? "").not.toContain("audit");
});

test("the canvas is an optional second view: off by default, revealed by an accessible rail toggle", async () => {
	stubChromeStorage();
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([{ sessionId: "session-a", agentIdentity: "claude-js" }]),
	);

	const toggle = root.querySelector(
		"[data-action='toggle-canvas']",
	) as unknown as HTMLButtonElement;
	expect(toggle).toBeDefined();
	expect(toggle.getAttribute("aria-pressed")).toBe("false");
	expect(root.dataset.view).toBe("rail");
	expect(root.querySelector(".chat-canvas__board")).toBeNull();

	click(toggle);

	expect(toggle.getAttribute("aria-pressed")).toBe("true");
	expect(root.dataset.view).toBe("canvas");
	expect(root.querySelector(".chat-canvas__board")).not.toBeNull();

	click(toggle);

	expect(root.dataset.view).toBe("rail");
	expect(toggle.getAttribute("aria-pressed")).toBe("false");
});

test("the canvas chrome carries the create-chat button, the daemon banner and zoom controls", async () => {
	stubChromeStorage();
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([{ sessionId: "session-a", agentIdentity: "claude-js" }]),
	);
	click(
		root.querySelector(
			"[data-action='toggle-canvas']",
		) as unknown as HTMLElement,
	);

	const chrome = root.querySelector(".chat-canvas__chrome");
	expect(chrome).not.toBeNull();
	expect(chrome?.querySelector("[data-action='create-chat']")).not.toBeNull();
	expect(chrome?.querySelector("[data-action='zoom-in']")).not.toBeNull();
	expect(chrome?.querySelector("[data-action='zoom-out']")).not.toBeNull();
	expect(chrome?.querySelector("[data-canvas-connection]")).not.toBeNull();
});

test("switching to the canvas keeps the rail reachable rather than replacing it, so the linear surface never disappears", async () => {
	stubChromeStorage();
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([{ sessionId: "session-a", agentIdentity: "claude-js" }]),
	);
	click(
		root.querySelector(
			"[data-action='toggle-canvas']",
		) as unknown as HTMLElement,
	);

	const rail = root.querySelector(".chat-rail");
	expect(rail).not.toBeNull();
	expect(rail?.hasAttribute("hidden")).toBe(false);
	expect(rail?.getAttribute("aria-hidden")).not.toBe("true");
	expect(root.textContent).toContain("claude-js");
});

test("closing a session tears down its autocomplete listbox rather than leaving it in the document", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([{ sessionId: "session-a", agentIdentity: "claude-js" }]),
	);
	const doc = root.ownerDocument;
	expect(doc.querySelectorAll("[role='listbox']").length).toBe(1);

	fake.emit({
		type: "session-closed",
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
	} as ChatFrame);

	expect(doc.querySelectorAll("[role='listbox']").length).toBe(0);
});

test("the canvas honours prefers-reduced-motion, which it reads from its own container not the page root", async () => {
	stubChromeStorage();
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
		matchMedia: () => ({ matches: true, addEventListener: () => {} }),
	});
	fake.emit(
		sessionListFrame([{ sessionId: "session-a", agentIdentity: "claude-js" }]),
	);
	click(
		root.querySelector(
			"[data-action='toggle-canvas']",
		) as unknown as HTMLElement,
	);

	const container = root.querySelector(".chat-canvas") as HTMLElement | null;
	expect(container?.dataset.motion).toBe("reduced");
});

test("closing the session armed for a keyboard move cancels move mode instead of leaving the rail armed to a session that is gone", async () => {
	const root = newRoot();
	const fake = makeFakeClient();
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(
		sessionListFrame([
			{ sessionId: "session-a", agentIdentity: "claude-js" },
			{ sessionId: "session-b", agentIdentity: "claude-security" },
			{ sessionId: "session-c", agentIdentity: "claude-dba" },
		]),
	);
	click(
		root.querySelector(
			"[data-session-id='session-b'] [data-action='move']",
		) as unknown as HTMLElement,
	);
	keydown(
		root.querySelector(
			"[data-session-id='session-b']",
		) as unknown as HTMLElement,
		"ArrowUp",
	);

	fake.emit({
		type: "session-closed",
		sessionId: "session-b",
		protocolVersion: CHAT_PROTOCOL_VERSION,
	} as ChatFrame);

	expect(root.querySelector(".chat-move-status")?.textContent).toBe(
		"Move cancelled — the session closed.",
	);
	expect(
		Array.from(root.querySelectorAll(".chat-rail__row")).map(
			(row) => (row as HTMLElement).dataset.sessionId,
		),
	).toEqual(["session-a", "session-c"]);

	click(
		root.querySelector(
			"[data-session-id='session-c']",
		) as unknown as HTMLElement,
	);

	expect(root.querySelector(".chat-move-status")?.textContent).toBe(
		"Move cancelled — the session closed.",
	);
});
