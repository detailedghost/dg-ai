import { decideSend } from "../safety/send-gate";
import { tokenMatches } from "../safety/token";

export const HOOK_ENV = ["DG_HOOK", "CLAUDE_HOOK", "DG_SSMS_HOOK"] as const;

export function isHookEnv(env: NodeJS.ProcessEnv): boolean {
	if (env.CLAUDE_PROJECT_DIR) return true;
	if (env.CLAUDE_CODE_ENTRYPOINT) return true;
	return HOOK_ENV.some((name) => {
		const value = env[name];
		return value !== undefined && value !== "" && value !== "0";
	});
}

export async function authorizeSend(input: {
	allowSend: boolean;
	hook: boolean;
	draftId: string;
	tty: boolean;
	token?: string;
	expectedTokenHash?: string;
	ask?: (draftId: string) => Promise<boolean>;
}): Promise<{ ok: true } | { ok: false; message: string }> {
	if (input.hook) {
		return { ok: false, message: "send is refused when invoked from a hook" };
	}
	if (!input.allowSend) {
		return { ok: false, message: "allow_send is false; this config never sends" };
	}
	const decision = await decideSend({
		tty: input.tty,
		token: input.token,
		expectedToken: input.expectedTokenHash,
		ask: input.ask,
		draftId: input.draftId,
		matches: tokenMatches,
	});
	if (decision.ok) return { ok: true };
	if (decision.reason === "declined") return { ok: false, message: "send declined" };
	if (decision.reason === "token") {
		return { ok: false, message: "approval token does not match this draft" };
	}
	return {
		ok: false,
		message: "send requires an interactive yes on a terminal, or --approve TOKEN for this draft",
	};
}
