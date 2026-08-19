import type { ProgressState } from "@dg/common";
import type { ChatSessionEntry } from "@/lib/features/chat-sessions";
import type {
	FetchAsset,
	TranscriptView,
} from "@/lib/features/chat-transcript";
import { createTranscriptView } from "@/lib/features/chat-transcript";

export type Composer = {
	inputElement: HTMLInputElement;
};

export type ChatNodeOptions = {
	document?: Document;
	port?: number;
	fetchAsset?: FetchAsset;
	onSubmit?: (body: string) => void;
	onClose?: (sessionId: string) => void;
	onMove?: (sessionId: string) => void;
};

export type ChatNode = {
	element: HTMLElement;
	transcript: TranscriptView;
	composer: Composer;
	render(entry: ChatSessionEntry): void;
	destroy(): void;
};

export type WorksetGroup = {
	workset?: string;
	sessions: ChatSessionEntry[];
};

export function statusLabel(status: ProgressState | "unknown"): string {
	switch (status) {
		case "running":
			return "RUNNING";
		case "awaiting-input":
			return "NEEDS YOU";
		case "agent-gone":
			return "agent-gone";
		case "unknown":
			return "unknown";
	}
}

export function createComposer(
	container: HTMLElement,
	onSubmit: (body: string) => void,
): Composer {
	const doc = container.ownerDocument;
	const composer = doc.createElement("div");
	composer.className = "chat-composer";

	const prompt = doc.createElement("span");
	prompt.className = "chat-composer__prompt";
	prompt.textContent = "$ @";

	const inputElement = doc.createElement("input");
	inputElement.className = "chat-composer__input";
	inputElement.type = "text";
	inputElement.autocomplete = "off";
	inputElement.placeholder = "Message this agent…";
	inputElement.setAttribute("aria-label", "Message this agent");
	inputElement.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" || event.isComposing) return;
		const body = inputElement.value.trim();
		if (!body) return;
		event.preventDefault();
		onSubmit(body);
		inputElement.value = "";
	});

	composer.append(prompt, inputElement);
	container.appendChild(composer);
	return { inputElement };
}

export function createChatNode(
	initialEntry: ChatSessionEntry,
	options: ChatNodeOptions = {},
): ChatNode {
	// options.document is the ratified seam; main.ts always passes it — no
	// test-convenience fallback that depends on another test's execution order.
	const doc = options.document ?? globalThis.document;
	if (!doc) throw new Error("createChatNode requires a browser document");
	const element = doc.createElement("article");
	element.className = "chat-node";

	const header = doc.createElement("header");
	header.className = "chat-node__header";

	const identity = doc.createElement("h2");
	identity.className = "chat-node__identity";

	const badge = doc.createElement("span");
	badge.className = "chat-node__status";
	badge.setAttribute("role", "status");

	const close = doc.createElement("button");
	close.className = "chat-node__close";
	close.type = "button";
	close.dataset.action = "close";
	close.textContent = "Close";
	close.addEventListener("click", () => {
		options.onClose?.(element.dataset.sessionId ?? initialEntry.sessionId);
	});
	const move = doc.createElement("button");
	move.className = "chat-node__move";
	move.type = "button";
	move.dataset.action = "move";
	move.textContent = "Move";
	move.addEventListener("click", (event) => {
		event.stopPropagation();
		options.onMove?.(element.dataset.sessionId ?? initialEntry.sessionId);
	});
	move.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		options.onMove?.(element.dataset.sessionId ?? initialEntry.sessionId);
	});

	header.append(identity, badge, move, close);

	const transcriptElement = doc.createElement("div");
	transcriptElement.className = "chat-transcript";
	transcriptElement.setAttribute("aria-live", "polite");

	const composerElement = doc.createElement("footer");
	composerElement.className = "chat-node__composer";
	const composer = createComposer(
		composerElement,
		options.onSubmit ?? (() => {}),
	);
	const transcript = createTranscriptView(transcriptElement, {
		port: options.port,
		fetchAsset: options.fetchAsset,
	});

	element.append(header, transcriptElement, composerElement);

	function render(entry: ChatSessionEntry): void {
		element.dataset.sessionId = entry.sessionId;
		element.dataset.role = entry.role;
		if (entry.workset) element.dataset.workset = entry.workset;
		else delete element.dataset.workset;
		identity.textContent = entry.agentIdentity;
		badge.dataset.status = entry.status;
		badge.textContent = statusLabel(entry.status);
		move.setAttribute("aria-label", `Move ${entry.agentIdentity}`);
		close.setAttribute("aria-label", `Close ${entry.agentIdentity} session`);
	}

	render(initialEntry);

	return {
		element,
		transcript,
		composer,
		render,
		destroy(): void {
			element.remove();
		},
	};
}

export function groupSessionsByWorkset(
	sessions: ChatSessionEntry[],
): WorksetGroup[] {
	const grouped = new Map<string, ChatSessionEntry[]>();
	const loose: ChatSessionEntry[] = [];

	for (const session of sessions) {
		if (session.workset === undefined) {
			loose.push(session);
			continue;
		}
		const group = grouped.get(session.workset);
		if (group) group.push(session);
		else grouped.set(session.workset, [session]);
	}

	const groups: WorksetGroup[] = Array.from(grouped, ([workset, entries]) => ({
		workset,
		sessions: [...entries].sort((a, b) => {
			if (a.role === b.role) return 0;
			return a.role === "orchestrator" ? -1 : 1;
		}),
	}));
	if (loose.length > 0) groups.push({ workset: undefined, sessions: loose });
	return groups;
}
