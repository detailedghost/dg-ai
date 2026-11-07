import { afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { MSG } from "@dg/pages/chat-messages";
import { settle } from "./utils/relay-harness";

mock.module("wxt/browser", () => ({ browser: {} }));

const { mountPairing } = await import("@/lib/features/pairing");
const { renderPairQr } = await import("@/lib/features/pair-qr");

type OfferReply = Record<string, unknown>;

const windows = new Set<Window>();

afterEach(async () => {
	await Promise.all([...windows].map((window) => window.happyDOM.close()));
	windows.clear();
});

function newRoot(): HTMLElement {
	const window = new Window();
	windows.add(window);
	const root = window.document.createElement("div");
	window.document.body.append(root);
	return root as unknown as HTMLElement;
}

function stubRuntime(
	offer: { reply: OfferReply },
	other: (message: Record<string, unknown>) => unknown = () => ({ ok: true }),
) {
	return {
		onMessage: { addListener: mock(() => undefined) },
		sendMessage: mock((message: unknown) => {
			const payload = message as Record<string, unknown>;
			return Promise.resolve(
				payload.type === MSG.pairOfferRequest ? offer.reply : other(payload),
			);
		}),
	};
}

function sent(runtime: ReturnType<typeof stubRuntime>, type: string) {
	return runtime.sendMessage.mock.calls
		.map(([message]) => message as Record<string, unknown>)
		.filter((message) => message.type === type);
}

function button(root: HTMLElement, label: string): HTMLButtonElement | undefined {
	return [...root.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === label,
	) as HTMLButtonElement | undefined;
}

async function submit(root: HTMLElement, code: string): Promise<void> {
	const input = root.querySelector<HTMLInputElement>("input");
	if (!input) throw new Error("pairing input not found");
	const EventConstructor = root.ownerDocument.defaultView?.Event;
	if (!EventConstructor) throw new Error("event constructor not found");
	input.value = code;
	input.dispatchEvent(new EventConstructor("input", { bubbles: true }));
	root.querySelector<HTMLFormElement>("form")?.dispatchEvent(
		new EventConstructor("submit", { bubbles: true, cancelable: true }),
	);
	await settle();
}

function qrPathFor(root: HTMLElement, text: string): string {
	const original = Object.getOwnPropertyDescriptor(globalThis, "document");
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: root.ownerDocument,
	});
	try {
		return renderPairQr({ text }).querySelector("path")?.getAttribute("d") ?? "";
	} finally {
		if (original) Object.defineProperty(globalThis, "document", original);
		else Reflect.deleteProperty(globalThis, "document");
	}
}

const pending = (code = "123456"): OfferReply => ({
	status: "pending",
	code,
	expiresAt: 9_999_999,
});

describe("mountPairing offer view", () => {
	test("asks the background for an offer once on mount", async () => {
		const runtime = stubRuntime({ reply: pending() });
		const handle = mountPairing(newRoot(), { runtime });
		await handle.ready;

		const requests = sent(runtime, MSG.pairOfferRequest);
		expect(requests).toHaveLength(1);
		expect(requests[0]).not.toHaveProperty("renew");
		handle.destroy();
	});

	test("a pending offer shows the code, its QR and the scan copy", async () => {
		const root = newRoot();
		const handle = mountPairing(root, {
			runtime: stubRuntime({ reply: pending("654321") }),
		});
		await handle.ready;

		expect(root.textContent).toContain("654321");
		expect(root.querySelector('svg[aria-label="Pair QR code"]')).not.toBeNull();
		expect(root.textContent).toContain(
			"Copy the pair command from the QR code, or run dg-agent pair 654321 in the agent's terminal.",
		);
		handle.destroy();
	});

	test("the QR encodes the pair command for the shown code, leading zero kept", async () => {
		const root = newRoot();
		const handle = mountPairing(root, {
			runtime: stubRuntime({ reply: pending("012345") }),
		});
		await handle.ready;
		const expected = qrPathFor(root, "dg-agent pair 012345");

		expect(expected).not.toBe("");
		expect(
			root
				.querySelector('svg[aria-label="Pair QR code"]')
				?.querySelector("path")
				?.getAttribute("d"),
		).toBe(expected);
		handle.destroy();
	});

	test("a claimed offer names the paired agent and shows no QR", async () => {
		const root = newRoot();
		const handle = mountPairing(root, {
			runtime: stubRuntime({
				reply: { status: "claimed", agentIdentity: "claude-reviewer" },
			}),
		});
		await handle.ready;

		expect(root.textContent).toContain("Paired claude-reviewer");
		expect(root.querySelector('svg[aria-label="Pair QR code"]')).toBeNull();
		handle.destroy();
	});

	test("an expired offer says so and New code requests a renewal", async () => {
		const root = newRoot();
		const offer = { reply: { status: "expired" } as OfferReply };
		const runtime = stubRuntime(offer);
		const handle = mountPairing(root, { runtime });
		await handle.ready;
		expect(root.textContent).toContain("Code expired.");

		offer.reply = pending("111222");
		button(root, "New code")?.click();
		await settle();

		expect(sent(runtime, MSG.pairOfferRequest).at(-1)).toMatchObject({
			renew: true,
		});
		expect(root.textContent).toContain("111222");
		handle.destroy();
	});

	test("an error shows the daemon's text and Try again requests a renewal", async () => {
		const root = newRoot();
		const runtime = stubRuntime({
			reply: {
				status: "error",
				error: "too many pairing offers; wait for one to expire",
			},
		});
		const handle = mountPairing(root, { runtime });
		await handle.ready;
		expect(root.textContent).toContain(
			"too many pairing offers; wait for one to expire",
		);

		button(root, "Try again")?.click();
		await settle();

		expect(sent(runtime, MSG.pairOfferRequest).at(-1)).toMatchObject({
			renew: true,
		});
		handle.destroy();
	});

	test("a daemon-down offer shows the start command and no QR", async () => {
		const root = newRoot();
		const handle = mountPairing(root, {
			runtime: stubRuntime({ reply: { status: "daemon-down" } }),
		});
		await handle.ready;

		expect(root.textContent).toContain("Start the daemon: run dg-agent start");
		expect(root.querySelector('svg[aria-label="Pair QR code"]')).toBeNull();
		handle.destroy();
	});

	test("no render and no message follows destroy", async () => {
		const root = newRoot();
		let release: ((reply: OfferReply) => void) | undefined;
		const runtime = {
			onMessage: { addListener: mock(() => undefined) },
			sendMessage: mock(
				() =>
					new Promise((resolve) => {
						release = resolve as (reply: OfferReply) => void;
					}),
			),
		};
		const handle = mountPairing(root, { runtime });
		handle.destroy();
		const before = runtime.sendMessage.mock.calls.length;

		release?.(pending("999888"));
		await settle();

		expect(root.textContent).not.toContain("999888");
		expect(runtime.sendMessage.mock.calls).toHaveLength(before);
	});

	test("the panel sends only offer requests and the attach request", async () => {
		const root = newRoot();
		const runtime = stubRuntime({ reply: pending() });
		const handle = mountPairing(root, { runtime });
		await handle.ready;
		await submit(root, "123456");

		const types = runtime.sendMessage.mock.calls.map(
			([message]) => (message as { type?: string }).type,
		);
		expect([...new Set(types)].sort()).toEqual(
			[MSG.pairOfferRequest, MSG.sessionAttach].sort(),
		);
		handle.destroy();
	});

	test("renders nothing from a token field on the offer reply", async () => {
		const root = newRoot();
		const handle = mountPairing(root, {
			runtime: stubRuntime({
				reply: {
					status: "claimed",
					agentIdentity: "agent-x",
					token: "leaky-token",
				},
			}),
		});
		await handle.ready;

		expect(root.innerHTML).not.toContain("leaky-token");
		handle.destroy();
	});
});

describe("mountPairing paste form", () => {
	test("submitting a six digit code asks the background to attach every session", async () => {
		const root = newRoot();
		const runtime = stubRuntime({ reply: pending() });
		const handle = mountPairing(root, { runtime });
		await handle.ready;

		await submit(root, "123456");

		expect(sent(runtime, MSG.sessionAttach)).toEqual([
			{ type: MSG.sessionAttach, all: true, code: "123456" },
		]);
		handle.destroy();
	});

	test("the code input is numeric, six digits long and not remembered", async () => {
		const root = newRoot();
		const handle = mountPairing(root, {
			runtime: stubRuntime({ reply: pending() }),
		});
		await handle.ready;
		const input = root.querySelector<HTMLInputElement>("input");

		expect(input?.getAttribute("placeholder")).toBe("123456");
		expect(input?.getAttribute("inputmode")).toBe("numeric");
		expect(input?.getAttribute("maxlength")).toBe("6");
		expect(input?.getAttribute("autocomplete")).toBe("off");
		expect(input?.getAttribute("pattern")).toBe("\\d{6}");
		handle.destroy();
	});

	test("a value that is not six digits sends nothing and shows the length hint", async () => {
		const root = newRoot();
		const runtime = stubRuntime({ reply: pending() });
		const handle = mountPairing(root, { runtime });
		await handle.ready;

		await submit(root, "12ab");

		expect(sent(runtime, MSG.sessionAttach)).toHaveLength(0);
		expect(root.querySelector("[role='status']")?.textContent).toBe(
			"Enter a 6 digit code.",
		);
		handle.destroy();
	});

	test("a failed attach shows the daemon's error text and re-enables the form", async () => {
		const root = newRoot();
		const runtime = stubRuntime({ reply: pending() }, (message) =>
			message.type === MSG.sessionAttach
				? { ok: false, error: "incorrect pairing code; 4 attempts left" }
				: { ok: true },
		);
		const handle = mountPairing(root, { runtime });
		await handle.ready;

		await submit(root, "123456");

		expect(root.textContent).toContain(
			"incorrect pairing code; 4 attempts left",
		);
		expect(root.querySelector<HTMLInputElement>("input")?.disabled).toBe(false);
		expect(
			root.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled,
		).toBe(false);
		handle.destroy();
	});

	test("ignores a second submission while the attach is pending", async () => {
		const root = newRoot();
		let resolveAttach: ((reply: unknown) => void) | undefined;
		const runtime = {
			onMessage: { addListener: mock(() => undefined) },
			sendMessage: mock((message: unknown) =>
				(message as Record<string, unknown>).type === MSG.sessionAttach
					? new Promise((resolve) => {
							resolveAttach = resolve;
						})
					: Promise.resolve(pending()),
			),
		};
		const handle = mountPairing(root, { runtime });
		await handle.ready;

		await submit(root, "123456");
		await submit(root, "123456");

		expect(
			runtime.sendMessage.mock.calls.filter(
				([message]) => (message as { type?: string }).type === MSG.sessionAttach,
			),
		).toHaveLength(1);
		expect(root.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
		resolveAttach?.({ ok: true });
		await settle();
		handle.destroy();
	});
});
