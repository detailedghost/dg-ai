import { type NavigationRequest, VERBS, validate } from "@dg/common/pw-ext-verbs/navigation";
import { parseTabId } from "./tab-id";

export { VERBS };

export class NavigationUsageError extends Error {}

export function isNavigationVerb(verb: string | undefined): verb is NavigationRequest["verb"] {
	return (VERBS as readonly (string | undefined)[]).includes(verb);
}

/** Builds the request for `dg pw --ext <verb> [--tab <id>]`; `args` are the positionals after the verb. */
export function buildRequest(verb: string | undefined, args: readonly string[], tab?: string): NavigationRequest {
	if (!isNavigationVerb(verb))
		throw new NavigationUsageError(`Unknown pw --ext verb: ${verb ?? "(none)"}. Use one of: ${VERBS.join(", ")}.`);
	if (args.length > 0) throw new NavigationUsageError(`pw --ext ${verb} takes no arguments; use --tab <id> to pick a tab.`);
	if (tab === undefined) return validate({ verb });
	const tabId = parseTabId(tab);
	if (tabId === undefined) throw new NavigationUsageError("pw --ext --tab takes a tab id from pw --ext tabs.");
	return validate({ verb, tabId });
}
