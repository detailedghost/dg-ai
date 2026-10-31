export type SendDecision =
	| { ok: true; via: "interactive" | "token" }
	| { ok: false; reason: "unconfirmed" | "declined" | "token" };

export async function decideSend(input: {
	tty: boolean;
	token?: string;
	expectedToken?: string;
	ask?: (draftId: string) => Promise<boolean>;
	draftId: string;
	matches?: (token: string, expected: string) => boolean;
}): Promise<SendDecision> {
	const matches = input.matches ?? ((token, expected) => token === expected);
	if (typeof input.token === "string" && input.token.length > 0) {
		if (input.expectedToken && matches(input.token, input.expectedToken)) {
			return { ok: true, via: "token" };
		}
		return { ok: false, reason: "token" };
	}
	if (input.tty === true && input.ask) {
		const accepted = await input.ask(input.draftId);
		return accepted ? { ok: true, via: "interactive" } : { ok: false, reason: "declined" };
	}
	return { ok: false, reason: "unconfirmed" };
}
