import { PAIR_CODE_PATTERN } from "@dg/common";
import { MSG, type PairOfferState } from "@dg/pages/chat-messages";
import { browser } from "wxt/browser";
import { button, element } from "./dom";
import { renderPairQr } from "./pair-qr";

export type PairRuntime = {
	sendMessage(message: unknown): Promise<unknown>;
};

export type PairingOptions = {
	runtime?: PairRuntime;
	pasteFold?: boolean;
	onState?: (state: PairOfferState) => void;
};

export type PairingHandle = {
	ready: Promise<void>;
	refresh(): Promise<void>;
	destroy(): void;
};

const START_DAEMON = "Start the daemon: run dg-agent start";
export const BACKGROUND_UNREACHABLE =
	"DeeGee is not responding. Close and reopen this popup.";
const PASTE_FAILED = "Could not pair. Retry, or check that the daemon is running.";

function asOfferState(reply: unknown): PairOfferState {
	const fallback: PairOfferState = {
		status: "error",
		error: BACKGROUND_UNREACHABLE,
	};
	if (typeof reply !== "object" || reply === null) return fallback;
	const fields = reply as Record<string, unknown>;
	switch (fields.status) {
		case "pending":
			return typeof fields.code === "string" &&
				PAIR_CODE_PATTERN.test(fields.code) &&
				typeof fields.expiresAt === "number"
				? { status: "pending", code: fields.code, expiresAt: fields.expiresAt }
				: fallback;
		case "claimed":
			return typeof fields.agentIdentity === "string"
				? { status: "claimed", agentIdentity: fields.agentIdentity }
				: fallback;
		case "error":
			return typeof fields.error === "string"
				? { status: "error", error: fields.error }
				: fallback;
		case "expired":
		case "daemon-down":
			return { status: fields.status };
		default:
			return fallback;
	}
}

function offerKey(state: PairOfferState): string {
	switch (state.status) {
		case "pending":
			return `pending:${state.code}`;
		case "claimed":
			return `claimed:${state.agentIdentity}`;
		case "error":
			return `error:${state.error}`;
		default:
			return state.status;
	}
}

export function mountPairing(
	root: HTMLElement,
	options: PairingOptions = {},
): PairingHandle {
	const doc = root.ownerDocument;
	const runtime =
		options.runtime ??
		((browser as unknown as { runtime: PairRuntime }).runtime);
	let destroyed = false;
	let shown: string | undefined;
	let inFlight: Promise<void> | undefined;
	let attaching = false;

	const offer = element(doc, "div", "pair-offer");

	const input = element(doc, "input", "pair-form__input grow");
	for (const [name, value] of Object.entries({
		id: "pair-code",
		type: "text",
		placeholder: "123456",
		inputmode: "numeric",
		maxlength: "6",
		autocomplete: "off",
		pattern: "\\d{6}",
		required: "",
	})) {
		input.setAttribute(name, value);
	}
	const submit = element(doc, "button", "btn", "Pair");
	submit.type = "submit";
	const form = element(doc, "form", "pair-form");
	form.append(input, submit);
	const label = element(doc, "label", "lbl", "Pair code");
	label.setAttribute("for", "pair-code");
	const status = element(doc, "p", "note");
	status.setAttribute("role", "status");
	const paste = element(doc, "div", "paste");
	paste.append(label, form, status);

	let pasteSection: HTMLElement = paste;
	if (options.pasteFold !== false) {
		const fold = element(doc, "details", "alt");
		fold.open = true;
		fold.append(element(doc, "summary", "", "Paste a code instead"), paste);
		pasteSection = fold;
	}
	root.replaceChildren(offer, pasteSection);

	function renderOffer(state: PairOfferState): void {
		const children: HTMLElement[] = [];
		const note = (text: string) => {
			const line = element(doc, "p", "note", text);
			line.setAttribute("role", "status");
			children.push(line);
		};
		const retry = (text: string) =>
			children.push(button(doc, "btn btn-sm", text, () => void request(true)));
		switch (state.status) {
			case "pending": {
				const copy = element(doc, "div");
				copy.append(
					element(doc, "b", "", "Scan"),
					element(
						doc,
						"p",
						"sub",
						`Copy the pair command from the QR code, or run dg-agent pair ${state.code} in the agent's terminal.`,
					),
					element(doc, "div", "code", state.code),
				);
				const box = element(doc, "div", "qrbox");
				box.append(
					renderPairQr({ text: `dg-agent pair ${state.code}`, doc }),
					copy,
				);
				children.push(box);
				break;
			}
			case "claimed":
				note(`Paired ${state.agentIdentity}`);
				break;
			case "expired":
				note("Code expired.");
				retry("New code");
				break;
			case "error":
				note(state.error);
				retry("Try again");
				break;
			case "daemon-down":
				note(START_DAEMON);
				break;
		}
		offer.replaceChildren(...children);
		pasteSection.hidden = state.status === "daemon-down";
	}

	function show(state: PairOfferState): void {
		options.onState?.(state);
		const key = offerKey(state);
		if (key === shown) return;
		shown = key;
		renderOffer(state);
	}

	function request(renew: boolean): Promise<void> {
		if (destroyed) return Promise.resolve();
		if (inFlight && !renew) return inFlight;
		const task = (async () => {
			let reply: unknown;
			try {
				reply = await runtime.sendMessage({
					type: MSG.pairOfferRequest,
					...(renew ? { renew: true } : {}),
				});
			} catch {
				reply = undefined;
			}
			if (!destroyed) show(asOfferState(reply));
		})().finally(() => {
			if (inFlight === task) inFlight = undefined;
		});
		inFlight = task;
		return task;
	}

	async function attach(code: string): Promise<void> {
		attaching = true;
		input.disabled = true;
		submit.disabled = true;
		form.setAttribute("aria-busy", "true");
		status.textContent = "";
		try {
			const reply = await runtime.sendMessage({
				type: MSG.sessionAttach,
				all: true,
				code,
			});
			if (destroyed) return;
			const fields = (reply ?? {}) as { ok?: unknown; error?: unknown };
			if (fields.ok === true) input.value = "";
			else
				status.textContent =
					typeof fields.error === "string" ? fields.error : PASTE_FAILED;
		} catch {
			if (!destroyed) status.textContent = PASTE_FAILED;
		} finally {
			attaching = false;
			input.disabled = false;
			submit.disabled = false;
			form.removeAttribute("aria-busy");
		}
	}

	input.addEventListener("input", () => {
		input.value = input.value.replace(/\D/g, "").slice(0, 6);
		status.textContent = "";
	});
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (attaching) return;
		if (!PAIR_CODE_PATTERN.test(input.value)) {
			status.textContent = "Enter a 6 digit code.";
			return;
		}
		void attach(input.value);
	});

	return {
		ready: request(false),
		refresh: () => request(false),
		destroy() {
			destroyed = true;
		},
	};
}
