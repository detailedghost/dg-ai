/** "next" = Next button (default); "click" = wait for the target; number = auto-advance after N ms. */
export type StepAdvance = "next" | "click" | number;

/** An action the tour performs on the step's target: click it, or type text into it. */
export type StepAction = { do: "click" } | { do: "fill"; value: string };

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

/** Optional preparation that runs before the tutorial. It may be included in it. */
export type TourSetup = {
	steps: TourStep[];
	includeInTour: boolean;
};

export type TourScript = {
	title?: string;
	startUrl: string;
	steps: TourStep[];
	mode?: TourMode;
	setup?: TourSetup;
};

/** Bounded snapshot of a live page's visual tokens and representative controls. */
export type StyleGuide = {
	meta: {
		url: string;
		scrapedAt: number;
		sameOrigin: boolean;
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
	};
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

/** User's explicit approval or feedback-bearing rejection of a variation. */
export type Verdict =
	| {
			slug: string;
			action: "approve";
			selectedKey: string;
			ts: number;
	  }
	| {
			slug: string;
			action: "reject";
			selectedKey: string;
			feedback: string;
			ts: number;
	  };

/** Provenance rendered into an exported, self-contained prototype answer. */
export type AnswerPageMeta = {
	url?: string;
	scrapedAt: number;
	question?: string;
};
