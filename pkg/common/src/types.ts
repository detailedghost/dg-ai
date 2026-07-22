/** "next" = Next button (default); "click" = wait for the target; number = auto-advance after N ms. */
export type StepAdvance = "next" | "click" | number;

export type TourStep = {
	/** CSS selector to spotlight; omit for a centered modal. */
	selector?: string;
	title?: string;
	/** Explanatory text shown in the callout. */
	body: string;
	advance?: StepAdvance;
	/** Navigate here when the step begins (multi-page tours). */
	navigate?: string;
};

/** "walkthrough" = user-paced live tour; "video" = auto-play + record to webm. */
export type TourMode = "walkthrough" | "video";

export type TourScript = {
	title?: string;
	startUrl: string;
	steps: TourStep[];
	mode?: TourMode;
};
