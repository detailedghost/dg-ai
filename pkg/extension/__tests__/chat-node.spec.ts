/**
 * lib/features/chat-node.ts: one node per session — composer mount seam,
 * identity/status badge, workset grouping — plus the transcript slice 5
 * already owns. Module surface is a slice-6 RED invention; see plan.md's
 * "Composer mount seam" ratification for the cross-slice contract this pins.
 */

import { expect, test } from "bun:test";
import type { ProgressState } from "@dg/common";
import { Window } from "happy-dom";
import type { ChatSessionEntry } from "@/lib/features/chat-sessions";

const { createComposer, createChatNode, statusLabel, groupSessionsByWorkset } =
	await import("@/lib/features/chat-node");

function newContainer(): HTMLElement {
	const window = new Window();
	const document = window.document as unknown as Document;
	return document.createElement("div") as unknown as HTMLElement;
}

function buildEntry(
	overrides: Partial<ChatSessionEntry> = {},
): ChatSessionEntry {
	return {
		sessionId: "session-a",
		agentIdentity: "claude-js",
		role: "agent",
		workset: "001_chat_harness",
		status: "unknown",
		unreadCount: 0,
		...overrides,
	};
}

// --- Composer mount seam (Contract: composer exposes the documented mount seam) ---

test("createComposer returns exactly the input element, mountable by an external caller", () => {
	const container = newContainer();
	const composer = createComposer(container, () => {});

	expect(composer.inputElement).toBeDefined();
	expect(composer.inputElement.tagName).toBe("INPUT");
	expect(container.contains(composer.inputElement)).toBe(true);
});

test("Enter in the composer input submits the trimmed body and clears the field", () => {
	const container = newContainer();
	const submitted: string[] = [];
	const composer = createComposer(container, (body: string) =>
		submitted.push(body),
	);

	composer.inputElement.value = "  hello agent  ";
	composer.inputElement.dispatchEvent(
		new (
			container.ownerDocument.defaultView as unknown as {
				KeyboardEvent: typeof KeyboardEvent;
			}
		).KeyboardEvent("keydown", { key: "Enter" }),
	);

	expect(submitted).toEqual(["hello agent"]);
	expect(composer.inputElement.value).toBe("");
});

test("an empty or whitespace-only Enter submits nothing", () => {
	const container = newContainer();
	const submitted: string[] = [];
	const composer = createComposer(container, (body: string) =>
		submitted.push(body),
	);

	composer.inputElement.value = "   ";
	composer.inputElement.dispatchEvent(
		new (
			container.ownerDocument.defaultView as unknown as {
				KeyboardEvent: typeof KeyboardEvent;
			}
		).KeyboardEvent("keydown", { key: "Enter" }),
	);

	expect(submitted).toEqual([]);
});

// --- Node rendering ---

test("createChatNode renders the agent identity and mounts a transcript and a composer", () => {
	const container = newContainer();
	const node = createChatNode(
		buildEntry({ agentIdentity: "claude-security" }),
		{
			document: container.ownerDocument,
			port: 47823,
		},
	);
	container.appendChild(node.element);

	expect(node.element.textContent).toContain("claude-security");
	expect(node.composer.inputElement).toBeDefined();
	expect(container.contains(node.composer.inputElement)).toBe(true);
	expect(typeof node.transcript.appendUserMessage).toBe("function");
});

test("createChatNode wires the composer onSubmit option through to the composer input", () => {
	const container = newContainer();
	const submitted: string[] = [];
	const node = createChatNode(buildEntry(), {
		document: container.ownerDocument,
		port: 47823,
		onSubmit: (body: string) => submitted.push(body),
	});
	container.appendChild(node.element);

	node.composer.inputElement.value = "status please";
	node.composer.inputElement.dispatchEvent(
		new (
			container.ownerDocument.defaultView as unknown as {
				KeyboardEvent: typeof KeyboardEvent;
			}
		).KeyboardEvent("keydown", { key: "Enter" }),
	);

	expect(submitted).toEqual(["status please"]);
});

test("createChatNode throws rather than falling back to a document left over from an earlier test's composer", () => {
	// Must never resolve its document from a prior createComposer call's side effect.
	expect(() => createChatNode(buildEntry())).toThrow(
		/requires a browser document/,
	);
});

test("destroy removes the node's element from its parent", () => {
	const container = newContainer();
	const node = createChatNode(buildEntry(), {
		document: container.ownerDocument,
	});
	container.appendChild(node.element);

	node.destroy();

	expect(container.contains(node.element)).toBe(false);
});

test("render() updates the badge from a fresh session entry without replacing the element", () => {
	const container = newContainer();
	const node = createChatNode(buildEntry({ status: "running" }), {
		document: container.ownerDocument,
	});
	container.appendChild(node.element);
	const originalElement = node.element;

	node.render(buildEntry({ status: "awaiting-input" }));

	expect(node.element).toBe(originalElement);
	expect(node.element.textContent).toContain(statusLabel("awaiting-input"));
});

// --- Status badge (Contract: badge reflects chat-sessions' state, including agent-gone) ---

test("statusLabel maps every ProgressState plus the pre-progress unknown default to its documented text", () => {
	const cases: Array<[ProgressState | "unknown", string]> = [
		["running", "RUNNING"],
		["awaiting-input", "NEEDS YOU"],
		["agent-gone", "agent-gone"],
		["unknown", "unknown"],
	];
	for (const [status, expected] of cases) {
		expect(statusLabel(status)).toBe(expected);
	}
});

test("createChatNode's badge text and data-status attribute reflect the entry's status, including agent-gone", () => {
	const container = newContainer();
	const node = createChatNode(buildEntry({ status: "agent-gone" }), {
		document: container.ownerDocument,
	});
	container.appendChild(node.element);

	const badge = node.element.querySelector("[data-status]");
	expect(badge).not.toBeNull();
	expect(badge?.getAttribute("data-status")).toBe("agent-gone");
	expect(badge?.textContent).toBe(statusLabel("agent-gone"));
});

// --- Zero inline styles, class-hooked DOM only ---

test("createChatNode emits no inline styles anywhere in its subtree", () => {
	const container = newContainer();
	const node = createChatNode(buildEntry(), {
		document: container.ownerDocument,
	});
	container.appendChild(node.element);

	expect(node.element.getAttribute("style")).toBeNull();
	const withStyleAttr = node.element.querySelectorAll("[style]");
	expect(withStyleAttr.length).toBe(0);
});

test("createChatNode's root element carries a stable class hook", () => {
	const container = newContainer();
	const node = createChatNode(buildEntry(), {
		document: container.ownerDocument,
	});
	container.appendChild(node.element);

	expect(node.element.classList.contains("chat-node")).toBe(true);
});

// --- Workset grouping (Contract: rail sections in workset order, orchestrator first, loose chats trailing) ---

test("groupSessionsByWorkset sections by first-seen workset order, pins the orchestrator first in each section", () => {
	const sessions: ChatSessionEntry[] = [
		buildEntry({
			sessionId: "a-agent-1",
			workset: "001_chat_harness",
			role: "agent",
		}),
		buildEntry({
			sessionId: "a-orch",
			workset: "001_chat_harness",
			role: "orchestrator",
		}),
		buildEntry({
			sessionId: "b-orch",
			workset: "002_vela_favorites",
			role: "orchestrator",
		}),
	];

	const groups = groupSessionsByWorkset(sessions);

	expect(groups.map((g: { workset?: string }) => g.workset)).toEqual([
		"001_chat_harness",
		"002_vela_favorites",
	]);
	expect(groups[0]?.sessions[0]?.sessionId).toBe("a-orch");
	expect(groups[0]?.sessions[0]?.role).toBe("orchestrator");
	expect(groups[0]?.sessions[1]?.sessionId).toBe("a-agent-1");
});

test("groupSessionsByWorkset trails sessions with no workset into one loose-chats section", () => {
	const sessions: ChatSessionEntry[] = [
		buildEntry({ sessionId: "grouped", workset: "001_chat_harness" }),
		buildEntry({ sessionId: "loose-a", workset: undefined }),
		buildEntry({ sessionId: "loose-b", workset: undefined }),
	];

	const groups = groupSessionsByWorkset(sessions);

	expect(groups.at(-1)?.workset).toBeUndefined();
	expect(
		groups.at(-1)?.sessions.map((s: { sessionId: string }) => s.sessionId),
	).toEqual(["loose-a", "loose-b"]);
	// The loose section is always last, even though it wasn't the last one seen.
	expect(groups[0]?.workset).toBe("001_chat_harness");
});

test("groupSessionsByWorkset returns an empty list for no sessions, fabricating no section", () => {
	expect(groupSessionsByWorkset([])).toEqual([]);
});
