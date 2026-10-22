import { assertExtensionInstalled } from "../../utils/cli-only";
import type { ExtOutcome, ExtRequest } from "./protocol";

/** `pw --ext` has no live bridge yet: no dg-daemon frame and no extension-side handler exist. */
export class ExtBridgeNotImplementedError extends Error {
	constructor() {
		super(
			"pw --ext has no bridge to the extension yet (no dg-daemon frame, no extension-side handler). " +
				"See plugins/dg/skills/pw/references/ext-mode.md for what is implemented and what remains.",
		);
		this.name = "ExtBridgeNotImplementedError";
	}
}

/**
 * The real transport for `pw --ext`. Confirms the extension is installed (the existing CLI-only guard),
 * then fails clearly: the dg-daemon <-> extension leg for pw's verbs is not implemented. Tests use a fake
 * ExtTransport instead of this one.
 */
export async function defaultExtTransport(_request: ExtRequest): Promise<ExtOutcome> {
	assertExtensionInstalled("dg-skills pw --ext");
	throw new ExtBridgeNotImplementedError();
}
