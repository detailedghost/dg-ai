import { parseTabId } from "./tab-id";
import {
	storageActionOf,
	type StorageRequest,
	type StorageVerb,
	validate,
} from "@dg/common/pw-ext-verbs/storage";

export class StorageUsageError extends Error {}

export const STORAGE_USAGE = [
	"  localstorage-set <key> <value>      set one localStorage key on an allowed site",
	"  localstorage-delete <key>           delete one localStorage key",
	"  localstorage-clear                  clear localStorage",
	"  sessionstorage-set <key> <value>    set one sessionStorage key",
	"  sessionstorage-delete <key>         delete one sessionStorage key",
	"  sessionstorage-clear                clear sessionStorage",
].join("\n");

const ARGUMENTS = { set: "<key> <value>", delete: "<key>", clear: "" } as const;

export function storageRequestOf(verb: StorageVerb, args: readonly string[], tab?: string): StorageRequest {
	const action = storageActionOf(verb);
	const expected = ARGUMENTS[action];
	const count = expected === "" ? 0 : expected.split(" ").length;
	if (args.length !== count)
		throw new StorageUsageError(
			`pw --ext ${verb} takes ${expected === "" ? "no arguments" : expected}.`,
		);
	const tabId = tab === undefined ? undefined : parseTabId(tab);
	if (tab !== undefined && tabId === undefined)
		throw new StorageUsageError("pw --ext --tab takes a tab id from pw --ext tabs.");
	const request: Record<string, unknown> = { verb };
	if (action !== "clear") request.key = args[0];
	if (action === "set") request.value = args[1];
	if (tabId !== undefined) request.tabId = tabId;
	try {
		return validate(request);
	} catch (error) {
		throw new StorageUsageError(error instanceof Error ? error.message : String(error));
	}
}
