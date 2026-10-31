import { describe, expect, test } from "bun:test";
import { authorizeSend, isHookEnv } from "../src/cli/authorize";
import { hashToken } from "../src/safety/token";

describe("authorizeSend", () => {
	test("a declined terminal answer does not send", async () => {
		const decision = await authorizeSend({
			allowSend: true,
			hook: false,
			draftId: "d1",
			tty: true,
			ask: async () => false,
		});
		expect(decision).toEqual({ ok: false, message: "send declined" });
	});

	test("a wrong token does not send", async () => {
		const decision = await authorizeSend({
			allowSend: true,
			hook: false,
			draftId: "d1",
			tty: false,
			token: "not-the-token",
			expectedTokenHash: hashToken("the-token"),
		});
		expect(decision).toEqual({
			ok: false,
			message: "approval token does not match this draft",
		});
	});

	test("a hook is refused even with the right token and allow_send", async () => {
		const token = "abc123";
		const decision = await authorizeSend({
			allowSend: true,
			hook: true,
			draftId: "d1",
			tty: true,
			token,
			expectedTokenHash: hashToken(token),
			ask: async () => true,
		});
		expect(decision.ok).toBe(false);
		if (!decision.ok) expect(decision.message).toContain("hook");
	});

	test("allow_send false never sends, even with a yes and a matching token", async () => {
		const token = "abc123";
		const decision = await authorizeSend({
			allowSend: false,
			hook: false,
			draftId: "d1",
			tty: true,
			token,
			expectedTokenHash: hashToken(token),
			ask: async () => true,
		});
		expect(decision).toEqual({
			ok: false,
			message: "allow_send is false; this config never sends",
		});
	});

	test("an interactive yes sends, and no terminal and no token does not", async () => {
		const accepted = await authorizeSend({
			allowSend: true,
			hook: false,
			draftId: "d1",
			tty: true,
			ask: async () => true,
		});
		expect(accepted).toEqual({ ok: true });
		const unconfirmed = await authorizeSend({
			allowSend: true,
			hook: false,
			draftId: "d1",
			tty: false,
		});
		expect(unconfirmed.ok).toBe(false);
		if (!unconfirmed.ok) expect(unconfirmed.message).toContain("interactive yes");
	});

	test("each hook variable refuses, and an empty or zero flag does not", () => {
		expect(isHookEnv({ CLAUDE_PROJECT_DIR: "/tmp" })).toBe(true);
		expect(isHookEnv({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe(true);
		expect(isHookEnv({ DG_HOOK: "1" })).toBe(true);
		expect(isHookEnv({ CLAUDE_HOOK: "1" })).toBe(true);
		expect(isHookEnv({ DG_SSMS_HOOK: "1" })).toBe(true);
		expect(isHookEnv({ DG_HOOK: "" })).toBe(false);
		expect(isHookEnv({ DG_HOOK: "0" })).toBe(false);
		expect(isHookEnv({})).toBe(false);
	});

	test("the matching token sends when sending is allowed and this is not a hook", async () => {
		const token = "abc123";
		const decision = await authorizeSend({
			allowSend: true,
			hook: false,
			draftId: "d1",
			tty: false,
			token,
			expectedTokenHash: hashToken(token),
		});
		expect(decision).toEqual({ ok: true });
	});
});
