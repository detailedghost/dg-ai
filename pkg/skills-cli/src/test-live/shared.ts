import { runCapture } from "@dg/common/node";

export class TestLiveError extends Error {}

export const PATCH_MARKER = "workflow_dispatch: {}  # TEST-LIVE: temporary";

export function makeDie(prefix: string): (message: string) => number {
	return (message: string) => {
		process.stderr.write(`${prefix}: ${message}\n`);
		return 1;
	};
}

export function info(message: string): void {
	process.stdout.write(`>>> ${message}\n`);
}

export function git(args: string[]) {
	return runCapture("git", args, { stdin: null });
}
