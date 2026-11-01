import { type TourScript, toPlanMarkdown } from "@dg/common";
import type { TourHost } from "./host";
import {
	DEFAULT_NARRATION,
	DEFAULT_VOICE,
	NARRATION_MODES,
	type NarrationMode,
	parseNarrationMode,
	VOICES,
	voiceLabel,
} from "./narration-options";
import { injectTheme } from "./picker";
import { createEl as el } from "./ui-helpers";
import { createPanel, pillButton, settingRow } from "./widgets";

export type StartMode = "review" | "walkthrough" | "video";

export type StartChoice = {
	mode: StartMode;
	includeSetup: boolean;
	narration: NarrationMode;
	voice: string;
};

export type StartSettings = { narration: NarrationMode; voice: string };

export type StartOptions = Partial<StartSettings> & {
	onSetting?: (patch: Partial<StartSettings>) => void;
};

type StartCardOptions = {
	stepCount: number;
	setup?: { stepCount: number; includeInTour: boolean };
	settings: StartSettings;
	onSetting?: (patch: Partial<StartSettings>) => void;
	onIncludeChange?: (include: boolean) => void;
	onPick: (mode: StartMode) => void;
	onDownload: () => void;
};

/** Fills `card` with the plan summary, setup toggle, narration pickers and actions. */
export function appendStartCard(
	card: HTMLElement,
	o: StartCardOptions,
): () => boolean {
	const h = el("div", {
		fontWeight: "700",
		textTransform: "uppercase",
		letterSpacing: "0.06em",
		marginBottom: "0.25rem",
	});
	h.textContent = "▶ Plan ready";
	const sub = el("div", { color: "var(--muted)", marginBottom: "0.75rem" });
	const setupCount = o.setup?.stepCount ?? 0;
	sub.textContent = `${o.stepCount} step(s)${
		setupCount ? `, including ${setupCount} setup step(s)` : ""
	}. Review it, or start straight away.`;
	card.append(h, sub);

	let include: HTMLInputElement | null = null;
	if (o.setup) {
		const setupLabel = el("label", {
			display: "block",
			marginBottom: "0.75rem",
			color: "var(--muted)",
		});
		const box = document.createElement("input");
		box.type = "checkbox";
		box.checked = o.setup.includeInTour;
		box.addEventListener("change", () => o.onIncludeChange?.(box.checked));
		include = box;
		setupLabel.append(
			box,
			` Include ${o.setup.stepCount} setup step(s) in this tour/video`,
		);
		card.appendChild(setupLabel);
	}

	card.appendChild(
		settingRow("Narration", NARRATION_MODES, o.settings.narration, (value) => {
			o.settings.narration = parseNarrationMode(value);
			o.onSetting?.({ narration: o.settings.narration });
		}),
	);
	card.appendChild(
		settingRow(
			"Voice",
			VOICES.map((v) => ({ value: v, label: voiceLabel(v) })),
			o.settings.voice,
			(value) => {
				o.settings.voice = value;
				o.onSetting?.({ voice: value });
			},
		),
	);

	const mk = (lbl: string, primary: boolean, onClick: () => void): void => {
		const b = pillButton(lbl, primary);
		b.style.width = "100%";
		b.style.marginTop = "0.5rem";
		b.addEventListener("click", onClick);
		card.appendChild(b);
	};
	mk("🔍 Review the plan step by step", false, () => o.onPick("review"));
	mk("▶ Play walkthrough", true, () => o.onPick("walkthrough"));
	mk("⏺ Record video", false, () => o.onPick("video"));
	mk("⬇ Download plan (.md)", false, o.onDownload);
	return () => include?.checked ?? false;
}

/** Shows the start card and resolves with what the viewer picked. */
export async function showStartScreen(
	host: TourHost,
	script: TourScript,
	opts: StartOptions = {},
): Promise<StartChoice> {
	const settings: StartSettings = {
		narration: opts.narration ?? DEFAULT_NARRATION,
		voice: opts.voice ?? DEFAULT_VOICE,
	};
	const panel = createPanel();
	let remove: (() => void) | undefined;
	let settled = false;
	let resolveChoice!: (choice: StartChoice) => void;
	const choice = new Promise<StartChoice>((resolve) => {
		resolveChoice = resolve;
	});

	const ui = await host.mountUi("dg-demo-start", (root) => {
		injectTheme(root);
		const card = panel(script.title || "Demo plan");
		const includeSetup = appendStartCard(card, {
			stepCount: script.steps.length + (script.setup?.steps.length ?? 0),
			setup: script.setup && {
				stepCount: script.setup.steps.length,
				includeInTour: script.setup.includeInTour,
			},
			settings,
			onSetting: opts.onSetting,
			onPick: (mode) => {
				if (settled) return;
				settled = true;
				remove?.();
				resolveChoice({ mode, includeSetup: includeSetup(), ...settings });
			},
			onDownload: () => {
				void host.messages.send({
					kind: "download-plan",
					markdown: toPlanMarkdown(script),
				});
			},
		});
		root.appendChild(card);
	});
	remove = ui.remove;
	if (settled) ui.remove();
	return choice;
}
