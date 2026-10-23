import {
	INBOX_SEND_APPROVAL_MAX_TIMEOUT_MS,
	type ChatFrame,
	type InboxSendApproval,
} from "@dg/common";

export type InboxSendApprovalOptions = {
	onFrame(listener: (frame: ChatFrame) => void): void;
	send(sessionId: string, requestId: string, approved: boolean): void;
	timeoutMs?: number;
};

export type InboxSendApprovalHandle = {
	destroy(): void;
};

type CardEntry = {
	card: HTMLElement;
	timer: ReturnType<typeof setTimeout>;
	settled: boolean;
};

function element<K extends keyof HTMLElementTagNameMap>(
	doc: Document,
	tag: K,
	className: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = doc.createElement(tag);
	node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function fieldRow(doc: Document, label: string, value: string): HTMLElement {
	const row = element(doc, "div", "inbox-approval__field");
	row.append(
		element(doc, "span", "inbox-approval__field-label", label),
		element(doc, "span", "inbox-approval__field-value", value),
	);
	return row;
}

/** Renders one send-approval card in the chat side panel per request, and settles it on a click or a self-expiry timer. */
export function mountInboxSendApproval(
	root: HTMLElement,
	options: InboxSendApprovalOptions,
): InboxSendApprovalHandle {
	const doc = root.ownerDocument;
	const timeoutMs = options.timeoutMs ?? INBOX_SEND_APPROVAL_MAX_TIMEOUT_MS;
	const cards = new Map<string, CardEntry>();
	let destroyed = false;

	function removeCard(requestId: string): void {
		const entry = cards.get(requestId);
		if (!entry) return;
		clearTimeout(entry.timer);
		entry.card.remove();
		cards.delete(requestId);
	}

	function renderCard(
		sessionId: string,
		requestId: string,
		approval: InboxSendApproval,
	): void {
		const card = element(doc, "section", "inbox-approval");
		card.setAttribute("role", "group");
		card.setAttribute("aria-label", "Approve sending mail");
		card.append(
			element(doc, "h3", "inbox-approval__title", "Approve sending mail"),
			fieldRow(doc, "Provider", `${approval.provider} / ${approval.profile}`),
			fieldRow(doc, "To", approval.to.join(", ")),
			fieldRow(doc, "Cc", approval.cc.join(", ") || "(none)"),
			fieldRow(doc, "Subject", approval.subject),
			element(doc, "pre", "inbox-approval__body", approval.text),
		);
		if (approval.attachments.length > 0) {
			card.append(fieldRow(doc, "Attachments", approval.attachments.join(", ")));
		}
		const approveButton = element(doc, "button", "inbox-approval__approve", "Approve send");
		approveButton.type = "button";
		const rejectButton = element(doc, "button", "inbox-approval__reject", "Reject");
		rejectButton.type = "button";
		function decide(approved: boolean): void {
			const entry = cards.get(requestId);
			if (!entry || entry.settled) return;
			entry.settled = true;
			clearTimeout(entry.timer);
			approveButton.disabled = true;
			rejectButton.disabled = true;
			options.send(sessionId, requestId, approved);
		}
		approveButton.addEventListener("click", () => decide(true));
		rejectButton.addEventListener("click", () => decide(false));
		const actions = element(doc, "div", "inbox-approval__actions");
		actions.append(approveButton, rejectButton);
		card.append(actions);
		root.append(card);
		const timer = setTimeout(() => removeCard(requestId), timeoutMs);
		cards.set(requestId, { card, timer, settled: false });
	}

	options.onFrame((frame) => {
		if (destroyed || frame.type !== "inbox-send-approval-request") return;
		renderCard(frame.sessionId, frame.requestId, frame.approval);
	});

	return {
		destroy() {
			destroyed = true;
			for (const requestId of [...cards.keys()]) removeCard(requestId);
		},
	};
}
