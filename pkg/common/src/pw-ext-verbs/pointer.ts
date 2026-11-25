import { fail, requireRecord, requireString } from "../assert";
import { PW_EXT_MAX_TAB_ID, PW_EXT_MAX_TARGET_BYTES } from "../pw-ext-format";

export const VERBS = ["hover", "dblclick", "drag", "mousedown", "mouseup", "mousemove", "mousewheel"] as const;
export type PointerVerb = (typeof VERBS)[number];

export const POINTER_BUTTONS = ["left", "middle", "right"] as const;
export type PointerButton = (typeof POINTER_BUTTONS)[number];

export const POINTER_MAX_COORD = 100_000;

type Base = { tabId?: number };
export type PointerRequest =
	| (Base & { verb: "hover" | "dblclick"; target: string })
	| (Base & { verb: "drag"; target: string; to: string })
	| (Base & { verb: "mousemove"; x: number; y: number })
	| (Base & { verb: "mousedown" | "mouseup"; button?: PointerButton })
	| (Base & { verb: "mousewheel"; dx: number; dy: number });

export type PointerResult = { detail: string } | { error: string };

const KEYS: Record<PointerVerb, readonly string[]> = {
	hover: ["verb", "tabId", "target"],
	dblclick: ["verb", "tabId", "target"],
	drag: ["verb", "tabId", "target", "to"],
	mousemove: ["verb", "tabId", "x", "y"],
	mousedown: ["verb", "tabId", "button"],
	mouseup: ["verb", "tabId", "button"],
	mousewheel: ["verb", "tabId", "dx", "dy"],
};

function requireTarget(value: unknown, path: string): void {
	requireString(value, path, { nonEmpty: true });
	if (new TextEncoder().encode(value).length > PW_EXT_MAX_TARGET_BYTES)
		fail(`${path} exceeds ${PW_EXT_MAX_TARGET_BYTES} bytes`);
}

function requireCoord(value: unknown, path: string, min: number): void {
	if (!Number.isFinite(value) || (value as number) < min || (value as number) > POINTER_MAX_COORD)
		fail(`${path} must be a number from ${min} to ${POINTER_MAX_COORD}`);
}

export function validate(request: unknown): PointerRequest {
	requireRecord(request, "request");
	const verb = request.verb;
	if (!(VERBS as readonly unknown[]).includes(verb)) fail(`request.verb must be one of ${VERBS.join(", ")}`);
	const allowed = KEYS[verb as PointerVerb];
	for (const key of Object.keys(request)) if (!allowed.includes(key)) fail(`request.${key} is not used by ${String(verb)}`);
	if (request.tabId !== undefined && (!Number.isSafeInteger(request.tabId) || (request.tabId as number) < 0 || (request.tabId as number) > PW_EXT_MAX_TAB_ID))
		fail("request.tabId must be a tab id");
	switch (verb as PointerVerb) {
		case "hover":
		case "dblclick":
			requireTarget(request.target, "request.target");
			break;
		case "drag":
			requireTarget(request.target, "request.target");
			requireTarget(request.to, "request.to");
			break;
		case "mousemove":
			requireCoord(request.x, "request.x", 0);
			requireCoord(request.y, "request.y", 0);
			break;
		case "mousedown":
		case "mouseup":
			if (request.button !== undefined && !(POINTER_BUTTONS as readonly unknown[]).includes(request.button))
				fail(`request.button must be one of ${POINTER_BUTTONS.join(", ")}`);
			break;
		case "mousewheel":
			requireCoord(request.dx, "request.dx", -POINTER_MAX_COORD);
			requireCoord(request.dy, "request.dy", -POINTER_MAX_COORD);
			break;
	}
	return request as PointerRequest;
}
