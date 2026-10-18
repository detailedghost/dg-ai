import { afterAll, afterEach } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WriteFakeCliOptions {
	/** "suite" restores PATH once after the whole describe block instead of after each test. */
	scope?: "test" | "suite";
}

/** Auto-restores PATH via an afterEach hook, or afterAll when `opts.scope` is "suite". */
export function writeFakeCli(dir: string, binName: string, script: string, opts?: WriteFakeCliOptions): void {
	const path = join(dir, binName);
	writeFileSync(path, script);
	chmodSync(path, 0o755);

	process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
	const restore = () => {
		process.env.PATH = (process.env.PATH ?? "")
			.split(":")
			.filter((entry) => entry !== dir)
			.join(":");
	};
	if (opts?.scope === "suite") {
		afterAll(restore);
	} else {
		afterEach(restore);
	}
}
