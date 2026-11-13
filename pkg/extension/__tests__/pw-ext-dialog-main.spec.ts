import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { pwExtDialogs } from "@/lib/features/pw-ext-dialog-main";

let window: Window;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

beforeEach(() => {
	window = new Window({ url: "https://app.example.test/" });
	Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
});

afterEach(async () => {
	if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
	else delete (globalThis as { document?: unknown }).document;
	await window.happyDOM.close();
});

type PageDialogs = {
	alert(message?: unknown): void;
	confirm(message?: unknown): boolean;
	prompt(message?: unknown, defaultValue?: unknown): string | null;
};

const page = () => window as unknown as PageDialogs;

describe("dialog shim", () => {
	it("dismisses each dialog by default, records it, and never blocks", () => {
		expect(pwExtDialogs({ kind: "install" })).toEqual({ dialogs: [] });
		page().alert("Saved");
		expect(page().confirm("Delete 3 items?")).toBe(false);
		expect(page().prompt("Name?", "Ada")).toBeNull();
		const state = pwExtDialogs({ kind: "read", markSeen: false });
		expect(state).toEqual({
			dialogs: [
				{ type: "alert", message: "Saved", answer: "dismiss", by: "default", seen: false, at: expect.any(Number) },
				{ type: "confirm", message: "Delete 3 items?", answer: "dismiss", by: "default", seen: false, at: expect.any(Number) },
				{
					type: "prompt",
					message: "Name?",
					defaultValue: "Ada",
					answer: "dismiss",
					by: "default",
					seen: false,
					at: expect.any(Number),
				},
			],
		});
	});

	it("answers the next dialog once from the set policy, then goes back to dismiss", () => {
		pwExtDialogs({ kind: "answer", answer: "accept", text: "Grace" });
		expect(pwExtDialogs({ kind: "read", markSeen: false })).toMatchObject({
			pending: { answer: "accept", withText: true },
		});
		expect(page().prompt("Name?", "Ada")).toBe("Grace");
		expect(page().prompt("Again?")).toBeNull();
		pwExtDialogs({ kind: "answer", answer: "accept" });
		expect(page().prompt("Name?", "Ada")).toBe("Ada");
		pwExtDialogs({ kind: "answer", answer: "accept" });
		expect(page().confirm("Sure?")).toBe(true);
		const state = pwExtDialogs({ kind: "read", markSeen: false }) as { dialogs: { by: string }[]; pending?: unknown };
		expect(state.dialogs.map((dialog) => dialog.by)).toEqual(["policy", "default", "policy", "policy"]);
		expect(state.pending).toBeUndefined();
	});

	it("marks dialogs seen only when asked", () => {
		pwExtDialogs({ kind: "install" });
		page().alert("one");
		pwExtDialogs({ kind: "read", markSeen: true });
		const state = pwExtDialogs({ kind: "read", markSeen: false }) as { dialogs: { seen: boolean }[] };
		expect(state.dialogs[0]?.seen).toBe(true);
	});

	it("wraps the dialogs once per document", () => {
		pwExtDialogs({ kind: "install" });
		const wrapped = page().confirm;
		pwExtDialogs({ kind: "install" });
		expect(page().confirm).toBe(wrapped);
	});

	it("keeps the last 10 dialogs and bounds each text raw, with an ellipsis at the cut", () => {
		pwExtDialogs({ kind: "install" });
		for (let i = 0; i < 15; i++) page().alert(`${i} ${"m".repeat(3000)}`);
		const { dialogs } = pwExtDialogs({ kind: "read", markSeen: false }) as { dialogs: { message: string }[] };
		expect(dialogs).toHaveLength(10);
		expect(dialogs[0]?.message).toStartWith("5 ");
		expect(dialogs.every((dialog) => dialog.message.length === 2001 && dialog.message.endsWith("…"))).toBe(true);
	});

	it("returns dialog text raw for the background to mask", () => {
		pwExtDialogs({ kind: "install" });
		page().alert("token=abc123def456 ada@clinic.test");
		const { dialogs } = pwExtDialogs({ kind: "read", markSeen: false }) as { dialogs: { message: string }[] };
		expect(dialogs[0]?.message).toBe("token=abc123def456 ada@clinic.test");
	});

	it("refuses a document other than the tab's", () => {
		expect(pwExtDialogs({ kind: "install" }, "https://other.example.test/")).toEqual({
			error: expect.stringContaining("changed"),
		});
	});
});
