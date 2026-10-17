import type { Command } from "commander";
import { main } from "../clipboard-image";
import { registerRawCommand } from "../utils/legacy-command";

/** Register native clipboard capture without reading the clipboard during registration. */
export function registerClipboardImage(program: Command): void {
	registerRawCommand(program, {
		name: "clipboard-image",
		description: "Save the clipboard image as PNG",
		run: main,
	});
}
