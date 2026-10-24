/** "next" = Next button (default); "click" = wait for the target; number = auto-advance after N ms. */
export type StepAdvance = "next" | "click" | number;

/** An action the tour performs on the step's target: click it, or type text into it. */
export type StepAction = { do: "click" } | { do: "fill"; value: string };

/** One authored spotlight, navigation, or action in setup or tutorial playback. */
export type TourStep = {
	/** CSS selector to spotlight; omit for a centered modal. */
	selector?: string;
	title?: string;
	/** Explanatory text shown in the callout. */
	body: string;
	advance?: StepAdvance;
	/** Navigate here when the step begins (multi-page tours). */
	navigate?: string;
	/** Perform this on the target when the step plays (click / type text). */
	action?: StepAction;
};

/** "walkthrough" = user-paced live tour; "video" = auto-play + record to webm. */
export type TourMode = "walkthrough" | "video";

/** Optional preparation, excluded by default or included as leading tutorial steps. */
export type TourSetup = {
	steps: TourStep[];
	includeInTour: boolean;
};

/** Durable guided-tour contract shared by the CLI and browser extension. */
export type TourScript = {
	title?: string;
	startUrl: string;
	steps: TourStep[];
	mode?: TourMode;
	setup?: TourSetup;
};

/** One representative form control, captured with its host classes so a planted variation can reuse them verbatim. */
export type StyleGuideControl = {
	tag: "input" | "select" | "textarea" | "button";
	type?: string;
	classes: string;
	wrapperClasses?: string;
};

/** Bounded snapshot of a live page's visual tokens and representative controls. */
export type StyleGuide = {
	meta: {
		url: string;
		scrapedAt: number;
		sameOrigin: boolean;
		colorScheme?: "light" | "dark";
	};
	tokens: {
		customProps: Record<string, string>;
		colors: string[];
		fontStack: string;
		typeScale: string[];
		spacing: string[];
		radii: string[];
		shadows: string[];
	};
	components: {
		button: Record<string, string>;
		input: Record<string, string>;
		link: Record<string, string>;
		select?: Record<string, string>;
		textarea?: Record<string, string>;
	};
	/** First ~32 form controls in document order, so a planted variation can reuse the host's exact classes. */
	controls?: StyleGuideControl[];
};

/** One self-contained HTML/CSS choice in a live-page prototype comparison. */
export type ProtoVariation = {
	key: string;
	label: string;
	html: string;
	css: string;
};

/** Validated comparison plan transported to the extension for live rendering. */
export type ProtoPlan = {
	slug: string;
	question?: string;
	mountSelector?: string;
	mode: "replace" | "takeover";
	variations: ProtoVariation[];
};

/**
 * Scrape or plant payload carried by the `_proto` URL marker. `expectedUrl` is
 * the URL the CLI asked the browser to open (before the marker was added), so
 * the content script can tell a same-fragment redirect from a clean landing.
 */
export type ProtoPayload =
	| { phase: "scrape"; slug: string; expectedUrl: string }
	| { phase: "plant"; slug: string; plan: ProtoPlan; expectedUrl: string };

/** User's approval, feedback-bearing rejection, or note-bearing tweak of a variation. */
export type Verdict =
	| {
			slug: string;
			action: "approve";
			selectedKey: string;
			notes?: string;
			ts: number;
	  }
	| {
			slug: string;
			action: "reject";
			selectedKey: string;
			feedback: string;
			ts: number;
	  }
	| {
			slug: string;
			action: "tweak";
			selectedKey: string;
			notes: string;
			ts: number;
	  };

/** Provenance rendered into an exported, self-contained prototype answer. */
export type AnswerPageMeta = {
	url?: string;
	scrapedAt: number;
	question?: string;
};

/** Reasons a `--ext` scrape or plant cannot proceed on the landed page. */
export type ProtoNotReadyCode =
	| "login-page"
	| "redirected"
	| "http-error"
	| "mount-missing";

/** Typed, immediate failure the extension hands back instead of silently timing out. */
export type ProtoNotReadyError = {
	code: ProtoNotReadyCode;
	message: string;
	landedUrl: string;
};

/** What the extension hands back for one successful proto browser request. */
export type ProtoBrowserData =
	| { kind: "style-guide"; styleGuide: StyleGuide }
	| { kind: "verdict"; verdict: Verdict; previewDataUrl?: string };
