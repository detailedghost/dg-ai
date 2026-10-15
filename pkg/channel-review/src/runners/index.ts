import { homedir } from "node:os";
import { runCapture } from "@dg/common/node";
import type { ChannelConfig } from "../config";
import {
	CLI_TIMEOUT_MS,
	type SkillFs,
	realSkillFs,
	thrashInstalled,
} from "./probe";
import { type ProcessRequest, type ProcessResult, runProcess } from "./spawn";
import { RUNNER_NAMES, type Runner, type RunnerName } from "./types";

const AUTH_FAILURE: Record<RunnerName, RegExp> = {
	claude:
		/^(?:error:\s+)?(?:invalid api key|please run \/login|not logged in|authentication failed|401 unauthorized)\b/im,
	codex:
		/^error:\s.*(?:invalid api key|not logged in|authentication failed|401 unauthorized)/im,
	copilot:
		/^error:\s.*(?:invalid api key|not logged in|authentication failed|401 unauthorized)/im,
};
const AUTH_INFERENCE_WINDOW_MS = 60_000;

type RunRequest = Parameters<Runner["run"]>[0];

type RunnerSeams = {
	which?: (name: string) => string | undefined | null;
	homedir?: string;
	fs?: SkillFs;
	now?: () => number;
	runCapture?: typeof runCapture;
	runProcess?: (request: ProcessRequest) => Promise<ProcessResult>;
};

type Spec = {
	loginArgs?: string[];
	argv(path: string, request: RunRequest, config: ChannelConfig): string[];
};

function thrashArgs(request: RunRequest): string {
	if (request.task !== "thrash") throw new Error("only claude runs /address");
	const { url, spice, comment } = request;
	return `${url}${spice === undefined ? "" : ` -s ${spice}`}${comment ? " -c" : ""}`;
}

function claudePrompt(request: RunRequest): string {
	if (request.task === "thrash") return `/thrash ${thrashArgs(request)}`;
	return `/address${request.noCi ? " --no-ci" : ""}`;
}

const SPECS: Record<RunnerName, Spec> = {
	claude: {
		loginArgs: ["auth", "status"],
		argv: (path, request, config) => [
			path,
			"-p",
			claudePrompt(request),
			"--permission-prompts",
			"none",
			"--permission-mode",
			"dontAsk",
			"--allowedTools",
			...(request.task === "thrash"
				? config.runner.claude.allowedTools
				: config.runner.claude.addressAllowedTools),
		],
	},
	codex: {
		loginArgs: ["login", "status"],
		argv: (path, request) => [
			path,
			"exec",
			"--skip-git-repo-check",
			"-C",
			request.cwd,
			"--dangerously-bypass-approvals-and-sandbox",
			`Use the thrash skill: $thrash ${thrashArgs(request)}`,
		],
	},
	copilot: {
		argv: (path, request) => [
			path,
			"-p",
			`Use the thrash skill: /thrash ${thrashArgs(request)}`,
			"--allow-all-tools",
			"--no-ask-user",
			"-s",
		],
	},
};

function configuredPath(config: ChannelConfig, name: RunnerName) {
	return config.runner[name]?.path;
}

export function createRunners(
	config: ChannelConfig,
	seams: RunnerSeams = {},
): Record<RunnerName, Runner> {
	const which = seams.which ?? Bun.which;
	const home = seams.homedir ?? homedir();
	const fs = seams.fs ?? realSkillFs;
	const now = seams.now ?? Date.now;
	const capture = seams.runCapture ?? runCapture;
	const spawn = seams.runProcess ?? runProcess;

	const locate = (name: RunnerName) =>
		configuredPath(config, name) ?? which(name) ?? undefined;

	const create = (name: RunnerName): Runner => {
		const spec = SPECS[name];
		return {
			name,
			async probe() {
				const path = locate(name);
				if (!path) return { ok: false, code: "CR-201" };
				if (spec.loginArgs) {
					const login = await capture(path, spec.loginArgs, {
						timeoutMs: CLI_TIMEOUT_MS,
					});
					if (login.status !== 0) return { ok: false, code: "CR-202" };
				}
				if (!thrashInstalled(name, home, fs)) return { ok: false, code: "CR-206" };
				return { ok: true };
			},
			async run(request) {
				const path = locate(name);
				if (!path) {
					return {
						status: null,
						signal: null,
						timedOut: false,
						aborted: false,
						code: "CR-201",
					};
				}
				const startedAt = now();
				const { stderrTail, code, ...outcome } = await spawn({
					argv: spec.argv(path, request, config),
					cwd: request.cwd,
					timeoutMs: request.timeoutMs,
					logPath: request.logPath,
					keepOauthToken: name === "claude",
					signal: request.signal,
					onSpawn: request.onSpawn,
				});
				const failedFast =
					outcome.status !== null &&
					outcome.status !== 0 &&
					now() - startedAt < AUTH_INFERENCE_WINDOW_MS;
				if (code) return { ...outcome, code };
				if (failedFast && AUTH_FAILURE[name].test(stderrTail)) {
					return { ...outcome, code: "CR-202" };
				}
				return outcome;
			},
		};
	};

	return Object.fromEntries(
		RUNNER_NAMES.map((name) => [name, create(name)]),
	) as Record<RunnerName, Runner>;
}
