import {
	formatAdvance,
	parseAdvance,
	partitionTourSteps,
	type StepAction,
	type TourMode,
	type TourScript,
	type TourStep,
} from "@dg/common";
import { holdFor } from "./video-timing";
import { type SelectorQueryRoot, safeQuerySelector } from "./picker";

/** Internal tour playback state stored in storage.local (script + step index). */
export type PlayState = {
	script: TourScript;
	index: number;
	/** Excluded setup is a durable, user-paced phase before the tutorial. */
	phase?: "setup" | "tutorial";
	/** Explicit approval for automatic actions authored in setup steps. */
	setupActionsApproved?: boolean;
	/** Explicit approval covering every automatic action in the full script. */
	automaticActionsApproved?: boolean;
	/** Highest index whose action already ran, so a nav-triggered reload won't repeat it. */
	acted?: number;
	/** Launched from the review editor — a walkthrough end bounces back into it. */
	fromEdit?: boolean;
	/** Recorder-supplied holds persist across click-navigation content-script reloads. */
	videoDurations?: number[];
	/** Voice-only recordings keep spoken body copy off-screen after navigation too. */
	videoHideBody?: boolean;
	/** Step indices that got no voice clip, so voice-only recordings keep their captions. */
	videoUnvoiced?: number[];
};

/**
 * Rewind to the first step so a recording always opens the tour.
 *
 * The start prompt is reached with the cursor wherever setup — or an earlier pass through the
 * steps — left it, and the recorder cues narration clip N for step N. Recording from a non-zero
 * cursor therefore both skips the opening steps and desyncs the voiceover from the visuals.
 * `acted` resets to -1 (its unset sentinel) so replayed steps can run their actions again.
 */
export function recordingStartState(state: PlayState): PlayState {
	return { ...state, index: 0, acted: -1 };
}

/**
 * Back to the very beginning: the first step of the tour's opening phase.
 *
 * Keeps the approval flags and `fromEdit` — the user already granted those, and a
 * restart shouldn't re-ask — but clears `acted` so every action runs again. Callers
 * pair this with a navigation to `startUrl`, since clicks a tour already performed
 * cannot be undone by moving the cursor alone.
 */
export function restartState(state: PlayState): PlayState {
	return {
		...state,
		index: 0,
		phase: initialPlayPhase(state.script),
		acted: undefined,
	};
}

export const isVideo = (s: TourScript): boolean => s.mode === "video";

/** Durable playback phase: excluded preparation or the recordable tutorial. */
export type PlayPhase = "setup" | "tutorial";

/** The durable phase a fresh playback must enter. */
export function initialPlayPhase(script: TourScript): PlayPhase {
	return partitionTourSteps(script).setup.length ? "setup" : "tutorial";
}

/** Build initial lifecycle state without granting marker-authored action consent. */
export function initialPlayState(
	script: TourScript,
	source: "marker" | "reviewed-editor",
): PlayState {
	return {
		script,
		index: 0,
		phase: initialPlayPhase(script),
		...(source === "reviewed-editor"
			? { automaticActionsApproved: true, fromEdit: true }
			: {}),
	};
}

/** Reset setup-only cursor/action state when handing off to the tutorial. */
export function completeSetupPhase(state: PlayState): PlayState {
	return {
		...state,
		phase: "tutorial",
		index: 0,
		acted: undefined,
	};
}

/** Excluded setup is always user-paced; only tutorial video steps auto-play. */
export function automaticPlayback(state: PlayState): boolean {
	return isVideo(state.script) && !isSetup(state);
}

export const stateSteps = (state: PlayState): TourStep[] =>
	state.phase === "setup"
		? partitionTourSteps(state.script).setup
		: partitionTourSteps(state.script).tutorial;
export const isSetup = (state: PlayState): boolean => state.phase === "setup";

export type PlayStateWriter = (state: PlayState) => Promise<void>;

/** A `_demo` marker captured (and stripped) before its page could redirect out from under it. */
export type PendingMarkerCapture = {
	script: TourScript;
	edit: boolean;
	capturedAt: number;
};

/** Whether two URLs share an origin (scheme+host+port). */
export function sameOrigin(a: string, b: string, baseUrl: string): boolean {
	try {
		return new URL(a, baseUrl).origin === new URL(b, baseUrl).origin;
	} catch {
		return false;
	}
}

/** Same URL ignoring the fragment, so marker-stripping isn't seen as a move. */
export function sameUrl(a: string, b: string, baseUrl: string): boolean {
	try {
		const ua = new URL(a, baseUrl);
		const ub = new URL(b, baseUrl);
		return (
			ua.origin + ua.pathname + ua.search ===
			ub.origin + ub.pathname + ub.search
		);
	} catch {
		return a === b;
	}
}

/** The URL a step belongs on: the most recent `navigate` at/before it, else startUrl. */
export function expectedUrl(
	steps: TourStep[],
	startUrl: string,
	index: number,
): string {
	for (let i = index; i >= 0; i--) {
		const nav = steps[i]?.navigate;
		if (nav) return nav;
	}
	return startUrl;
}

/** Click the target, or type text into it char-by-char (visible in the recording). */
export function performAction(
	action: StepAction,
	target: HTMLElement,
): Promise<void> {
	if (action.do === "click") {
		target.click();
		return Promise.resolve();
	}
	const field = target as HTMLInputElement;
	field.focus();
	field.value = "";
	const text = action.value;
	return new Promise((resolve) => {
		let i = 0;
		const tick = (): void => {
			if (i >= text.length) {
				resolve();
				return;
			}
			field.value += text[i++];
			field.dispatchEvent(new Event("input", { bubbles: true }));
			setTimeout(tick, 70);
		};
		tick();
	});
}

/** Logged (and shown on the card) when a step's action never got a target to act on. */
export function missingActionTargetWarning(step: TourStep): string {
	return `dg-demo: step action "${step.action?.do}" was skipped — target "${step.selector ?? ""}" was not found on the page.`;
}

/**
 * What a step does to the page when nobody is driving it by hand.
 *
 * An authored `@click`/`@type` action, or else the click an `advance: "click"` step is
 * waiting for. The second half is the load-bearing part: `advance: "click"` is a
 * *timing* — "hold here until the user clicks the target" — not an action, so a tour
 * built entirely from timings (the common shape) has no `action` anywhere. Anything
 * replaying such a tour unattended has to supply that click itself, or the page never
 * moves and every later step spotlights an element that isn't there yet.
 */
export function stepEffect(step: TourStep | undefined): StepAction | undefined {
	if (step?.action) return step.action;
	return step?.advance === "click" ? { do: "click" } : undefined;
}

/**
 * Whether advancing must synthesize the click an `advance: "click"` step waits for.
 *
 * True only when a callout control drove the advance: the step has no authored
 * action of its own, it is waiting on a click, and its target resolved. When the
 * user clicks the target directly that click already happened, so this is false
 * and nothing is synthesized on top of it.
 */
export function advanceClickNeeded(
	step: TourStep,
	hasTarget: boolean,
	fromControl: boolean,
): boolean {
	return fromControl && !step.action && step.advance === "click" && hasTarget;
}

export type NarrationOutcome = "ended" | "timeout" | "cancelled";

export type VideoStepSequenceDeps = {
	waitForNarration: () => Promise<NarrationOutcome>;
	performEffect: () => Promise<void>;
	pause: (ms: number) => Promise<void>;
	advance: () => Promise<void>;
	cancelled: () => boolean;
};

/** Order one recorded step: narration, effect, authored tail, then advance. */
export async function runVideoStepSequence(
	step: TourStep,
	deps: VideoStepSequenceDeps,
): Promise<void> {
	const narration = await deps.waitForNarration();
	if (narration === "cancelled" || deps.cancelled()) return;
	await deps.performEffect();
	if (deps.cancelled()) return;
	if (narration === "ended") await deps.pause(holdFor(step, 0));
	if (!deps.cancelled()) await deps.advance();
}

/** Resolve an editor spotlight selector without letting invalid CSS escape. */
export function editorSpotlightTarget(
	root: SelectorQueryRoot,
	selector: string,
): HTMLElement | null {
	return selector ? safeQuerySelector<HTMLElement>(root, selector) : null;
}

/** One editable step row in the panel (strings; timing parses to `advance`). */
export type DraftStep = {
	title: string;
	selector: string;
	body: string;
	timing: string;
	navigate: string;
	actKind: "" | "click" | "fill";
	actText: string;
};

/** Editable tour fields, including optional setup rows and their inclusion choice. */
export type Draft = {
	title: string;
	mode: TourMode;
	rows: DraftStep[];
	setup?: { rows: DraftStep[]; includeInTour: boolean };
};

/** A setup or tutorial row in the extension's ordered review sequence. */
export type EditorReviewRow = {
	kind: "setup" | "tutorial";
	row: DraftStep;
	status: string;
};

/** Every setup row is reviewed before the tutorial rows, with its fate visible. */
export function editorReviewRows(draft: Draft): EditorReviewRow[] {
	const setupStatus = draft.setup?.includeInTour
		? "Setup · included in tour/video"
		: "Setup · excluded preparation";
	return [
		...(draft.setup?.rows ?? []).map((row) => ({
			kind: "setup" as const,
			row,
			status: setupStatus,
		})),
		...draft.rows.map((row) => ({
			kind: "tutorial" as const,
			row,
			status: "Tutorial",
		})),
	];
}

/** Effective page inherited before an editor row begins. */
export function editorInheritedPageUrl(
	draft: Draft,
	startUrl: string,
	index: number,
): string {
	const rows = editorReviewRows(draft);
	const current = rows[index];
	const firstTutorial = draft.setup?.rows.length ?? 0;
	const lowerBound =
		current?.kind === "tutorial" && draft.setup?.includeInTour === false
			? firstTutorial
			: 0;
	for (let i = index - 1; i >= lowerBound; i--) {
		const navigate = rows[i]?.row.navigate.trim();
		if (navigate) return navigate;
	}
	return startUrl;
}

/** Effective page on which an editor row will execute. */
export function editorPageUrl(
	draft: Draft,
	startUrl: string,
	index: number,
): string {
	const row = editorReviewRows(draft)[index]?.row;
	return row?.navigate.trim() || editorInheritedPageUrl(draft, startUrl, index);
}

/** One draft row's fields mapped onto a runnable step — shared by tutorial and setup rows. */
export function draftRowToStep(r: DraftStep): TourStep {
	const step: TourStep = { body: r.body.trim() };
	if (r.title.trim()) step.title = r.title.trim();
	if (r.selector.trim()) step.selector = r.selector.trim();
	if (r.navigate.trim()) step.navigate = r.navigate.trim();
	if (r.actKind === "click") step.action = { do: "click" };
	else if (r.actKind === "fill") step.action = { do: "fill", value: r.actText };
	const adv = parseAdvance(r.timing);
	if (adv !== undefined) step.advance = adv;
	return step;
}

/** Serialize the panel's draft back into a clean, runnable TourScript. */
export function draftToScript(startUrl: string, draft: Draft): TourScript {
	const out: TourScript = {
		startUrl,
		steps: draft.rows.map(draftRowToStep),
		mode: draft.mode,
	};
	if (draft.setup?.rows.length) {
		out.setup = {
			includeInTour: draft.setup.includeInTour,
			steps: draft.setup.rows.map(draftRowToStep),
		};
	}
	if (draft.title.trim()) out.title = draft.title.trim();
	return out;
}

/** One runnable step mapped onto the panel's editable draft-row fields (inverse of draftRowToStep). */
function stepToDraftRow(s: TourStep): DraftStep {
	return {
		title: s.title ?? "",
		selector: s.selector ?? "",
		body: s.body ?? "",
		timing: formatAdvance(s.advance),
		navigate: s.navigate ?? "",
		actKind: s.action?.do ?? "",
		actText: s.action?.do === "fill" ? s.action.value : "",
	};
}

/** Deserialize a runnable TourScript into the panel's editable draft (inverse of draftToScript). */
export function scriptToDraft(script: TourScript): Draft {
	return {
		title: script.title ?? "",
		mode: script.mode ?? "walkthrough",
		rows: (script.steps ?? []).map(stepToDraftRow),
		...(script.setup
			? {
					setup: {
						includeInTour: script.setup.includeInTour,
						rows: script.setup.steps.map(stepToDraftRow),
					},
				}
			: {}),
	};
}

/** Editor navigation state: a step being reviewed, or the final actions screen. */
export type EditPhase = { kind: "step"; cursor: number } | { kind: "done" };
export type EditEvent = "next" | "back" | "approve" | "editAgain";

/**
 * The review stepper as a generator state machine: it yields the current phase and
 * resumes on each `.next(event)`, applying the transition. All navigation lives here
 * so the flow reads top-to-bottom and is unit-testable without any DOM. Prime with a
 * bare `.next()`, then drive it with events.
 *
 * It primes on the actions screen, not step 0: the plan is usually right, and walking
 * every step to reach play/record made the common case the slowest path. `editAgain`
 * opens the stepper at the first step for anyone who does want to read it through.
 */
export function* editMachine(
	total: number,
): Generator<EditPhase, never, EditEvent> {
	let cursor = 0;
	let done = true;
	while (true) {
		const event = yield done ? { kind: "done" } : { kind: "step", cursor };
		if (event === "approve") done = true;
		else if (event === "editAgain") {
			done = false;
			cursor = 0;
		} else if (!done && event === "next" && cursor < total - 1) cursor++;
		else if (!done && event === "back" && cursor > 0) cursor--;
	}
}
