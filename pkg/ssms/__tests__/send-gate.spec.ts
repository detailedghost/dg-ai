import { describe, expect, test } from "bun:test";
import { decideSend } from "../src/safety/send-gate";

describe("decideSend", () => {
	test("a matching approval token sends without a terminal and does not ask", async () => {
		let asks = 0;
		const decision = await decideSend({
			tty: false,
			token: "abc",
			expectedToken: "abc",
			draftId: "d1",
			ask: async () => {
				asks += 1;
				return true;
			},
		});
		expect(decision).toEqual({ ok: true, via: "token" });
		expect(asks).toBe(0);
	});

	test("a token for a different draft is refused", async () => {
		const decision = await decideSend({
			tty: true,
			token: "other",
			expectedToken: "abc",
			draftId: "d1",
			ask: async () => true,
		});
		expect(decision).toEqual({ ok: false, reason: "token" });
	});

	test("a terminal asks once and accepts only that answer", async () => {
		const accepted = await decideSend({
			tty: true,
			draftId: "d1",
			ask: async (id) => id === "d1",
		});
		const declined = await decideSend({
			tty: true,
			draftId: "d1",
			ask: async () => false,
		});
		expect(accepted).toEqual({ ok: true, via: "interactive" });
		expect(declined).toEqual({ ok: false, reason: "declined" });
	});

	test("an empty token is not an approval", async () => {
		const decision = await decideSend({
			tty: false,
			token: "",
			expectedToken: "",
			draftId: "d1",
		});
		expect(decision).toEqual({ ok: false, reason: "unconfirmed" });
	});

	test("without a terminal and without the draft token there is no send", async () => {
		let asks = 0;
		const decision = await decideSend({
			tty: false,
			draftId: "d1",
			ask: async () => {
				asks += 1;
				return true;
			},
		});
		expect(decision).toEqual({ ok: false, reason: "unconfirmed" });
		expect(asks).toBe(0);
	});
});
