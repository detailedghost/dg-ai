export const HOOK_ENV = ["DG_HOOK", "CLAUDE_HOOK", "DG_SSMS_HOOK"] as const;

export function hookEnvName(env: NodeJS.ProcessEnv): string | undefined {
	return HOOK_ENV.find((name) => {
		const value = env[name];
		return value !== undefined && value !== "" && value !== "0";
	});
}

export type SendDecision =
	| { ok: true; via: "flag" | "interactive" }
	| { ok: false; reason: "hook" | "unconfirmed" | "declined" };

export async function decideSend(input: {
	yes: boolean;
	hook: boolean;
	tty: boolean;
	ask?: (draftId: string) => Promise<boolean>;
	draftId: string;
}): Promise<SendDecision> {
	if (input.hook) return { ok: false, reason: "hook" };
	if (input.yes) return { ok: true, via: "flag" };
	if (input.tty && input.ask) {
		const accepted = await input.ask(input.draftId);
		return accepted
			? { ok: true, via: "interactive" }
			: { ok: false, reason: "declined" };
	}
	return { ok: false, reason: "unconfirmed" };
}
