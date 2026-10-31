import { decideSend } from "../safety/send-gate";

export async function authorizeSend(input: {
	allowSend: boolean;
	draftId: string;
	tty: boolean;
	token?: string;
	expectedToken?: string;
	ask?: (draftId: string) => Promise<boolean>;
}): Promise<{ ok: true } | { ok: false; message: string }> {
	if (!input.allowSend) {
		return { ok: false, message: "allow_send is false; this config never sends" };
	}
	const decision = await decideSend({
		tty: input.tty,
		token: input.token,
		expectedToken: input.expectedToken,
		ask: input.ask,
		draftId: input.draftId,
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
