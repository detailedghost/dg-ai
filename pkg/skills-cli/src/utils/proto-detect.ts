import { statSync } from "node:fs";
import { markerPath } from "./lib";

/** Report whether the browser-extension installer has written its marker file. */
export function isProtoExtensionInstalled(path = markerPath): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
