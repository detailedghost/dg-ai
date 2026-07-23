// Types now live in @dg/common — re-exported here for backwards compatibility
// with existing internal imports (e.g. `import type { TourScript } from "@/lib/demo-types"`).
export type {
	StepAction,
	StepAdvance,
	TourMode,
	TourScript,
	TourStep,
} from "@dg/common";
