import { statSync } from "node:fs";
import { markerFiles } from "./lib";

/** Report whether the extension installer has written its marker file, under the current or the legacy name. */
export function isProtoExtensionInstalled(
	paths: readonly string[] = Object.values(markerFiles()),
): boolean {
	return paths.some((path) => {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	});
}
