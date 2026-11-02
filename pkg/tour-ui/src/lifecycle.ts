import {
	type StepAction,
	type TourScript,
	type TourStep,
	tourHasAutomaticActions,
} from "@dg/common";
import {
	completeSetupPhase,
	expectedUrl,
	initialPlayState,
	isVideo,
	type PlayState,
	type PlayStateWriter,
	performAction,
	sameOrigin,
	sameUrl,
	stateSteps,
	stepEffect,
} from "./engine";
import { type TourHost, tourKeys } from "./host";

/** Persist the untrusted-marker lifecycle state. */
export async function initializeMarkerPlayback(
	script: TourScript,
	writeState: PlayStateWriter,
): Promise<PlayState> {
	const state = initialPlayState(script, "marker");
	await writeState(state);
	return state;
}

/** Persist the explicitly reviewed lifecycle state used by editor playback. */
export async function initializeReviewedEditorPlayback(
	script: TourScript,
	writeState: PlayStateWriter,
): Promise<PlayState> {
	const state = initialPlayState(script, "reviewed-editor");
	await writeState(state);
	return state;
}

/** Setup actions are inert until the user explicitly approves them on-page. */
export function setupActionConsentRequired(script: TourScript): boolean {
	return script.setup?.steps.some((step) => step.action != null) === true;
}

/** Marker-authored click/fill actions require one explicit playback approval. */
export function automaticActionConsentRequired(script: TourScript): boolean {
	return tourHasAutomaticActions(script);
}

/** Whether persisted approval covers every automatic action in this script. */
export function automaticActionConsentGranted(state: PlayState): boolean {
	if (!automaticActionConsentRequired(state.script)) return true;
	if (state.automaticActionsApproved === true) return true;
	return (
		!state.script.steps.some((step) => step.action != null) &&
		state.setupActionsApproved === true
	);
}

/** Side-effect boundary used while handing excluded setup to the tutorial. */
export type SetupHandoffDeps = {
	writeState: (state: PlayState) => Promise<void>;
	navigate: (url: string) => void;
	continuePlayback: () => Promise<void>;
	abortPlayback: () => Promise<void>;
};

/**
 * Persist setup completion, then put excluded video tours on the first tutorial
 * page before allowing the recording prompt to appear.
 */
export async function handoffCompletedSetup(
	state: PlayState,
	currentUrl: string,
	deps: SetupHandoffDeps,
): Promise<"navigate" | "continue" | "abort"> {
	const completed = completeSetupPhase(state);
	await deps.writeState(completed);
	if (!isVideo(state.script)) {
		await deps.continuePlayback();
		return "continue";
	}
	const want = expectedUrl(
		stateSteps(completed),
		state.script.startUrl,
		completed.index,
	);
	if (sameUrl(currentUrl, want, currentUrl)) {
		await deps.continuePlayback();
		return "continue";
	}
	if (!sameOrigin(want, state.script.startUrl, currentUrl)) {
		await deps.abortPlayback();
		return "abort";
	}
	deps.navigate(new URL(want, currentUrl).href);
	return "navigate";
}

/** Persist the destination before a click can unload the current document. */
export async function primeClickNavigation(
	state: PlayState,
	step: TourStep,
	writeState: PlayStateWriter,
): Promise<void> {
	if (stepEffect(step)?.do === "click")
		await writeState({ ...state, index: state.index + 1 });
}

const performing = new Set<string>();

async function performOnce(
	host: TourHost,
	state: PlayState,
	action: StepAction,
	target: HTMLElement,
): Promise<void> {
	const key = tourKeys(host).state;
	const slot = `${key}#${state.index}`;
	if ((state.acted ?? -1) >= state.index || performing.has(slot)) return;
	performing.add(slot);
	try {
		await performAction(action, target);
		const latest = (await host.storage.get<PlayState>(key)) ?? state;
		await host.storage.set(key, {
			...latest,
			acted: Math.max(latest.acted ?? -1, state.index),
		});
	} finally {
		performing.delete(slot);
	}
}

/** Run a step's authored action once; click timings are ignored. */
export async function maybePerformAction(
	host: TourHost,
	state: PlayState,
	step: TourStep,
	target: HTMLElement,
): Promise<void> {
	if (step.action) await performOnce(host, state, step.action, target);
}

/** Run whatever the step does to the page, including a click-timed step's click. */
export async function maybePerformStepEffect(
	host: TourHost,
	state: PlayState,
	step: TourStep,
	target: HTMLElement,
): Promise<void> {
	const action = stepEffect(step);
	if (action) await performOnce(host, state, action, target);
}
