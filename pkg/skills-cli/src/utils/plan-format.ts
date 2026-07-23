// Serialization + validation are re-exported from @dg/common (pure, dependency-free).
// The markdown reader lives CLI-side in ./plan-parse (it pulls in `marked`).
export {
	extractScriptFromMarkdown,
	type StepAdvance,
	type TourMode,
	type TourScript,
	type TourStep,
	toPlanMarkdown,
	validate,
} from "@dg/common";
export { parsePlanMarkdown } from "./plan-parse";
