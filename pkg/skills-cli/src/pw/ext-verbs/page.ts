import { parseTabId } from "./tab-id";
import { type PageRequest, type PageVerb, RESIZE_MAX, RESIZE_MIN, validate, VERBS } from "@dg/common/pw-ext-verbs/page";

export { VERBS };

export class PageUsageError extends Error {}

export const PAGE_USAGE = [
	"  eval <expression>                   run JavaScript in the agent tab on an allowed site",
	"  tab-select <tabId>                  make one of the agent's tabs the selected tab",
	"  resize <width> <height>             resize the agent window",
].join("\n");

const ARGUMENTS = { eval: "<expression>", "tab-select": "<tabId>", resize: "<width> <height>" } as const satisfies Record<PageVerb, string>;

export function isPageVerb(verb: string | undefined): verb is PageVerb {
	return (VERBS as readonly (string | undefined)[]).includes(verb);
}

const parseNumber = (text: string | undefined): number => (text !== undefined && /^\d{1,10}$/.test(text) ? Number(text) : Number.NaN);

/** Builds the request for `dg pw --ext <verb>`; `args` are the positionals after the verb. */
export function pageRequestOf(verb: string | undefined, args: readonly string[], tab?: string): PageRequest {
	if (!isPageVerb(verb))
		throw new PageUsageError(`Unknown pw --ext verb: ${verb ?? "(none)"}. Use one of: ${VERBS.join(", ")}.`);
	const expected = ARGUMENTS[verb];
	if (args.length !== expected.split(" ").length) throw new PageUsageError(`pw --ext ${verb} takes ${expected}.`);
	if (verb === "tab-select" && tab !== undefined)
		throw new PageUsageError("pw --ext tab-select takes the tab id as its argument, not --tab.");
	const picked = tab === undefined ? undefined : parseTabId(tab);
	if (tab !== undefined && picked === undefined)
		throw new PageUsageError("pw --ext --tab takes a tab id from pw --ext tabs.");
	const tabId = picked === undefined ? {} : { tabId: picked };
	let request: Record<string, unknown>;
	if (verb === "eval") request = { verb, expression: args[0], ...tabId };
	else if (verb === "tab-select") {
		const selected = parseTabId(args[0] as string);
		if (selected === undefined) throw new PageUsageError("pw --ext tab-select takes a tab id from pw --ext tabs.");
		request = { verb, tabId: selected };
	} else {
		const [width, height] = [parseNumber(args[0]), parseNumber(args[1])];
		if (Number.isNaN(width) || Number.isNaN(height))
			throw new PageUsageError("pw --ext resize takes a whole number for width and height.");
		if (width < RESIZE_MIN || width > RESIZE_MAX || height < RESIZE_MIN || height > RESIZE_MAX)
			throw new PageUsageError(`pw --ext resize takes sizes between ${RESIZE_MIN} and ${RESIZE_MAX}.`);
		request = { verb, width, height, ...tabId };
	}
	try {
		return validate(request);
	} catch (error) {
		throw new PageUsageError(error instanceof Error ? error.message : String(error));
	}
}
