import { statSync } from "node:fs";
import { legacyMarkerPath, markerPath } from "./lib";

/** Report whether the extension installer has written its marker file, under the current or the legacy name. */
export function isProtoExtensionInstalled(
	paths: readonly string[] = [markerPath, legacyMarkerPath],
): boolean {
	return paths.some((path) => {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	});
}
