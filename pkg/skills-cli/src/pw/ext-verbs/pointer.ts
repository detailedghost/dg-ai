import { PW_EXT_MAX_TAB_ID } from "@dg/common";
import { type PointerRequest, POINTER_BUTTONS, validate, VERBS, type PointerVerb } from "../../../../common/src/pw-ext-verbs/pointer";

export class PointerUsageError extends Error {}

export { VERBS as POINTER_VERBS };

const USAGE: Record<PointerVerb, string> = {
	hover: "<ref|selector>",
	dblclick: "<ref|selector>",
	drag: "<from-ref|selector> <to-ref|selector>",
	mousemove: "<x> <y>",
	mousedown: `[${POINTER_BUTTONS.join("|")}]`,
	mouseup: `[${POINTER_BUTTONS.join("|")}]`,
	mousewheel: "<dx> <dy>",
};

export const POINTER_HELP = `  hover <ref|selector>    move the pointer over one element
  dblclick <ref|selector> double-click one element
  drag <from> <to>        press on one element, move to another, release
  mousemove <x> <y>       move the pointer to viewport coordinates
  mousedown [button]      press a mouse button at the pointer (left, middle or right)
  mouseup [button]        release a mouse button at the pointer
  mousewheel <dx> <dy>    scroll the wheel at the pointer`;

function number(text: string, name: string, verb: string): number {
	if (!/^-?\d+(\.\d+)?$/.test(text)) throw new PointerUsageError(`pw --ext ${verb}: ${name} must be a number.`);
	return Number(text);
}

/** Turns the words after a pointer verb into a validated request; `tab` is the --tab value. */
export function parsePointerRequest(verb: PointerVerb, args: readonly string[], tab?: number): PointerRequest {
	const wanted = verb === "mousedown" || verb === "mouseup" ? [0, 1] : verb === "drag" || verb === "mousemove" || verb === "mousewheel" ? [2, 2] : [1, 1];
	if (args.length < (wanted[0] as number) || args.length > (wanted[1] as number))
		throw new PointerUsageError(`pw --ext ${verb} takes ${USAGE[verb]}.`);
	if (tab !== undefined && (!Number.isSafeInteger(tab) || tab < 0 || tab > PW_EXT_MAX_TAB_ID))
		throw new PointerUsageError("pw --ext --tab takes a tab id from pw --ext tabs.");
	const [first = "", second = ""] = args;
	const request: Record<string, unknown> = { verb, ...(tab === undefined ? {} : { tabId: tab }) };
	if (verb === "hover" || verb === "dblclick") request.target = first;
	else if (verb === "drag") Object.assign(request, { target: first, to: second });
	else if (verb === "mousemove") Object.assign(request, { x: number(first, "x", verb), y: number(second, "y", verb) });
	else if (verb === "mousewheel") Object.assign(request, { dx: number(first, "dx", verb), dy: number(second, "dy", verb) });
	else if (args.length) request.button = first;
	try {
		return validate(request);
	} catch (error) {
		throw new PointerUsageError(`pw --ext ${verb}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
