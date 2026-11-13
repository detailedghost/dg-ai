export type PwExtDialogAnswer = "accept" | "dismiss";

export type PwExtDialogAction =
	| { kind: "install" }
	| { kind: "remove" }
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

/** Self-contained MAIN-world shim that answers alert, confirm and prompt from a one-shot policy, so a dialog never blocks the page; once removed, the document keeps its native dialogs. */
export function pwExtDialogs(
	action: PwExtDialogAction,
	expectUrl?: string,
	owner?: number,
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
			active: boolean;
			removed: boolean;
			owner?: number;
			wrap(): void;
			unwrap(): void;
		};
		const KEY = Symbol.for("dg.pwExt.dialogs");
		const win = document.defaultView as unknown as Window & Record<symbol, unknown>;
		let slot = (win[KEY] ?? undefined) as Slot | undefined;
		if (slot === undefined && action.kind === "remove") return { dialogs: [] };
		if (slot === undefined) {
			const target = win as unknown as Record<"alert" | "confirm" | "prompt", (...args: unknown[]) => unknown>;
			const native = { alert: target.alert, confirm: target.confirm, prompt: target.prompt };
			const fresh: Slot = {
				dialogs: [],
				active: false,
				removed: false,
				wrap() {
					Object.assign(target, wrappers);
					fresh.active = true;
				},
				unwrap() {
					Object.assign(target, native);
					fresh.active = false;
					fresh.policy = undefined;
					fresh.dialogs.length = 0;
					fresh.removed = true;
				},
			};
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
			const wrappers = {
				alert: function alert(this: unknown, ...args: unknown[]): unknown {
					if (!fresh.active) return native.alert.apply(this, args);
					record("alert", args[0]);
					return undefined;
				},
				confirm: function confirm(this: unknown, ...args: unknown[]): unknown {
					if (!fresh.active) return native.confirm.apply(this, args);
					return record("confirm", args[0]).answer === "accept";
				},
				prompt: function prompt(this: unknown, ...args: unknown[]): unknown {
					if (!fresh.active) return native.prompt.apply(this, args);
					const { answer, text: given } = record("prompt", args[0], args[1]);
					if (answer !== "accept") return null;
					return given ?? (args[1] === undefined ? "" : text(args[1]));
				},
			};
			slot = fresh;
		}
		if (action.kind === "remove") slot.unwrap();
		if (slot.removed)
			return action.kind === "read" || action.kind === "answer"
				? {
						error:
							"This page lost its dialog shim when it left an agent tab group. Its dialogs show in the browser until the page loads again.",
					}
				: { dialogs: [] };
		if (owner !== undefined && slot.owner !== owner) {
			slot.dialogs.length = 0;
			slot.policy = undefined;
			slot.owner = owner;
		}
		if (!slot.active) slot.wrap();
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
	} catch {
		return { error: "Dialog handling failed on this page." };
	}
}
