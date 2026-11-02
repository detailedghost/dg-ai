import type { TourMode, TourScript, TourStep } from "@dg/common";
import type { NarrationMode } from "./narration-options";

export type TourMessage =
	| {
			kind: "choice";
			mode: TourMode;
			narration: NarrationMode;
			voice: string;
			includeSetup: boolean;
	  }
	| { kind: "progress"; index: number }
	| { kind: "narration-complete"; index?: number; ms?: number }
	| { kind: "download-plan"; markdown: string }
	| { kind: "clip"; index: number; sampleRate: number; pcm: string }
	| { kind: "narration-failed"; reason: string }
	| { kind: "done" | "stopped" }
	| { kind: "error"; message: string };

export type TourHost = {
	storage: {
		get<T>(key: string): Promise<T | undefined>;
		set(key: string, value: unknown): Promise<void>;
		remove(key: string): Promise<void>;
	};
	messages: {
		send(msg: TourMessage): Promise<unknown>;
		on(handler: (msg: TourMessage) => void): () => void;
	};
	mountUi(
		name: string,
		onMount: (root: HTMLElement) => void,
	): Promise<{ remove(): void }>;
	tabKey(): string;
	openExternal?(url: string): void;
	/** Gate marker-authored click and fill actions behind an on-page approval. */
	actionConsent?: boolean;
	/** Show a restart/close card when a walkthrough ends instead of clearing at once. */
	endScreen?: boolean;
	/** A recorder drives video tours: capture starts on its gesture, not at once. */
	recorder?: TourRecorder;
	/** Speaks narration into clips the host saves, for hosts with no tab-audio recorder. */
	narrator?: TourNarrator;
	/** Reopen the review editor when a tour launched from it ends. */
	openEditor?(script: TourScript): Promise<void>;
};

export type TourNarrator = {
	/** Synthesizes the clips, sends each to the host, and resolves with every step's hold in ms. */
	prepare(
		steps: TourStep[],
		voice: string,
		report: (percent: number, label: string) => void,
	): Promise<number[]>;
};

export type CaptureStart = { durations: number[]; hideBody: boolean };

export type TourRecorder = {
	/** Prompts for the record gesture and resolves once capture starts. */
	capture(signal: AbortSignal): Promise<CaptureStart>;
	/** Shows the wrap-up notice; the host keeps the tour state until the save lands. */
	wrapUp(): Promise<void>;
};

export type TourKeys = {
	state: string;
	recording: string;
	edit: string;
	pending: string;
};

export function tourKeys(host: TourHost): TourKeys {
	const tab = host.tabKey();
	return {
		state: `demo_tour:${tab}`,
		recording: `demo_recording:${tab}`,
		edit: `demo_edit:${tab}`,
		pending: `demo_pending:${tab}`,
	};
}
