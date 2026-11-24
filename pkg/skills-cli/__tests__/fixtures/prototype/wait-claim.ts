import { acceptanceHook } from "../../../src/prototype/accepted";
import { protoDir, sentinelPaths } from "../../../src/prototype/paths";
import { printWait, wait, waitExitCode } from "../../../src/prototype/sentinels";
import { httpCapturer } from "./signin-app";

const [project, name, delay] = process.argv.slice(2);
if (!project || !name) throw new Error("usage: wait-claim.ts <project> <name> [delayMs]");
const dir = protoDir(name, { cwd: project, light: false });
const result = await wait(
	sentinelPaths(dir),
	10,
	acceptanceHook({ dir, name, chain: name }, { open: httpCapturer([], Number(delay ?? 0), name) }),
	(claimed) => printWait(claimed, true),
);
process.exitCode = waitExitCode(result);
