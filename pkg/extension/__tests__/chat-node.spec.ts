import { expect, test } from "bun:test";
import type { ProgressState } from "@dg/common";
import type { ChatSessionEntry } from "@/lib/features/chat-sessions";
import { createTestContainer, keydown } from "./utils/dom-events";

const { createComposer, createChatNode, statusLabel, groupSessionsByWorkset } =
	await import("@/lib/features/chat-node");

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

test("createComposer returns exactly the input element, mountable by an external caller", () => {
	const container = createTestContainer();
	const composer = createComposer(container, () => {});

	expect(composer.inputElement).toBeDefined();
	expect(composer.inputElement.tagName).toBe("INPUT");
	expect(container.contains(composer.inputElement)).toBe(true);
});

test("Enter in the composer input submits the trimmed body and clears the field", () => {
	const container = createTestContainer();
	const submitted: string[] = [];
	const composer = createComposer(container, (body: string) =>
		submitted.push(body),
	);

	composer.inputElement.value = "  hello agent  ";
	keydown(composer.inputElement, "Enter");

	expect(submitted).toEqual(["hello agent"]);
	expect(composer.inputElement.value).toBe("");
});

test("an empty or whitespace-only Enter submits nothing", () => {
	const container = createTestContainer();
	const submitted: string[] = [];
	const composer = createComposer(container, (body: string) =>
		submitted.push(body),
	);

	composer.inputElement.value = "   ";
	keydown(composer.inputElement, "Enter");

	expect(submitted).toEqual([]);
});

test("createChatNode renders the agent identity and mounts a transcript and a composer", () => {
	const container = createTestContainer();
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
	const container = createTestContainer();
	const submitted: string[] = [];
	const node = createChatNode(buildEntry(), {
		document: container.ownerDocument,
		port: 47823,
		onSubmit: (body: string) => submitted.push(body),
	});
	container.appendChild(node.element);

	node.composer.inputElement.value = "status please";
	keydown(node.composer.inputElement, "Enter");

	expect(submitted).toEqual(["status please"]);
});

test("createChatNode throws rather than falling back to a document left over from an earlier test's composer", () => {
	expect(() => createChatNode(buildEntry())).toThrow(
		/requires a browser document/,
	);
});

test("destroy removes the node's element from its parent", () => {
	const container = createTestContainer();
	const node = createChatNode(buildEntry(), {
		document: container.ownerDocument,
	});
	container.appendChild(node.element);

	node.destroy();

	expect(container.contains(node.element)).toBe(false);
});

test("render() updates the badge from a fresh session entry without replacing the element", () => {
	const container = createTestContainer();
	const node = createChatNode(buildEntry({ status: "running" }), {
		document: container.ownerDocument,
	});
	container.appendChild(node.element);
	const originalElement = node.element;

	node.render(buildEntry({ status: "awaiting-input" }));

	expect(node.element).toBe(originalElement);
	expect(node.element.textContent).toContain(statusLabel("awaiting-input"));
});

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
	const container = createTestContainer();
	const node = createChatNode(buildEntry({ status: "agent-gone" }), {
		document: container.ownerDocument,
	});
	container.appendChild(node.element);

	const badge = node.element.querySelector("[data-status]");
	expect(badge).not.toBeNull();
	expect(badge?.getAttribute("data-status")).toBe("agent-gone");
	expect(badge?.textContent).toBe(statusLabel("agent-gone"));
});

test("createChatNode emits no inline styles anywhere in its subtree", () => {
	const container = createTestContainer();
	const node = createChatNode(buildEntry(), {
		document: container.ownerDocument,
	});
	container.appendChild(node.element);

	expect(node.element.getAttribute("style")).toBeNull();
	const withStyleAttr = node.element.querySelectorAll("[style]");
	expect(withStyleAttr.length).toBe(0);
});

test("createChatNode's root element carries a stable class hook", () => {
	const container = createTestContainer();
	const node = createChatNode(buildEntry(), {
		document: container.ownerDocument,
	});
	container.appendChild(node.element);

	expect(node.element.classList.contains("chat-node")).toBe(true);
});

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
	expect(groups[0]?.workset).toBe("001_chat_harness");
});

test("groupSessionsByWorkset returns an empty list for no sessions, fabricating no section", () => {
	expect(groupSessionsByWorkset([])).toEqual([]);
});
