/**
 * entrypoints/chat/main.ts: the grouped-rail-plus-thread page (Code
 * Structure's "Chat page layout verdict — grouped rail", variant A). Module
 * surface (`renderChatPage`) is a slice-6 RED invention — see this file's
 * accompanying [SPEC] deferral for the exact injectable-seam shape it pins,
 * mirroring registerChat's RegisterChatOptions pattern from slice 4.
 */

import { expect, mock, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CHAT_PROTOCOL_VERSION, type ChatFrame } from "@dg/common";
import { Window } from "happy-dom";
import { MSG } from "@/lib/chat-messages";
import { click, keydown, typeValue } from "./utils/dom-events";

// A barrel-reachable dynamic import needs this stub (plan.md's slice-4 lesson).
// `runtime` exercises the real relay client for finding 2's regression test only.
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

/** A minimal fake ChatClient — the page's own dependency, not the real socket. */
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

function sessionListFrame(
	sessions: Array<{
		sessionId: string;
		agentIdentity: string;
		role?: "orchestrator" | "agent";
		workset?: string;
	}>,
): ChatFrame {
	return {
		type: "session-list",
		sessionId: sessions[0]?.sessionId ?? "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		sessions: sessions.map((s) => ({ role: "agent" as const, ...s })),
	} as ChatFrame;
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

// --- Contract: one node per live session, removed when its session closes ---

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

// --- Contract: composer exposes the documented mount seam ---

test("each rendered node exposes a composer input element slice 8 can attach to", async () => {
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

// --- Status badge reflects the right node, including agent-gone ---

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

// --- Create-chat affordance and close control ---

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
	// A session-close request is not a local-hide: the node stays until the
	// daemon actually confirms with session-closed.
	expect(root.querySelectorAll(".chat-node").length).toBe(1);
});

// --- Keyboard reachability and single-pointer (non-drag) repositioning ---

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

	const KeyboardEvent = (
		root.ownerDocument.defaultView as unknown as {
			KeyboardEvent: typeof globalThis.KeyboardEvent;
		}
	).KeyboardEvent;

	// Enter arms move mode for the first row...
	moveButtons[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
	// ...ArrowDown reorders it past its sibling without any pointer/drag event —
	// dispatched on the document, where the delegated handler now lives.
	root.ownerDocument.dispatchEvent(
		new KeyboardEvent("keydown", { key: "ArrowDown" }),
	);
	// ...and Enter again commits the placement.
	root.ownerDocument.dispatchEvent(
		new KeyboardEvent("keydown", { key: "Enter" }),
	);

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

	const KeyboardEvent = (
		root.ownerDocument.defaultView as unknown as {
			KeyboardEvent: typeof globalThis.KeyboardEvent;
		}
	).KeyboardEvent;
	const moveButton = root.querySelector<HTMLButtonElement>(
		"[data-action='move']",
	);
	moveButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
	root.ownerDocument.dispatchEvent(
		new KeyboardEvent("keydown", { key: "ArrowDown" }),
	);
	root.ownerDocument.dispatchEvent(
		new KeyboardEvent("keydown", { key: "Escape" }),
	);

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

	const KeyboardEvent = (
		root.ownerDocument.defaultView as unknown as {
			KeyboardEvent: typeof globalThis.KeyboardEvent;
		}
	).KeyboardEvent;
	const rows = Array.from(root.querySelectorAll<HTMLElement>(".chat-node"));
	const moveButton = rows[0]?.querySelector<HTMLButtonElement>(
		"[data-action='move']",
	);
	moveButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
	// Click-to-place: a plain click on the target row, never mousedown+move+up.
	rows[1]?.click();

	const orderAfter = Array.from(root.querySelectorAll(".chat-node")).map(
		(n) => n.textContent,
	);
	expect(orderAfter[0]).toContain("claude-security");
	expect(orderAfter[1]).toContain("claude-js");
});

// --- Regression (finding 1): syncPage() must not steal focus on every frame ---

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

	// A previous bug called replaceChildren() on the thread pane on every
	// frame, detaching the focused composer input and dropping focus to body.
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

	const KeyboardEvent = (
		doc.defaultView as unknown as {
			KeyboardEvent: typeof globalThis.KeyboardEvent;
		}
	).KeyboardEvent;
	const moveButton = root.querySelector<HTMLButtonElement>(
		"[data-action='move']",
	);
	moveButton?.focus();
	moveButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
	expect(doc.activeElement).toBe(moveButton);

	// A progress frame lands mid-move — a prior bug rebuilt the thread pane
	// here, dropping focus to <body> and killing every key after the first.
	fake.emit(progressFrame("session-a", "running"));
	expect(doc.activeElement).toBe(moveButton);
	expect(doc.activeElement).not.toBe(doc.body);

	doc.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
	doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

	const orderAfter = Array.from(root.querySelectorAll(".chat-node")).map(
		(n) => n.textContent,
	);
	expect(orderAfter[0]).toContain("claude-security");
	expect(orderAfter[1]).toContain("claude-js");
});

// --- prefers-reduced-motion seam ---

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

// --- Workset-ordered rail sections, orchestrator pinned, loose chats trailing ---

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

// --- Document-order reachability, no second navigation level ---

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
		root.querySelector(".chat-rail [aria-hidden='true'], .chat-thread [aria-hidden='true']"),
	).toBeNull();
	expect(root.querySelector(".chat-thread")?.hasAttribute("hidden")).toBe(false);
	expect(root.textContent).toContain("claude-js");
});

// --- Source-text hygiene: no hard-coded hex colors, no ui-helpers.ts import ---

const CHAT_ENTRY_DIR = join(import.meta.dir, "..", "entrypoints", "chat");
const CHAT_NODE_FILE = join(
	import.meta.dir,
	"..",
	"lib",
	"features",
	"chat-node.ts",
);

function collectSliceSixSourceFiles(): string[] {
	const files: string[] = [CHAT_NODE_FILE];
	let entries: string[] = [];
	try {
		entries = readdirSync(CHAT_ENTRY_DIR);
	} catch {
		return files; // directory doesn't exist yet — RED stage
	}
	for (const name of entries) {
		const full = join(CHAT_ENTRY_DIR, name);
		if (statSync(full).isFile() && /\.(ts|css)$/.test(name)) files.push(full);
	}
	return files;
}

test("slice 6's own source files contain no hard-coded hex colors", () => {
	const files = collectSliceSixSourceFiles();
	expect(files.length).toBeGreaterThan(0);
	const hexColorPattern = /#[0-9a-fA-F]{3,8}\b/;
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue; // RED stage: file not written yet
		}
		expect(hexColorPattern.test(text)).toBe(false);
	}
});

test("slice 6's source files import nothing from ui-helpers.ts", () => {
	const files = collectSliceSixSourceFiles();
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

test("slice 6's source files use neither aria-grabbed nor aria-dropeffect", () => {
	const files = collectSliceSixSourceFiles();
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

// --- Accent tokens must follow the forced theme, not the OS preference ---

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
	// The whole point: each forced theme resolves to its OWN accent regardless
	// of which prefers-color-scheme block it's declared under.
	expect(darkAccent).not.toBe(lightAccent);
	expect(darkAccent2).not.toBe(lightAccent2);
});

// --- Two distinct zero-states ---

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

	// The two states must not share copy — assert the strings actually differ,
	// not merely that two different attribute values were set.
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

// --- Regression (finding 2): recovery after a browser restart clears
// storage.session, but the daemon's own sessions outlive that by design. ---

test("regression: a relayed session-list populates the rail and lets messages send even with no stored bootstraps", async () => {
	const root = newRoot();
	relaySentMessages.length = 0;
	await renderChatPage({ root, loadBootstraps: async () => [] });

	expect(
		root.querySelector("[data-empty-state]")?.getAttribute("data-empty-state"),
	).toBe("no-session");

	// The background relays this regardless of whether THIS page ever called
	// connect() itself — the page must trust it and learn its roster from it.
	relayMessageListener?.({
		type: MSG.frame,
		frame: sessionListFrame([
			{ sessionId: "session-a", agentIdentity: "claude-js" },
		]),
	});

	expect(root.querySelector("[data-empty-state]")).toBeNull();
	const input = root.querySelector<HTMLInputElement>(".chat-node input");
	expect(input).not.toBeNull();

	const KeyboardEvent = (
		root.ownerDocument.defaultView as unknown as {
			KeyboardEvent: typeof globalThis.KeyboardEvent;
		}
	).KeyboardEvent;
	input!.value = "hello after restart";
	input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
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

// --- Regression (finding 4): errors must be visible, and a send must be
// confirmed before it renders as delivered. ---

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

	const KeyboardEvent = (
		root.ownerDocument.defaultView as unknown as {
			KeyboardEvent: typeof globalThis.KeyboardEvent;
		}
	).KeyboardEvent;
	const input = root.querySelector<HTMLInputElement>(".chat-node input");
	input!.value = "hello agent";
	input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
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

	const KeyboardEvent = (
		root.ownerDocument.defaultView as unknown as {
			KeyboardEvent: typeof globalThis.KeyboardEvent;
		}
	).KeyboardEvent;
	const input = root.querySelector<HTMLInputElement>(".chat-node input");
	input!.value = "will this vanish?";
	input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
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

// --- Regression (finding 7): the daemon-unreachable zero-state must not
// flash on a healthy load, judged from a stale synchronous read. ---

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

// --- Slice 12: autocomplete dispatch, and the canvas as an optional second view ---

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
