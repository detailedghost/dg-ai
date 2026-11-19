import { die } from "../spec/shared";

const NAMES = ["eli5", "high-school", "college", "phd", "technical"] as const;

export type Level = (typeof NAMES)[number];

export const LEVELS: readonly string[] = NAMES;

const GRADE_LIMITS: Record<Level, number | null> = {
	eli5: 4,
	"high-school": 10,
	college: 14,
	phd: null,
	technical: null,
};

export const DEFAULT_LEVEL: Level = "high-school";

export function gradeLimit(level: Level): number | null {
	return GRADE_LIMITS[level];
}

export function isLevel(text: string): text is Level {
	return LEVELS.includes(text);
}

export function parseLevel(text: string): Level {
	if (!isLevel(text)) die(`invalid level "${text}". Allowed: ${LEVELS.join(", ")}`);
	return text;
}
