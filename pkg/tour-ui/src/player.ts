import {
	partitionTourSteps,
	type TourMode,
	type TourScript,
	type TourStep,
	wait,
} from "@dg/common";
import { showEditPanel } from "./editor";
import {
	advanceClickNeeded,
	automaticPlayback,
	expectedUrl,
	initialPlayState,
	isSetup,
	isVideo,
	type NarrationOutcome,
	type PlayState,
	recordingStartState,
	restartState,
	runVideoStepSequence,
	sameOrigin,
	sameUrl,
	stateSteps,
} from "./engine";
import { type TourHost, tourKeys } from "./host";
import {
	automaticActionConsentGranted,
	handoffCompletedSetup,
	maybePerformAction,
	maybePerformStepEffect,
	primeClickNavigation,
} from "./lifecycle";
import { showActionConsent, showModal, showTourEnd } from "./modals";
import { renderStep, type StepControls } from "./overlay";
import { safeQuerySelector } from "./picker";
import {
	type StartChoice,
	type StartSettings,
	showStartScreen,
} from "./start-screen";
import { holdFor } from "./video-timing";

export type TourResult = {
	outcome: "done" | "stopped" | "error";
	mode: TourMode;
	steps: number;
	error?: string;
};

export type TourOptions = {
	mode?: TourMode;
	/** With `mode`, the narration to use in place of the start screen's choice. */
	narration?: StartSettings;
	autopilot?: boolean;
	/** The host cannot record, so the start screen leaves out Record video. */
	noVideo?: boolean;
	/** Aborting detaches the run: its UI goes away and stored state is left as is. */
	signal?: AbortSignal;
	/** Called each time the run waits on the viewer, the recorder or a page load. */
	onIdle?: () => void;
	/** Called each time a step is on screen, with its index and a way to move past it. */
	onStep?: (index: number, next: () => void) => void;
};

type Command =
	| { kind: "next"; target: HTMLElement | null; fromControl: boolean }
	| { kind: "back" | "restart" | "last" | "end" | "halt" };

const JUMP_STEP_MS = 350;
const AUTOPILOT_STEP_MS = 350;
const HALT = Symbol("halt");

type Halt = { promise: Promise<typeof HALT>; signal: AbortSignal };

function haltOn(signal: AbortSignal | undefined): Halt {
	const live = signal ?? new AbortController().signal;
	const promise = new Promise<typeof HALT>((resolve) => {
		if (live.aborted) resolve(HALT);
		else live.addEventListener("abort", () => resolve(HALT), { once: true });
	});
	return { promise, signal: live };
}

const modeOf = (state: PlayState): TourMode =>
	state.script.mode ?? "walkthrough";

function withChoice(script: TourScript, choice: StartChoice): TourScript {
	return {
		...script,
		mode: choice.mode === "video" ? "video" : "walkthrough",
		...(script.setup
			? { setup: { ...script.setup, includeInTour: choice.includeSetup } }
			: {}),
	};
}

function controlsFor(push: (command: Command) => void): StepControls {
	return {
		end: () => push({ kind: "end" }),
		restart: () => push({ kind: "restart" }),
		back: () => push({ kind: "back" }),
		next: (target) => push({ kind: "next", target, fromControl: true }),
		last: () => push({ kind: "last" }),
	};
}

type Voicing = Pick<PlayState, "videoDurations" | "videoHideBody">;

async function voicing(
	host: TourHost,
	play: TourScript,
	settings: StartSettings,
	answer: unknown,
): Promise<Voicing> {
	if (answer !== "voice" || !host.narrator || play.mode !== "video") return {};
	const modal = await showModal(host, {
		title: "Preparing narration",
		body: "Loading the local voice model. The first run downloads about 86 MB.",
		progress: 0,
		progressLabel: "Loading local voice model",
	});
	try {
		const videoDurations = await host.narrator.prepare(
			partitionTourSteps(play).tutorial,
			settings.voice,
			modal.update,
		);
		return {
			videoDurations,
			...(settings.narration === "voice" ? { videoHideBody: true } : {}),
		};
	} catch (error) {
		console.warn("narration failed; recording without voice", error);
		void host.messages.send({
			kind: "narration-failed",
			reason: error instanceof Error ? error.message : String(error),
		});
		return {};
	} finally {
		modal.remove();
	}
}

async function chooseState(
	host: TourHost,
	script: TourScript,
	opts: TourOptions,
): Promise<PlayState | null> {
	const keys = tourKeys(host);
	const saved = await host.storage.get<PlayState>(keys.state);
	if (saved) return saved;

	const begin = async (
		play: TourScript,
		voiced: Voicing = {},
	): Promise<PlayState> => {
		const state = { ...initialPlayState(play, "marker"), ...voiced };
		await host.storage.set(keys.state, state);
		await host.storage.remove(keys.recording);
		return state;
	};
	const announce = (
		play: TourScript,
		settings: StartSettings,
	): Promise<unknown> =>
		host.messages.send({
			kind: "choice",
			mode: play.mode ?? "walkthrough",
			narration: settings.narration,
			voice: settings.voice,
			includeSetup: play.setup?.includeInTour ?? false,
		});
	if (opts.mode) {
		const play = { ...script, mode: opts.mode };
		if (!opts.narration) return begin(play);
		const answer = await announce(play, opts.narration);
		return begin(play, await voicing(host, play, opts.narration, answer));
	}

	const choice = await showStartScreen(host, script, { noVideo: opts.noVideo });
	const settings: StartSettings = {
		narration: choice.narration,
		voice: choice.voice,
	};
	if (choice.mode !== "review") {
		const play = withChoice(script, choice);
		const answer = await announce(play, settings);
		return begin(play, await voicing(host, play, settings, answer));
	}

	return new Promise<PlayState | null>((resolve, reject) => {
		showEditPanel(host, script, {
			...settings,
			noVideo: opts.noVideo,
			onSetting: (patch) => Object.assign(settings, patch),
			onDismiss: () => resolve(null),
			onError: reject,
			start: async (reviewed) => {
				try {
					const answer = await announce(reviewed, settings);
					const voiced = await voicing(host, reviewed, settings, answer);
					const written = await host.storage.get<PlayState>(keys.state);
					if (!written) return resolve(await begin(reviewed, voiced));
					const merged = { ...written, ...voiced };
					await host.storage.set(keys.state, merged);
					resolve(merged);
				} catch (error) {
					reject(error);
				}
			},
		}).catch(reject);
	});
}

export async function runTour(
	host: TourHost,
	script: TourScript,
	opts: TourOptions = {},
): Promise<TourResult> {
	let state: PlayState | undefined;
	try {
		const chosen = await chooseState(host, script, opts);
		if (!chosen)
			return {
				outcome: "stopped",
				mode: script.mode ?? "walkthrough",
				steps: script.steps.length,
			};
		state = chosen;
		return await play(host, chosen, opts, (latest) => {
			state = latest;
		});
	} catch (error) {
		if (opts.signal?.aborted)
			return {
				outcome: "stopped",
				mode: state ? modeOf(state) : (opts.mode ?? script.mode ?? "walkthrough"),
				steps: state ? stateSteps(state).length : script.steps.length,
			};
		const keys = tourKeys(host);
		await Promise.allSettled([
			host.storage.remove(keys.state),
			host.storage.remove(keys.recording),
		]);
		return {
			outcome: "error",
			mode: state ? modeOf(state) : (opts.mode ?? script.mode ?? "walkthrough"),
			steps: state ? stateSteps(state).length : script.steps.length,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function waitForNarration(
	host: TourHost,
	index: number,
	timeoutMs: number,
	signal: AbortSignal,
	clipMs?: number,
): Promise<NarrationOutcome> {
	if (signal.aborted) return Promise.resolve("cancelled");
	return new Promise((resolve) => {
		const settle = (outcome: NarrationOutcome): void => {
			clearTimeout(timer);
			clearTimeout(clipTimer);
			off();
			signal.removeEventListener("abort", onAbort);
			resolve(outcome);
		};
		const onAbort = (): void => settle("cancelled");
		const off = host.messages.on((msg) => {
			if (
				msg.kind === "narration-complete" &&
				(msg.index === undefined || msg.index === index)
			)
				settle("ended");
		});
		const timer = setTimeout(() => settle("timeout"), timeoutMs);
		const clipTimer =
			clipMs !== undefined && clipMs < timeoutMs
				? setTimeout(() => settle("ended"), clipMs)
				: undefined;
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function play(
	host: TourHost,
	initial: PlayState,
	opts: TourOptions,
	track: (state: PlayState) => void,
): Promise<TourResult> {
	const keys = tourKeys(host);
	const halt = haltOn(opts.signal);
	let state = initial;
	const result = (outcome: "done" | "stopped"): TourResult => ({
		outcome,
		mode: modeOf(state),
		steps: stateSteps(state).length,
	});
	const save = async (next: PlayState): Promise<void> => {
		state = next;
		track(next);
		await host.storage.set(keys.state, next);
	};
	const reload = async (): Promise<void> => {
		state = (await host.storage.get<PlayState>(keys.state)) ?? state;
		track(state);
	};
	const clear = async (): Promise<void> => {
		await host.storage.remove(keys.state);
		await host.storage.remove(keys.recording);
	};
	const idle = (): void => opts.onIdle?.();
	const park = async (): Promise<TourResult> => {
		idle();
		await halt.promise;
		return result("stopped");
	};
	const stop = async (): Promise<TourResult> => {
		await clear();
		if (state.fromEdit && host.openEditor) await host.openEditor(state.script);
		return result("stopped");
	};
	const until = <T>(promise: Promise<T>): Promise<T | typeof HALT> =>
		Promise.race([promise, halt.promise]);

	const restart = async (): Promise<TourResult> => {
		await save(restartState(state));
		await host.storage.remove(keys.recording);
		const startUrl = state.script.startUrl;
		if (sameUrl(location.href, startUrl, location.href))
			location.reload();
		else location.href = startUrl;
		return park();
	};

	const complete = async (): Promise<TourResult> => {
		if (isVideo(state.script) && host.recorder) {
			await host.recorder.wrapUp();
			await host.messages.send({ kind: "done" });
			return result("done");
		}
		if (!isVideo(state.script) && host.endScreen) {
			const end = await showTourEnd(
				host,
				state,
				state.fromEdit === true && host.openEditor !== undefined,
			);
			idle();
			const choice = await until(end.choice);
			end.ui.remove();
			if (choice === HALT) return result("stopped");
			if (choice === "restart") return restart();
			await host.storage.remove(keys.state);
			if (choice === "editor") await host.openEditor?.(state.script);
			return result("done");
		}
		await clear();
		return result("done");
	};

	const advanceEffect = async (
		at: PlayState,
		step: TourStep,
		target: HTMLElement | null,
		fromControl: boolean,
	): Promise<void> => {
		if (!target) return;
		await primeClickNavigation(at, step, save);
		if (step.action) await maybePerformAction(host, at, step, target);
		else if (advanceClickNeeded(step, true, fromControl)) target.click();
	};

	const runToLast = async (at: PlayState): Promise<void> => {
		const steps = stateSteps(at);
		const last = steps.length - 1;
		for (let i = at.index; i < last; i++) {
			const step = steps[i];
			if (!step) break;
			const el = step.selector
				? safeQuerySelector<HTMLElement>(document, step.selector)
				: null;
			if (el) {
				const here = { ...at, index: i };
				if (step.action) await maybePerformAction(host, here, step, el);
				else if (advanceClickNeeded(step, true, true)) el.click();
			}
			await reload();
			await save({ ...state, index: i + 1 });
			await wait(JUMP_STEP_MS);
		}
		await reload();
		await save({ ...state, index: last });
	};

	const runVideoStep = async (
		at: PlayState,
		step: TourStep,
		target: HTMLElement | null,
		signal: AbortSignal,
	): Promise<void> => {
		const effectAlreadyRan = (at.acted ?? -1) >= at.index;
		const narration = effectAlreadyRan
			? Promise.resolve<NarrationOutcome>("ended")
			: waitForNarration(
					host,
					at.index,
					at.videoDurations?.[at.index] ?? holdFor(step, null),
					signal,
					host.narrator?.clipMs?.(at.index),
				);
		if (!effectAlreadyRan)
			void host.messages.send({ kind: "progress", index: at.index });
		await runVideoStepSequence(step, {
			waitForNarration: () => narration,
			performEffect: async () => {
				if (effectAlreadyRan || !target) return;
				await primeClickNavigation(at, step, save);
				await maybePerformStepEffect(host, at, step, target);
			},
			pause: wait,
			advance: async () => {},
			cancelled: () => signal.aborted,
		});
	};

	const showStep = async (at: PlayState, step: TourStep): Promise<Command> => {
		let videoActive = false;
		let push!: (command: Command) => void;
		const pending = new Promise<Command>((resolve) => {
			push = (command) => {
				if (videoActive && command.kind !== "end" && command.kind !== "halt")
					return;
				resolve(command);
			};
		});
		void halt.promise.then(() => push({ kind: "halt" }));
		const view = await renderStep(host, at, step, controlsFor(push));
		opts.onStep?.(at.index, () =>
			push({ kind: "next", target: view.target, fromControl: true }),
		);
		const cleanups: Array<() => void> = [view.remove];
		try {
			if (halt.signal.aborted) return { kind: "halt" };
			idle();
			if (view.video) {
				videoActive = true;
				cleanups.push(
					host.messages.on((msg) => {
						if (msg.kind === "stopped") push({ kind: "end" });
					}),
				);
				const controller = new AbortController();
				const sequence = runVideoStep(
					at,
					step,
					view.target,
					controller.signal,
				).then(
					(): Command => ({ kind: "next", target: null, fromControl: false }),
				);
				const command = await Promise.race([sequence, pending]);
				if (command.kind === "end" || command.kind === "halt")
					controller.abort();
				return command;
			}
			const target = view.target;
			if (step.advance === "click" && target) {
				const onClick = (): void =>
					push({ kind: "next", target, fromControl: false });
				target.addEventListener("click", onClick, { once: true });
				cleanups.push(() => target.removeEventListener("click", onClick));
			}
			if (opts.autopilot) {
				const timer = setTimeout(
					() => push({ kind: "next", target, fromControl: true }),
					AUTOPILOT_STEP_MS,
				);
				cleanups.push(() => clearTimeout(timer));
			}
			const command = await pending;
			if (command.kind === "next")
				await advanceEffect(at, step, command.target, command.fromControl);
			else if (command.kind === "last") await runToLast(at);
			return command;
		} finally {
			for (const cleanup of cleanups) cleanup();
		}
	};

	if (host.actionConsent && !automaticActionConsentGranted(state)) {
		const consent = await showActionConsent(host, state);
		idle();
		const approved = await until(consent.answer);
		consent.ui.remove();
		if (approved === HALT) return result("stopped");
		if (!approved) return stop();
		await save({ ...state, automaticActionsApproved: true });
	}

	for (;;) {
		if (halt.signal.aborted) return result("stopped");
		const steps = stateSteps(state);
		const step = steps[state.index];
		if (!step) {
			if (!isSetup(state)) return complete();
			const handoff = await handoffCompletedSetup(state, location.href, {
				writeState: save,
				navigate: (url) => {
					location.href = url;
				},
				continuePlayback: async () => {},
				abortPlayback: async () => {},
			});
			if (handoff === "abort") return stop();
			if (handoff === "navigate") return park();
			continue;
		}

		const here = location.href;
		const want = expectedUrl(steps, state.script.startUrl, state.index);
		if (!sameUrl(here, want, here)) {
			if (!sameOrigin(want, state.script.startUrl, here)) return stop();
			location.href = new URL(want, here).href;
			return park();
		}

		if (
			host.recorder &&
			automaticPlayback(state) &&
			(await host.storage.get<boolean>(keys.recording)) !== true
		) {
			const capture = host.recorder.capture(halt.signal);
			idle();
			const start = await until(capture);
			if (start === HALT) return result("stopped");
			await host.storage.set(keys.recording, true);
			await save(
				recordingStartState({
					...state,
					videoDurations: start.durations,
					videoHideBody: start.hideBody,
				}),
			);
			continue;
		}

		const at = state;
		const command = await showStep(at, step);
		if (command.kind === "halt") return result("stopped");
		if (command.kind === "end") return stop();
		if (command.kind === "back")
			await save({ ...state, index: Math.max(0, at.index - 1) });
		else if (command.kind === "next") {
			await reload();
			await save({ ...state, index: at.index + 1 });
		} else if (command.kind === "restart") return restart();
	}
}
