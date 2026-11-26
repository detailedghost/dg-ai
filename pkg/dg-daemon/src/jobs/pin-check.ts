import { DgCliError } from "@dg/common";
import { type DgPaths, jobSourceDir } from "@dg/common/node";
import { findRecordByJob, readSourceRecords } from "./sources";

type PinPaths = Pick<DgPaths, "jobsDir" | "jobSourcesPath">;

function gitEnv(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).flatMap(([key, value]) =>
			value === undefined || key.startsWith("GIT_") ? [] : [[key, value]],
		),
	);
}

function readHead(clone: string, name: string): { sha: string; tree: string } {
	const result = Bun.spawnSync(["git", "rev-parse", "HEAD", "HEAD^{tree}"], {
		cwd: clone,
		env: gitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [sha, tree] = result.stdout.toString().trim().split("\n");
	if (result.exitCode !== 0 || !sha || !tree) {
		throw new DgCliError(`dg job: cannot read the git clone of "${name}" at ${clone}. Next: run dg job remove ${name}, then dg job add it again.`);
	}
	return { sha, tree };
}

/** Refuses a git job whose clone is no longer at the commit and tree that were approved at install. */
export function assertJobPinned(name: string, paths: PinPaths): void {
	const found = findRecordByJob(readSourceRecords(paths), name);
	if (found?.record.kind !== "git") return;
	const { source, record } = found;
	if (record.pin?.kind === "sha256") {
		throw new DgCliError(`dg job: "${name}" has a sha256 pin, and a job plugin pins a full commit SHA. Next: run dg job remove ${name}, then dg job add it again.`);
	}
	const expected = record.pin?.value ?? record.sha;
	const head = readHead(jobSourceDir(paths, source), name);
	if (head.sha !== expected) {
		throw new DgCliError(`dg job: the clone of "${name}" is at ${head.sha}, which is not the pinned commit ${expected}. Next: run dg job update ${name}, or dg job remove ${name} and add it again.`);
	}
	if (record.tree !== undefined && head.tree !== record.tree) {
		throw new DgCliError(`dg job: the tree of "${name}" is ${head.tree}, not the recorded tree ${record.tree}. Next: run dg job remove ${name}, then dg job add it again.`);
	}
}
