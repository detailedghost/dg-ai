import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeBuildInfo(lib: string, info: { version: string; sha: string }): void {
	writeFileSync(join(lib, "build.json"), `${JSON.stringify(info)}\n`);
}
