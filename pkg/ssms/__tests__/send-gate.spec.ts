import { describe, expect, test } from "bun:test";
import { decideSend, hookEnvName } from "../src/safety/send-gate";

describe("hookEnvName", () => {
	test("treats only the hook variables as a hook", () => {
		expect(hookEnvName({})).toBeUndefined();
		expect(hookEnvName({ DG_HOOK: "0" })).toBeUndefined();
		expect(hookEnvName({ DG_HOOK: "" })).toBeUndefined();
		expect(hookEnvName({ DG_HOOK: "1" })).toBe("DG_HOOK");
		expect(hookEnvName({ CLAUDE_HOOK: "yes" })).toBe("CLAUDE_HOOK");
		expect(hookEnvName({ DG_SSMS_HOOK: "1" })).toBe("DG_SSMS_HOOK");
	});
});

describe("decideSend", () => {
	test("a hook refuses even when --yes is set and does not ask", async () => {
		let asks = 0;
		const decision = await decideSend({
			yes: true,
			hook: true,
			tty: true,
			draftId: "d1",
			ask: async () => {
				asks += 1;
				return true;
			},
		});
		expect(decision).toEqual({ ok: false, reason: "hook" });
		expect(asks).toBe(0);
	});

	test("--yes confirms without asking", async () => {
		let asks = 0;
		const decision = await decideSend({
			yes: true,
			hook: false,
			tty: true,
			draftId: "d1",
			ask: async () => {
				asks += 1;
				return false;
			},
		});
		expect(decision).toEqual({ ok: true, via: "flag" });
		expect(asks).toBe(0);
	});

	test("a terminal asks once and accepts only that answer", async () => {
		const accepted = await decideSend({
			yes: false,
			hook: false,
			tty: true,
			draftId: "d1",
			ask: async (id) => id === "d1",
		});
		const declined = await decideSend({
			yes: false,
			hook: false,
			tty: true,
			draftId: "d1",
			ask: async () => false,
		});
		expect(accepted).toEqual({ ok: true, via: "interactive" });
		expect(declined).toEqual({ ok: false, reason: "declined" });
	});

	test("without a terminal and without --yes there is no send", async () => {
		let asks = 0;
		const decision = await decideSend({
			yes: false,
			hook: false,
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
