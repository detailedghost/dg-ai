import { PW_EXT_MAX_TAB_ID } from "@dg/common";

export function parseTabId(value: string): number | undefined {
	return /^\d+$/.test(value) && Number(value) <= PW_EXT_MAX_TAB_ID ? Number(value) : undefined;
}
