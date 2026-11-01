import {
	slugify,
	type TourMode,
	type TourScript,
	toPlanMarkdown,
} from "@dg/common";
import {
	type Draft,
	type DraftStep,
	draftRowToStep,
	draftToScript,
	type EditEvent,
	editMachine,
	editorInheritedPageUrl,
	editorPageUrl,
	editorReviewRows,
	editorSpotlightTarget,
	initialPlayState,
	missingActionTargetWarning,
	type PendingMarkerCapture,
	performAction,
	sameUrl,
	scriptToDraft,
	stepEffect,
} from "./engine";
import { type TourHost, tourKeys } from "./host";
import { demoMarkerFragment, stripDemoMarker } from "./marker";
import { DEFAULT_NARRATION, DEFAULT_VOICE } from "./narration-options";
import { injectTheme, startPicking } from "./picker";
import { appendStartCard, type StartOptions } from "./start-screen";
import { ACCENT, createEl as el, SANS } from "./ui-helpers";
import { arrowButton, createPanel, labeled, pillButton } from "./widgets";

export type EditorOptions = StartOptions & {
	start?: (script: TourScript) => Promise<void>;
	/** Shows a close control; called when the viewer closes the editor without playing. */
	onDismiss?: () => void;
};

export type EditorHandle = { remove(): void };

const EDIT_SPOT_ID = "dg-edit-spotlight";

/** Outline the current step's target on the live page (or clear it). */
function updateSpotlight(selector: string): void {
	document.getElementById(EDIT_SPOT_ID)?.remove();
	const t = editorSpotlightTarget(document, selector);
	if (!t) return;
	t.scrollIntoView({ block: "center", inline: "center" });
	const r = t.getBoundingClientRect();
	const box = el("div", {
		position: "fixed",
		left: `${r.left - 6}px`,
		top: `${r.top - 6}px`,
		width: `${r.width + 12}px`,
		height: `${r.height + 12}px`,
		border: `0.125rem solid ${ACCENT}`,
		borderRadius: "0.5rem",
		boxShadow: "0 0 0 624.9375rem rgba(0,0,0,0.45)",
		pointerEvents: "none",
		zIndex: "2147483640",
	});
	box.id = EDIT_SPOT_ID;
	document.body.appendChild(box);
}

export function clearSpotlight(): void {
	document.getElementById(EDIT_SPOT_ID)?.remove();
}

/** Selector field with an inline 🎯 picker button that fills the input on click. */
function selectorField(row: DraftStep): HTMLElement {
	const wrap = el("div", { marginTop: "0.625rem" });
	const label = el("label", {
		display: "block",
		fontSize: "0.6875rem",
		textTransform: "uppercase",
		letterSpacing: "0.12em",
		color: "var(--muted)",
		marginBottom: "0.25rem",
	});
	label.textContent = "Selector";
	const inputRow = el("div", { position: "relative" });
	const input = el("input", {
		width: "100%",
		boxSizing: "border-box",
		background: "var(--code-bg)",
		color: "var(--ink)",
		border: "0.125rem solid var(--line)",
		borderRadius: "0",
		padding: "0.375rem 2rem 0.375rem 0.5rem",
		font: `0.8125rem ${SANS}`,
	});
	input.className = "dg-field";
	input.value = row.selector;
	input.placeholder = "CSS selector (blank = centered)";
	input.addEventListener("input", () => {
		row.selector = input.value;
		updateSpotlight(input.value);
	});
	const pick = el("button", {
		position: "absolute",
		right: "0.25rem",
		top: "50%",
		transform: "translateY(-50%)",
		border: "0",
		background: "transparent",
		cursor: "pointer",
		padding: "0 0.25rem",
		fontSize: "0.875rem",
		lineHeight: "1",
	});
	pick.type = "button";
	pick.textContent = "🎯";
	pick.title = "Target element — click, then click something on the page";
	pick.addEventListener("click", () =>
		startPicking((sel) => {
			input.value = sel;
			row.selector = sel;
			updateSpotlight(sel);
			// Programmatic set fires no input event — dispatch one so edits persist.
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}),
	);
	inputRow.append(input, pick);
	wrap.append(label, inputRow);
	return wrap;
}

const FIELD_STYLE: Partial<CSSStyleDeclaration> = {
	width: "100%",
	boxSizing: "border-box",
	background: "var(--code-bg)",
	color: "var(--ink)",
	border: "0.125rem solid var(--line)",
	borderRadius: "0",
	padding: "0.375rem 0.5rem",
	font: `0.8125rem ${SANS}`,
};

/** Action field: a kind selector (none/click/type) + a text box shown for "type". */
function actionField(row: DraftStep): HTMLElement {
	const wrap = el("div", { marginTop: "0.625rem" });
	const label = el("label", {
		display: "block",
		fontSize: "0.6875rem",
		textTransform: "uppercase",
		letterSpacing: "0.12em",
		color: "var(--muted)",
		marginBottom: "0.25rem",
	});
	label.textContent = "Action (during playback)";
	const select = el("select", FIELD_STYLE);
	select.className = "dg-field";
	for (const [val, txt] of [
		["", "None"],
		["click", "Click the target"],
		["fill", "Type text into the target"],
	]) {
		const o = document.createElement("option");
		o.value = val;
		o.textContent = txt;
		if (val === row.actKind) o.selected = true;
		select.appendChild(o);
	}
	const textWrap = el("div", {
		marginTop: "0.375rem",
		display: row.actKind === "fill" ? "block" : "none",
	});
	const text = el("input", FIELD_STYLE);
	text.className = "dg-field";
	text.value = row.actText;
	text.placeholder = "Text to type";
	text.addEventListener("input", () => {
		row.actText = text.value;
	});
	textWrap.appendChild(text);
	select.addEventListener("change", () => {
		row.actKind = select.value as DraftStep["actKind"];
		textWrap.style.display = select.value === "fill" ? "block" : "none";
	});
	wrap.append(label, select, textWrap);
	return wrap;
}

/**
 * The review/edit stepper. Walks the steps one at a time — spotlighting each
 * target on the live page and letting the user improve its fields — then offers
 * Download / Play / Record on a final screen. All local; nothing leaves the tab.
 */
export async function showEditPanel(
	host: TourHost,
	script: TourScript,
	opts: EditorOptions = {},
): Promise<EditorHandle> {
	const keys = tourKeys(host);
	let teardown: (() => void) | null = null;
	const removeUi = (): void => {
		teardown?.();
		teardown = null;
	};
	const draft: Draft = scriptToDraft(script);
	let reviewRows = editorReviewRows(draft);
	let machine = editMachine(reviewRows.length);
	const editorConfig = {
		narration: opts.narration ?? DEFAULT_NARRATION,
		voice: opts.voice ?? DEFAULT_VOICE,
	};
	let phase = machine.next().value; // prime → the actions screen

	const takeEditCursor = async (): Promise<number | null> => {
		const v = await host.storage.get<number>(keys.edit);
		await host.storage.remove(keys.edit);
		// null, not 0: the editor now opens on the actions screen, so "resume at step 0"
		// and "nothing stored" are different destinations.
		return typeof v === "number" ? v : null;
	};
	const setEditCursor = (n: number): Promise<void> =>
		host.storage.set(keys.edit, n);

	/**
	 * Re-derive the row list from the draft and rebuild the stepper machine
	 * seeking to `want` (clamped to a valid row, or 0 if none remain).
	 *
	 * Add/remove changes the row count the machine was created with, and a
	 * generator can't be resized in place — replacing it and replaying
	 * editAgain + next(cursor) times is the same seek-to-cursor trick the
	 * URL-resume path below already relies on.
	 */
	const gotoCursor = (want: number): void => {
		reviewRows = editorReviewRows(draft);
		const target =
			reviewRows.length === 0
				? 0
				: Math.max(0, Math.min(want, reviewRows.length - 1));
		machine = editMachine(reviewRows.length);
		phase = machine.next().value;
		phase = machine.next("editAgain").value;
		for (let i = 0; i < target; i++) phase = machine.next("next").value;
	};

	// Resume at the step we navigated for (a step-driven page change reloads us here),
	// re-entering the stepper first since the machine now starts on the actions screen.
	const resume = await takeEditCursor();
	if (resume !== null) gotoCursor(resume);
	const dispatch = (event: EditEvent): void => {
		phase = machine.next(event).value;
		void render();
	};

	/** Perform cursor's row action against the live page, if it has one — an
	 *  authored action, or the click an advance:"click" row is waiting for. */
	const performReviewRowAction = async (cursor: number): Promise<boolean> => {
		const current = reviewRows[cursor];
		const step = current ? draftRowToStep(current.row) : undefined;
		const action = stepEffect(step);
		if (!step || !action) return false;
		const target = editorSpotlightTarget(document, step.selector ?? "");
		if (!target) {
			console.warn(missingActionTargetWarning(step));
			return false;
		}
		const before = stripDemoMarker(location.href);
		const anchor =
			action.do === "click"
				? target.closest<HTMLAnchorElement>("a[href]")
				: undefined;
		const destinationCursor = cursor + 1;
		const destination = reviewRows[destinationCursor];
		if (anchor && destination && !sameUrl(before, anchor.href, location.href)) {
			const normalized = stripDemoMarker(anchor.href);
			destination.row.navigate = normalized;
			persist();
			await setEditCursor(destinationCursor);
			await host.storage.set(keys.pending, {
				script: draftToScript(script.startUrl, draft),
				edit: true,
				capturedAt: Date.now(),
			} satisfies PendingMarkerCapture);
			anchor.href = normalized;
			await performAction(action, target);
			return true;
		}
		await performAction(action, target);
		if (action.do !== "click") return false;
		const currentUrl = stripDemoMarker(location.href);
		if (sameUrl(before, currentUrl, location.href) || !destination) return false;
		const normalized = stripDemoMarker(currentUrl);
		const inherited = editorInheritedPageUrl(
			draft,
			script.startUrl,
			destinationCursor,
		);
		if (!sameUrl(normalized, inherited, location.href)) {
			destination.row.navigate = normalized;
			persist();
		}
		return false;
	};

	/**
	 * Advance the review, performing the step's authored action first.
	 *
	 * Planning has to move the page the same way playback does. Reviewing used to
	 * only walk the cursor, so a plan whose later steps live behind a click — a
	 * wizard, a menu, a tab — left every one of those selectors unresolvable, and
	 * the editor showed a centered modal instead of the element being authored.
	 *
	 * A step timed `click` counts too, not just one with an authored `@click`.
	 * `advance: "click"` means playback waits for the user to click the target, so
	 * during planning the forward press *is* that click — without this, stepping a
	 * plan built from advance-timings (the common shape) still moved nothing.
	 *
	 * `‹` stays pure navigation and `«` reloads outright — neither replays an
	 * action. `»` is the deliberate exception: it runs every intervening row's
	 * action on the way to the last row, an intentional unattended multi-action
	 * run, not the single-row intent behind one forward press.
	 */
	const advanceReview = async (cursor: number): Promise<void> => {
		if (await performReviewRowAction(cursor)) return;
		dispatch("next");
	};

	/**
	 * Run forward to the last row, performing each row's action on the way — the
	 * planning-time equivalent of pressing › until it's disabled. Done in one
	 * pass with a single render at the end, rather than one render per row.
	 */
	const jumpToEnd = async (): Promise<void> => {
		while (phase.kind === "step") {
			if (await performReviewRowAction(phase.cursor)) return;
			if (phase.cursor >= reviewRows.length - 1) break;
			phase = machine.next("next").value;
		}
		void render();
	};

	/** Reload back to the first step — only a fresh load undoes on-page effects
	 *  clicks already fired; the draft survives via the URL-fragment mirror. */
	const restartReview = async (): Promise<void> => {
		await setEditCursor(0);
		location.reload();
	};

	const blankDraftStep = (): DraftStep => ({
		title: "",
		selector: "",
		body: "",
		timing: "",
		navigate: "",
		actKind: "",
		actText: "",
	});

	/** Insert a step after `cursor`, into whichever section (setup/tutorial) the
	 *  cursor is currently in, then land the cursor on the new row. */
	const addRow = (cursor: number): void => {
		const current = reviewRows[cursor];
		const kind = current?.kind ?? "tutorial";
		const rows = kind === "setup" ? draft.setup?.rows : draft.rows;
		if (!rows) return;
		const setupCount = draft.setup?.rows.length ?? 0;
		const localIndex = kind === "setup" ? cursor : cursor - setupCount;
		const insertAt = Math.min(Math.max(localIndex + 1, 0), rows.length);
		rows.splice(insertAt, 0, blankDraftStep());
		gotoCursor((kind === "setup" ? 0 : setupCount) + insertAt);
		void render();
	};

	/** Remove the row under review, then land the cursor on a valid remaining row. */
	const removeRow = (cursor: number): void => {
		const current = reviewRows[cursor];
		if (!current) return;
		const rows = current.kind === "setup" ? draft.setup?.rows : draft.rows;
		if (!rows) return;
		const setupCount = draft.setup?.rows.length ?? 0;
		const localIndex = current.kind === "setup" ? cursor : cursor - setupCount;
		rows.splice(localIndex, 1);
		gotoCursor(cursor);
		void render();
	};

	// The page a step runs on: the most recent `navigate` at/before it, else startUrl.
	const pageUrl = (idx: number): string =>
		editorPageUrl(draft, script.startUrl, idx);

	// Mirror the live draft into the URL fragment so a reload re-opens the editor
	// with edits intact (durable-via-URL). Cheap; called on edits + navigation.
	const persist = (): void => {
		const base = location.href.split("#")[0];
		const frag = demoMarkerFragment(
			draftToScript(script.startUrl, draft),
			true,
		);
		history.replaceState(history.state, "", `${base}#${frag}`);
	};

	const finish = async (mode: TourMode): Promise<void> => {
		draft.mode = mode;
		const s = draftToScript(script.startUrl, draft);
		// fromEdit so ending a walkthrough (or discarding a recording) returns here.
		await host.storage.set(
			keys.state,
			initialPlayState(s, "reviewed-editor"),
		);
		await host.storage.remove(keys.recording);
		clearSpotlight();
		// Drop the edit marker so playback isn't re-intercepted as editing on reload.
		history.replaceState(history.state, "", location.href.split("#")[0]);
		removeUi();
		await opts.start?.(s);
	};

	const dismiss = (): void => {
		clearSpotlight();
		history.replaceState(history.state, "", location.href.split("#")[0]);
		removeUi();
		opts.onDismiss?.();
	};

	const dismissButton = (): HTMLElement | null =>
		opts.onDismiss
			? arrowButton("✕", true, dismiss, "Close the editor")
			: null;

	const download = (): void => {
		const md = toPlanMarkdown(draftToScript(script.startUrl, draft));
		const blob = new Blob([md], { type: "text/markdown" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${slugify(draft.title)}.demo.md`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	};

	const panel = createPanel();

	const buildStepCard = (root: HTMLElement, cursor: number): void => {
		const total = reviewRows.length;
		const review = reviewRows[cursor];
		const status = review
			? review.kind === "setup"
				? draft.setup?.includeInTour
					? "Setup · included in tour/video"
					: "Setup · excluded preparation"
				: "Tutorial"
			: "No steps yet";
		const card = panel(`Review & edit · ${status}`);
		const last = total === 0 || cursor >= total - 1;

		if (cursor === 0)
			card.appendChild(
				labeled("Tour title", draft.title, "Tour title", (v) => {
					draft.title = v;
				}),
			);

		if (review) {
			const row = review.row;
			card.appendChild(
				labeled("Step title", row.title, "Step title", (v) => {
					row.title = v;
				}),
			);
			card.appendChild(selectorField(row));
			card.appendChild(
				labeled(
					"Body",
					row.body,
					"Callout text",
					(v) => {
						row.body = v;
					},
					true,
				),
			);
			card.appendChild(
				labeled("Timing", row.timing, "4s / click / next", (v) => {
					row.timing = v;
				}),
			);
			// Page URL: pre-filled with the step's effective page. Editing it to a new URL
			// records a `navigate`; matching the inherited page clears it (no redundant nav).
			const inherited = editorInheritedPageUrl(draft, script.startUrl, cursor);
			card.appendChild(
				labeled(
					"Page URL",
					row.navigate.trim() || inherited,
					"https://…",
					(v) => {
						row.navigate = v.trim() === inherited ? "" : v.trim();
					},
				),
			);
			card.appendChild(actionField(row));
			if (review.kind === "setup") {
				const warning = el("div", {
					marginTop: "0.625rem",
					padding: "0.5rem",
					border: "0.125rem solid var(--line)",
					color: "var(--accent)",
					fontWeight: "600",
				});
				warning.textContent =
					"Setup actions are saved as plain text and require playback approval. Never put credentials, passwords, tokens, or MFA codes in Fill text; enter them manually.";
				card.appendChild(warning);
			}
		} else {
			const empty = el("div", { color: "var(--muted)", marginTop: "0.625rem" });
			empty.textContent = "No steps yet — add one to get started.";
			card.appendChild(empty);
		}

		const bar = el("div", {
			display: "flex",
			flexWrap: "wrap",
			gap: "0.375rem",
			alignItems: "center",
			justifyContent: "center",
			marginTop: "0.875rem",
		});
		const restart = arrowButton(
			"«",
			cursor > 0,
			() => void restartReview(),
			"Restart at the first step",
		);
		const back = arrowButton(
			"‹",
			cursor > 0,
			() => dispatch("back"),
			"Previous step",
			"var(--accent2)",
		);
		const trace = el("div", {
			minWidth: "3rem",
			textAlign: "center",
			fontSize: "0.8125rem",
			letterSpacing: "0.08em",
			color: "var(--muted)",
		});
		trace.textContent = `${total === 0 ? 0 : cursor + 1} / ${total}`;
		const fwd = arrowButton(
			"›",
			!last,
			() => void advanceReview(cursor),
			"Next step",
			"var(--accent)",
		);
		const runEnd = arrowButton(
			"»",
			!last,
			() => void jumpToEnd(),
			"Run to the last step",
		);
		const addBtn = arrowButton("+", true, () => addRow(cursor), "Add step");
		const removeBtn = arrowButton(
			"−",
			total > 0,
			() => removeRow(cursor),
			"Remove step",
		);
		card.addEventListener("input", persist); // persist edits into the URL
		// Always available — reviewing every step to reach it was busywork when the plan
		// is already right — but it sits after the arrows so it can't split the pair.
		const approve = pillButton("✓ Approve", true);
		approve.style.background = "#00c853";
		approve.style.borderColor = "#00c853";
		approve.style.color = "#000";
		approve.addEventListener("click", () => dispatch("approve"));
		bar.append(restart, back, trace, fwd, runEnd, addBtn, removeBtn, approve);
		const close = dismissButton();
		if (close) bar.appendChild(close);
		card.appendChild(bar);
		root.appendChild(card);
	};

	const buildDoneCard = (root: HTMLElement): void => {
		const card = panel(draft.title || "Demo plan");
		appendStartCard(card, {
			stepCount: reviewRows.length,
			setup: draft.setup && {
				stepCount: draft.setup.rows.length,
				includeInTour: draft.setup.includeInTour,
			},
			settings: editorConfig,
			onSetting: opts.onSetting,
			onIncludeChange: (include) => {
				if (draft.setup) draft.setup.includeInTour = include;
				persist();
			},
			onPick: (mode) => {
				if (mode === "review") dispatch("editAgain");
				else void finish(mode);
			},
			onDownload: download,
		});
		const close = dismissButton();
		if (close) card.appendChild(close);
		root.appendChild(card);
	};

	const render = async (): Promise<void> => {
		// If this step lives on a different page, navigate there and resume the editor
		// at it on reload. Origin+pathname only, so ?query changes don't loop.
		if (phase.kind === "step") {
			const here = new URL(location.href);
			const there = new URL(pageUrl(phase.cursor), location.href);
			if (there.origin === here.origin && there.pathname !== here.pathname) {
				await setEditCursor(phase.cursor);
				const frag = demoMarkerFragment(
					draftToScript(script.startUrl, draft),
					true,
				);
				location.href = `${there.origin}${there.pathname}${there.search}#${frag}`;
				return;
			}
		}
		removeUi();
		persist(); // keep the URL in sync as the user navigates steps
		const cleanups: Array<() => void> = [];
		teardown = () => {
			clearSpotlight();
			for (const c of cleanups) c();
		};
		if (phase.kind === "step")
			updateSpotlight(reviewRows[phase.cursor]?.row.selector ?? "");
		else clearSpotlight();

		const ui = await host.mountUi("dg-demo-edit", (root) => {
			injectTheme(root);
			if (phase.kind === "done") buildDoneCard(root);
			else buildStepCard(root, phase.cursor);
		});
		cleanups.push(() => ui.remove());
	};

	await render();
	return { remove: removeUi };
}
