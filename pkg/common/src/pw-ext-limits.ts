import { fail } from "./assert";

export const PW_EXT_MAX_TARGET_BYTES = 512;
export const PW_EXT_MAX_VALUE_BYTES = 4096;
export const PW_EXT_MAX_KEY_CHARS = 512;
export const PW_EXT_MAX_TAB_ID = 2_147_483_647;

export type PwExtTool = {
	name: string;
	title?: string;
	description: string;
	inputSchema?: string;
	annotations?: string;
};

/** Redacted, size-capped output; image is a screenshot data URL; tools is the structured list of the tools verb. */
export type PwExtResponse = { text: string; image?: string; tools?: PwExtTool[] };

export function requireTabId(value: unknown, path: string): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > PW_EXT_MAX_TAB_ID)
		fail(`${path}.tabId must be a non-negative integer`);
}
