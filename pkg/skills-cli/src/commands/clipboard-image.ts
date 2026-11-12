import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Register native clipboard capture without reading the clipboard during registration. */
export function registerClipboardImage(program: Command): void {
	registerLazyRaw(program, {
		name: "clipboard-image",
		description: "Save the clipboard image as PNG",
		load: () => import("../clipboard-image"),
	});
}
