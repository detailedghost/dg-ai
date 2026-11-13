export type PwExtDialogAnswer = "accept" | "dismiss";

export type PwExtDialogAction =
	| { kind: "install" }
	| { kind: "read"; markSeen: boolean }
	| { kind: "answer"; answer: PwExtDialogAnswer; text?: string };

export type PwExtDialogRecord = {
	type: "alert" | "confirm" | "prompt";
	message: string;
	defaultValue?: string;
	answer: PwExtDialogAnswer;
	by: "policy" | "default";
	seen: boolean;
	at: number;
};

export type PwExtDialogState = {
	dialogs: PwExtDialogRecord[];
	pending?: { answer: PwExtDialogAnswer; withText: boolean };
};

/** Self-contained MAIN-world shim that answers alert, confirm and prompt from a one-shot policy, so a dialog never blocks the page; it returns raw, bounded records. */
export function pwExtDialogs(
	action: PwExtDialogAction,
	expectUrl?: string,
): PwExtDialogState | { error: string } {
	try {
		if (expectUrl !== undefined && document.URL !== expectUrl)
			return { error: "The page changed; nothing was done. Retry." };
		const MAX_DIALOGS = 10;
		const TEXT_MAX = 2000;
		const clip = (value: string) => (value.length > TEXT_MAX ? `${value.slice(0, TEXT_MAX)}…` : value);
		const text = (value: unknown): string => {
			try {
				return value === undefined ? "" : String(value);
			} catch {
				return "[unprintable]";
			}
		};
		type Slot = {
			dialogs: PwExtDialogRecord[];
			policy?: { answer: PwExtDialogAnswer; text?: string };
		};
		const KEY = Symbol.for("dg.pwExt.dialogs");
		const win = document.defaultView as unknown as Window & Record<symbol, unknown>;
		let slot = win[KEY] as Slot | undefined;
		if (slot === undefined || slot === null) {
			const fresh: Slot = { dialogs: [] };
			Object.defineProperty(win, KEY, { value: fresh, configurable: false });
			const record = (type: PwExtDialogRecord["type"], message: unknown, defaultValue?: unknown) => {
				const policy = fresh.policy;
				fresh.policy = undefined;
				const answer = policy?.answer ?? "dismiss";
				fresh.dialogs.push({
					type,
					message: clip(text(message)),
					...(defaultValue === undefined ? {} : { defaultValue: clip(text(defaultValue)) }),
					answer,
					by: policy ? "policy" : "default",
					seen: false,
					at: Date.now(),
				});
				if (fresh.dialogs.length > MAX_DIALOGS) fresh.dialogs.shift();
				return { answer, text: policy?.text };
			};
			const target = win as unknown as Record<"alert" | "confirm" | "prompt", unknown>;
			target.alert = function alert(message?: unknown): void {
				record("alert", message);
			};
			target.confirm = function confirm(message?: unknown): boolean {
				return record("confirm", message).answer === "accept";
			};
			target.prompt = function prompt(message?: unknown, defaultValue?: unknown): string | null {
				const { answer, text: given } = record("prompt", message, defaultValue);
				if (answer !== "accept") return null;
				return given ?? (defaultValue === undefined ? "" : text(defaultValue));
			};
			slot = fresh;
		}
		if (action.kind === "answer")
			slot.policy = { answer: action.answer, ...(action.text === undefined ? {} : { text: action.text }) };
		const state: PwExtDialogState = {
			dialogs: slot.dialogs.slice(-MAX_DIALOGS).map((dialog) => ({ ...dialog })),
			...(slot.policy
				? { pending: { answer: slot.policy.answer, withText: slot.policy.text !== undefined } }
				: {}),
		};
		if (action.kind === "read" && action.markSeen) for (const dialog of slot.dialogs) dialog.seen = true;
		return state;
	} catch (error) {
		return { error: `Dialog handling failed: ${String(error).slice(0, 200)}` };
	}
}
