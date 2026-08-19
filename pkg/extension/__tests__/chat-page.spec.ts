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

// Required whenever a lib/features or lib/background barrel is reachable from
// a dynamic import — see plan.md's Agent Notes / this bundle's slice-4 lesson.
mock.module("wxt/browser", () => ({
	browser: { storage: { session: { get: mock(() => Promise.resolve({})) } } },
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
	// ...ArrowDown reorders it past its sibling without any pointer/drag event...
	root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
	// ...and Enter again commits the placement.
	root.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

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
	root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
	root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

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

test("rail and thread content live in one document with no second navigation level to keep in sync", async () => {
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

	// Everything a screen reader needs is reachable by walking childNodes in
	// order — no hidden panel, no second "view" toggle to switch into.
	expect(root.querySelector("[data-view], [aria-hidden='true']")).toBeNull();
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
