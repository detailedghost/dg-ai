import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, readRepoFile } from "./test-support";

export const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");

export type WorkflowStep = {
	name?: string;
	uses?: string;
	run?: string;
	if?: string;
	with?: Record<string, unknown>;
	env?: Record<string, string>;
};

export type WorkflowJob = {
	needs?: string | string[];
	if?: string;
	uses?: string;
	env?: Record<string, string>;
	permissions?: Record<string, string> | string;
	strategy?: { matrix?: { include?: Array<Record<string, string>> } };
	steps?: WorkflowStep[];
};

export type Workflow = {
	on: {
		push?: { branches?: string[]; paths?: string[] };
		workflow_dispatch?: {
			inputs?: Record<string, { type?: string; options?: string[] }>;
		} | null;
	} & Record<string, unknown>;
	concurrency?: { group?: string; "cancel-in-progress"?: boolean };
	permissions?: Record<string, string>;
	jobs: Record<string, WorkflowJob>;
};

export function workflowFiles(): string[] {
	return readdirSync(WORKFLOWS_DIR).filter((name) => name.endsWith(".yml"));
}

export function workflowText(name: string): string {
	return readRepoFile(".github", "workflows", name);
}

export function parseWorkflow(name: string): Workflow {
	return Bun.YAML.parse(workflowText(name)) as Workflow;
}

export function jobNeeds(job: WorkflowJob): string[] {
	if (job.needs === undefined) return [];
	return Array.isArray(job.needs) ? job.needs : [job.needs];
}

export function reaches(
	workflow: Workflow,
	from: string,
	target: string,
): boolean {
	const seen = new Set<string>();
	const stack = [from];
	while (stack.length > 0) {
		const id = stack.pop() as string;
		if (id === target) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		stack.push(...jobNeeds(workflow.jobs[id] ?? {}));
	}
	return false;
}

export function stepText(step: WorkflowStep): string {
	return `${step.name ?? ""}\n${step.run ?? ""}`;
}

export function findStep(job: WorkflowJob, name: string): WorkflowStep {
	const step = (job.steps ?? []).find((candidate) => candidate.name === name);
	if (!step) throw new Error(`no step named "${name}"`);
	return step;
}

export type StepResult = { code: number; stdout: string; stderr: string };

export type StepSandbox = {
	root: string;
	origin: string;
	work: string;
	ghLog: string;
	run(step: WorkflowStep, env?: Record<string, string>, cwd?: string): StepResult;
	git(args: string[], cwd?: string): string;
	cloneOrigin(name: string): string;
	cleanup(): void;
};

const GH_STUB = `#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
draft_is_open() {
  [ -n "\${STUB_DRAFTS:-}" ] || return 1
  for id in $STUB_DRAFTS; do
    grep -qx "api --method DELETE repos/$GITHUB_REPOSITORY/releases/$id" "$GH_LOG" || return 0
  done
  return 1
}
case "$1 $2" in
  "release view")
    [ "$3" = "\${STUB_PUBLISHED:-}" ] && exit 0
    [ "$3" = "\${STUB_DRAFT_TAG:-}" ] && draft_is_open
    exit
    ;;
  "api repos/"*)
    case "$2" in
      */releases)
        needle='tag_name == "'"\${STUB_DRAFT_TAG:-}"'"'
        if [ -z "\${STUB_DRAFT_TAG:-}" ] || [[ "$*" == *"$needle"* ]]; then
          for id in \${STUB_DRAFTS:-}; do echo "$id"; done
        fi
        ;;
    esac
    ;;
esac
`;

export function createStepSandbox(): StepSandbox {
	const root = mkdtempSync(join(tmpdir(), "dg-release-step-"));
	const origin = join(root, "origin.git");
	const work = join(root, "work");
	const bin = join(root, "bin");
	const ghLog = join(root, "gh.log");
	const tmp = join(root, "tmp");
	for (const dir of [bin, tmp]) mkdirSync(dir);
	writeFileSync(join(bin, "gh"), GH_STUB);
	chmodSync(join(bin, "gh"), 0o755);
	writeFileSync(ghLog, "");

	const baseEnv: Record<string, string> = {
		PATH: `${bin}:${process.env.PATH ?? ""}`,
		HOME: root,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GH_LOG: ghLog,
		RUNNER_TEMP: tmp,
		GITHUB_REPOSITORY: "owner/repo",
		GITHUB_OUTPUT: join(tmp, "output"),
	};

	function git(args: string[], cwd = work): string {
		const result = Bun.spawnSync(
			["git", "-c", "user.name=setup", "-c", "user.email=setup@example.invalid", ...args],
			{ cwd, env: baseEnv },
		);
		if (result.exitCode !== 0) {
			throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
		}
		return result.stdout.toString().trim();
	}

	git(["init", "--bare", "--initial-branch=master", origin], root);
	git(["clone", origin, work], root);
	writeFileSync(join(work, "README.md"), "sandbox\n");
	git(["add", "README.md"]);
	git(["commit", "--message", "chore(sandbox): start"]);
	git(["push", "origin", "HEAD:refs/heads/master"]);

	return {
		root,
		origin,
		work,
		ghLog,
		git,
		cloneOrigin(name) {
			const dir = join(root, name);
			git(["clone", origin, dir], root);
			return dir;
		},
		run(step, env = {}, cwd = work) {
			const result = Bun.spawnSync(["bash", "-e", "-c", step.run ?? ""], {
				cwd,
				env: { ...baseEnv, ...env },
			});
			return {
				code: result.exitCode,
				stdout: result.stdout.toString(),
				stderr: result.stderr.toString(),
			};
		},
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}
