import {
	CHAT_PAIR_PATH,
	type PairResponse,
	validatePairResponse,
} from "@dg/common";
import { browser } from "wxt/browser";
import { MSG } from "@/lib/chat-messages";
import { findDaemonPort } from "@/lib/daemon-port";

type PairRuntimeListener = (message: unknown) => void;

export type PairRuntime = {
	onMessage?: {
		addListener(listener: PairRuntimeListener): void;
		removeListener?(listener: PairRuntimeListener): void;
	};
	sendMessage?(message: unknown): Promise<unknown>;
};

export type PairingOptions = {
	variant: "entry" | "options";
	initialConnected?: boolean;
	runtime?: PairRuntime;
	findPort?: () => Promise<number | undefined>;
	fetch?: (input: string, init: RequestInit) => Promise<Response>;
};

export type PairingHandle = {
	ready: Promise<void>;
	refresh(): Promise<void>;
	setConnected(connected: boolean): void;
	destroy(): void;
};

const START_DAEMON = "Start the daemon: run dg-agent start";
const ASK_FOR_CODE = "Run dg-daemon pair in a terminal, then enter the code";
const CODE_EXPIRED = "Code expired. Run dg-daemon pair again.";
const OTHER_EXTENSION =
	"Paired to another extension. Run dg-daemon origin clear, then try again.";

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

function isConnectedReply(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as Record<string, unknown>).connected === true
	);
}

async function errorMessage(response: Response): Promise<string> {
	if (response.status === 401) {
		let attemptsLeft: unknown;
		try {
			const body = await response.text();
			try {
				attemptsLeft = (JSON.parse(body) as Record<string, unknown>)
					.attemptsLeft;
			} catch {
				attemptsLeft = Number(/(\d+)\s+attempts? left/i.exec(body)?.[1]);
			}
		} catch {}
		return typeof attemptsLeft === "number" && Number.isFinite(attemptsLeft)
			? `Wrong code. ${attemptsLeft} tries left.`
			: "Wrong code.";
	}
	if (response.status === 404 || response.status === 410) return CODE_EXPIRED;
	if (response.status === 409) return OTHER_EXTENSION;
	return "Could not pair. Try again.";
}

export function mountPairing(
	root: HTMLElement,
	options: PairingOptions,
): PairingHandle {
	const doc = root.ownerDocument;
	const runtime =
		options.runtime ??
		((browser as unknown as { runtime?: PairRuntime }).runtime ?? {});
	const findPort = options.findPort ?? (() => findDaemonPort());
	const fetchPair = options.fetch ?? ((input, init) => fetch(input, init));
	let port: number | undefined;
	let connected = options.initialConnected ?? false;
	let refreshVersion = 0;

	root.classList.add("pair-shell", `pair-shell--${options.variant}`);
	root.hidden = true;
	const panel = element(doc, "section", "pair-panel");
	const heading = element(
		doc,
		"h2",
		options.variant === "options" ? "sec-h" : "pair-panel__title",
		options.variant === "options" ? "Pair" : "Not paired",
	);
	const copy = element(doc, "p", "pair-panel__copy");
	const reveal = element(doc, "button", "pair-button", "Pair");
	reveal.type = "button";
	const form = element(doc, "form", "pair-form");
	const label = element(doc, "label", "pair-form__label", "Pair code");
	const input = element(doc, "input", "pair-form__input");
	input.type = "text";
	input.inputMode = "numeric";
	input.autocomplete = "one-time-code";
	input.pattern = "[0-9]{6}";
	input.maxLength = 6;
	input.required = true;
	label.append(input);
	const submit = element(doc, "button", "pair-button", "Pair");
	submit.type = "submit";
	const status = element(doc, "p", "pair-panel__status");
	status.setAttribute("role", "status");
	form.append(label, submit);
	panel.append(heading, copy, reveal, form, status);
	root.replaceChildren(panel);

	function showConnected(): void {
		if (options.variant === "entry") {
			root.hidden = true;
			return;
		}
		root.hidden = false;
		copy.textContent = "Paired";
		reveal.hidden = true;
		form.hidden = true;
		status.textContent = "Paired";
	}

	function showUnavailable(): void {
		root.hidden = false;
		copy.textContent = START_DAEMON;
		reveal.hidden = true;
		form.hidden = true;
		status.textContent = "";
	}

	function showReady(): void {
		root.hidden = false;
		copy.textContent = ASK_FOR_CODE;
		status.textContent = "";
		input.disabled = false;
		if (options.variant === "entry") {
			reveal.hidden = false;
			form.hidden = true;
		} else {
			reveal.hidden = true;
			form.hidden = false;
		}
	}

	async function refresh(): Promise<void> {
		const version = ++refreshVersion;
		let connectionReply: unknown;
		try {
			connectionReply = await runtime.sendMessage?.({
				type: MSG.connectionRequest,
			});
		} catch {}
		if (version !== refreshVersion) return;
		connected = isConnectedReply(connectionReply);
		if (connected) {
			showConnected();
			return;
		}
		port = await findPort();
		if (version !== refreshVersion) return;
		if (port === undefined) showUnavailable();
		else showReady();
	}

	function setConnected(nextConnected: boolean): void {
		if (connected === nextConnected) return;
		connected = nextConnected;
		refreshVersion += 1;
		if (connected) showConnected();
		else void refresh();
	}

	function onRuntimeMessage(message: unknown): void {
		if (typeof message !== "object" || message === null) return;
		const payload = message as Record<string, unknown>;
		if (payload.type !== MSG.connection) return;
		setConnected(payload.state === "connected");
	}

	input.addEventListener("input", () => {
		input.value = input.value.replace(/\D/g, "").slice(0, 6);
		status.textContent = "";
	});
	reveal.addEventListener("click", () => {
		reveal.hidden = true;
		form.hidden = false;
		input.focus();
	});
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void (async () => {
			if (!/^\d{6}$/.test(input.value)) {
				status.textContent = "Enter a 6 digit code.";
				return;
			}
			if (port === undefined) {
				showUnavailable();
				return;
			}
			submit.disabled = true;
			status.textContent = "";
			try {
				const response = await fetchPair(
					`http://127.0.0.1:${port}${CHAT_PAIR_PATH}`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ code: input.value }),
					},
				);
				if (!response.ok) {
					status.textContent = await errorMessage(response);
					return;
				}
				const bootstrap: PairResponse = validatePairResponse(
					await response.json(),
				);
				await runtime.sendMessage?.({
					type: MSG.markerCaptured,
					bootstrap,
				});
				status.textContent = "Paired";
				input.disabled = true;
			} catch {
				showUnavailable();
			} finally {
				submit.disabled = false;
			}
		})();
	});

	runtime.onMessage?.addListener(onRuntimeMessage);
	const ready = connected ? Promise.resolve(showConnected()) : refresh();
	return {
		ready,
		refresh,
		setConnected,
		destroy() {
			refreshVersion += 1;
			runtime.onMessage?.removeListener?.(onRuntimeMessage);
		},
	};
}
