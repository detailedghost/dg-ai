import { type PlayState, stateSteps } from "./engine";
import type { TourHost } from "./host";
import { clampPercent } from "./narration-progress";
import { injectTheme } from "./picker";
import { createEl as el, SANS } from "./ui-helpers";
import { pillButton } from "./widgets";

export type UiHandle = { remove(): void };

export type ModalHandle = UiHandle & {
	update(progress: number, label?: string): void;
};

export type ModalOptions = {
	title: string;
	body: string;
	kbd?: string;
	progress?: number;
	progressLabel?: string;
};

export type TourEndChoice = "restart" | "editor" | "close";

export type RecordPromptOptions = {
	shortcut: string | null;
	narrationLabel: string;
	shortcutsUrl: string;
};

function backdrop(dim: string): HTMLElement {
	return el("div", {
		position: "fixed",
		inset: "0",
		background: dim,
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		pointerEvents: "auto",
		zIndex: "2147483647",
	});
}

function centeredCard(): HTMLElement {
	return el("div", {
		maxWidth: "23.75rem",
		margin: "0 1.25rem",
		background: "var(--panel)",
		color: "var(--ink)",
		border: "0.125rem solid var(--line)",
		borderRadius: "0",
		padding: "1.25rem 1.375rem",
		boxShadow: "0.375rem 0.375rem 0 var(--accent)",
		font: `0.8125rem/1.6 ${SANS}`,
		textAlign: "center",
	});
}

function heading(text: string): HTMLElement {
	const h = el("div", {
		fontSize: "1rem",
		fontWeight: "700",
		textTransform: "uppercase",
		letterSpacing: "0.04em",
		marginBottom: "0.5rem",
	});
	h.textContent = text;
	return h;
}

function kbdLine(label: string): HTMLElement {
	const line = el("div", {
		marginTop: "0.875rem",
		fontSize: "0.8125rem",
		color: "var(--muted)",
	});
	const key = el("kbd", {
		background: "var(--code-bg)",
		border: "0.125rem solid var(--line)",
		borderRadius: "0",
		padding: "0.1875rem 0.5rem",
		color: "var(--accent)",
		font: "inherit",
	});
	key.textContent = label;
	line.append("Shortcut: ", key);
	return line;
}

async function mountCentered(
	host: TourHost,
	name: string,
	fill: (card: HTMLElement) => void,
): Promise<UiHandle> {
	return host.mountUi(name, (root) => {
		injectTheme(root);
		const layer = backdrop("rgba(0,0,0,0.6)");
		const card = centeredCard();
		fill(card);
		layer.appendChild(card);
		root.appendChild(layer);
	});
}

/** Centered status dialog on a dimmed backdrop, with an optional progress bar. */
export async function showModal(
	host: TourHost,
	opts: ModalOptions,
): Promise<ModalHandle> {
	let update: ModalHandle["update"] = () => {};
	const ui = await mountCentered(host, "dg-demo-modal", (card) => {
		const b = el("div");
		b.textContent = opts.body;
		card.append(heading(opts.title), b);
		if (opts.progress !== undefined) {
			const status = el("div", {
				marginTop: "0.875rem",
				color: "var(--muted)",
				fontSize: "0.75rem",
			});
			const bar = el("progress", {
				display: "block",
				width: "100%",
				height: "0.875rem",
				marginTop: "0.375rem",
				accentColor: "var(--accent)",
			});
			bar.max = 100;
			update = (progress, label) => {
				const value = clampPercent(progress);
				bar.value = value;
				bar.setAttribute("aria-valuetext", `${value}%`);
				status.textContent = `${label ?? opts.progressLabel ?? "Preparing"} · ${value}%`;
			};
			update(opts.progress, opts.progressLabel);
			card.append(status, bar);
		}
		if (opts.kbd) card.appendChild(kbdLine(opts.kbd));
	});
	return { remove: () => ui.remove(), update: (p, l) => update(p, l) };
}

/** Approval gate for authored click and fill actions; resolves true on approval. */
export async function showActionConsent(
	host: TourHost,
	state: PlayState,
): Promise<{ answer: Promise<boolean>; ui: UiHandle }> {
	const actions = [
		...(state.script.setup?.steps ?? []),
		...state.script.steps,
	].filter((step) => step.action != null);
	const included = state.script.setup?.includeInTour === true;
	let answer!: (approved: boolean) => void;
	const answered = new Promise<boolean>((resolve) => {
		answer = resolve;
	});
	const ui = await host.mountUi("dg-demo-setup-consent", (root) => {
		injectTheme(root);
		const layer = backdrop("rgba(0,0,0,0.65)");
		const card = el("div", {
			maxWidth: "30rem",
			margin: "0 1.25rem",
			background: "var(--panel)",
			color: "var(--ink)",
			border: "0.125rem solid var(--line)",
			padding: "1.25rem",
			boxShadow: "0.375rem 0.375rem 0 var(--accent)",
			font: `0.8125rem/1.6 ${SANS}`,
		});
		const title = el("div", {
			fontWeight: "700",
			textTransform: "uppercase",
			marginBottom: "0.5rem",
		});
		title.textContent = "Approve automatic tour actions";
		const summary = el("p");
		summary.textContent = `${actions.length} authored action(s) will click or fill page controls. Setup is ${included ? "included in the tour/video" : "excluded preparation before the tour/video"}.`;
		const warning = el("p", { color: "var(--accent)", fontWeight: "600" });
		warning.textContent =
			"Stored fill text is visible in the saved plan. Never store credentials, passwords, tokens, or MFA codes; enter those manually.";
		const controls = el("div", {
			display: "flex",
			gap: "0.5rem",
			justifyContent: "flex-end",
			marginTop: "1rem",
		});
		const cancel = pillButton("Cancel", false);
		cancel.addEventListener("click", () => answer(false));
		const approve = pillButton("Approve automatic actions", true);
		approve.addEventListener("click", () => answer(true));
		controls.append(cancel, approve);
		card.append(title, summary, warning, controls);
		layer.appendChild(card);
		root.appendChild(layer);
	});
	return { answer: answered, ui };
}

/** The end of a walkthrough: start over, go back to the plan, or close. */
export async function showTourEnd(
	host: TourHost,
	state: PlayState,
	canEdit: boolean,
): Promise<{ choice: Promise<TourEndChoice>; ui: UiHandle }> {
	const total = stateSteps(state).length;
	let pick!: (choice: TourEndChoice) => void;
	const choice = new Promise<TourEndChoice>((resolve) => {
		pick = resolve;
	});
	const ui = await mountCentered(host, "dg-demo-modal", (card) => {
		const b = el("div", { color: "var(--muted)" });
		b.textContent = `All ${total} step(s) shown. Start over, or close the tour.`;
		card.append(heading("✅ Walkthrough complete"), b);
		const mk = (lbl: string, primary: boolean, value: TourEndChoice): void => {
			const btn = pillButton(lbl, primary);
			btn.style.width = "100%";
			btn.style.marginTop = "0.5rem";
			btn.addEventListener("click", () => pick(value));
			card.appendChild(btn);
		};
		mk("↻ Start over", true, "restart");
		if (canEdit) mk("← Back to the plan", false, "editor");
		mk("✕ Close", false, "close");
	});
	return { choice, ui };
}

/** The "press to start" dialog shown before a video recording begins. */
export function showRecordPrompt(
	host: TourHost,
	opts: RecordPromptOptions,
): Promise<UiHandle> {
	return mountCentered(host, "dg-demo-modal", (card) => {
		const b = el("div");
		b.textContent = opts.shortcut
			? `This tour records itself and saves a video to your Downloads. Open the DeeGee popup and choose Record demo, or press ${opts.shortcut}, to start recording, then sit back and watch.`
			: "This tour records itself and saves a video to your Downloads. Open the DeeGee popup and choose Record demo to start recording, then sit back and watch.";
		const narrationRow = el("div", {
			marginTop: "0.875rem",
			fontSize: "0.8125rem",
			color: "var(--muted)",
		});
		const modeName = el("b", { color: "var(--ink)" });
		modeName.textContent = opts.narrationLabel;
		narrationRow.append(
			"Narration: ",
			modeName,
			" — change it in DeeGee Settings.",
		);
		let line: HTMLElement;
		if (opts.shortcut) line = kbdLine(opts.shortcut);
		else {
			line = el("div", {
				marginTop: "0.875rem",
				fontSize: "0.8125rem",
				color: "var(--accent2)",
			});
			line.textContent = `No keyboard shortcut is assigned to DeeGee — usually something else already holds it, most often an older unpacked copy of this extension. Open the DeeGee popup and choose Record demo, or assign a shortcut at ${opts.shortcutsUrl}.`;
		}
		card.append(heading("🎬 Video demo ready"), b, narrationRow, line);
	});
}
