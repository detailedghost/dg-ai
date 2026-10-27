import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { type Config, readConfig } from "./config";
import {
	isFork,
	listReviews,
	nextRound,
	type PullRequestEvent,
	readBaseFile,
	readEvent,
} from "./github";
import {
	compileArgs,
	type DiffPlan,
	dgSkills,
	lastJson,
	renderChunkTask,
} from "./tasks";

interface State {
	skipped: boolean;
	event: PullRequestEvent;
	round: number;
	policyPath: string | null;
	persona: string;
	personasDir: string | null;
	plan: DiffPlan;
	tasks: string[];
}

interface ProxyResult {
	exitCode: number;
	sessionId?: string | null;
	message?: string;
	stderrTail?: string;
	logFile?: string;
	error?: string;
}

interface CompileResult {
	reviewPath: string;
	verdict: "approve" | "request_changes" | "comment";
	reason: string;
	tally: Record<string, number>;
}

interface PostResult {
	url?: string;
	verdict?: string;
	degraded?: boolean;
	dryRun?: boolean;
}

const env = process.env;

function required(name: string): string {
	const value = env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

let work = "";
let scratch = "";
let statePath = "";
let failedCheck = false;

function setOutput(name: string, value: string): void {
	if (env.GITHUB_OUTPUT)
		appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function writeIn(dir: string, name: string, text: string): string {
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	writeFileSync(file, text);
	return file;
}

function scratchEnv(): Record<string, string> {
	return { AI_SCRATCH_DIR: scratch };
}

async function prepare(cfg: Config): Promise<void> {
	const event = readEvent(
		JSON.parse(readFileSync(required("GITHUB_EVENT_PATH"), "utf8")),
		required("GITHUB_REPOSITORY"),
	);
	if (isFork(event) && !cfg.reviewForks) {
		console.log(
			`::notice::Thrashley skips PR #${event.number} from fork ${event.headRepo}; set review-forks: true to review forks.`,
		);
		writeFileSync(statePath, JSON.stringify({ skipped: true }));
		setOutput("skipped", "true");
		return;
	}
	const diff = dgSkills(["thrash", "diff", event.url], scratchEnv());
	const [reviews, rules, policy, extraPrompt, agent] = await Promise.all([
		listReviews(event),
		readBaseFile(event, cfg.reviewRules),
		readBaseFile(event, cfg.policy),
		cfg.promptFile ? readBaseFile(event, cfg.promptFile) : null,
		cfg.agentFile ? readBaseFile(event, cfg.agentFile) : null,
	]);
	const round = nextRound(reviews, cfg.botLogin);
	if (rules === null)
		console.log(`::notice::No review rules at ${cfg.reviewRules} on the base branch; using the thrash defaults.`);
	if (policy === null)
		console.log(`::notice::No policy at ${cfg.policy} on the base branch; using the spice ${cfg.spice} verdict table.`);
	if (cfg.promptFile && extraPrompt === null) throw new Error(`prompt-file ${cfg.promptFile} is not on the base branch`);
	if (cfg.agentFile && agent === null) throw new Error(`agent-file ${cfg.agentFile} is not on the base branch`);

	let persona = "thrash";
	let personasDir: string | null = null;
	if (cfg.agentFile && agent !== null) {
		persona = path.basename(cfg.agentFile, ".md");
		personasDir = path.join(work, "personas");
		writeIn(personasDir, `${persona}.md`, agent);
	}

	const rulesPath =
		rules === null ? null : writeIn(scratch, "review-rules.md", rules);
	const policyPath =
		policy === null ? null : writeIn(work, "policy.yml", policy);
	const plan = lastJson<DiffPlan>(await diff);
	const tasks = plan.chunks.map((chunk) =>
		writeIn(
			path.join(scratch, "tasks"),
			`chunk-${chunk.id}.md`,
			renderChunkTask({
				chunk,
				chunkCount: plan.chunks.length,
				contextPath: plan.contextPath,
				spice: cfg.spice,
				target: event.url,
				rulesPath,
				extraPrompt,
			}),
		),
	);
	const state: State = {
		skipped: false,
		event,
		round,
		policyPath,
		persona,
		personasDir,
		plan,
		tasks,
	};
	writeFileSync(statePath, JSON.stringify(state, null, 2));
	setOutput("skipped", "false");
	setOutput("round", String(round));
	console.log(`Round ${round}: ${plan.chunks.length} chunk(s) to review.`);
}

function proxyEnv(cfg: Config, state: State): Record<string, string> {
	return {
		...scratchEnv(),
		...(cfg.unsafeAllowShell ? {} : { DG_PROXY_NO_SHELL: "1" }),
		...(state.personasDir ? { DG_PERSONAS_DIR: state.personasDir } : {}),
	};
}

async function runProxy(
	cfg: Config,
	state: State,
	args: string[],
): Promise<ProxyResult> {
	const model = cfg.model ? ["--model", cfg.model] : [];
	const out = await dgSkills(["proxy", cfg.backend, "--cwd", scratch, ...model, ...args],
		proxyEnv(cfg, state),
	).catch((err: Error) => err.message);
	try {
		return lastJson<ProxyResult>(out);
	} catch {
		return { exitCode: 1, error: out };
	}
}

function failure(result: ProxyResult): string {
	return result.error ?? result.stderrTail ?? `exit ${result.exitCode}`;
}

async function reviewChunk(
	cfg: Config,
	state: State,
	index: number,
): Promise<void> {
	const chunk = state.plan.chunks[index];
	const first = await runProxy(cfg, state, [
		"--subagent",
		state.persona,
		"--prompt-file",
		state.tasks[index],
	]);
	if (first.exitCode !== 0)
		throw new Error(`chunk ${chunk.id} (${chunk.label}): ${failure(first)}`);
	if (existsSync(chunk.findingsPath)) return;
	if (!first.sessionId)
		throw new Error(
			`chunk ${chunk.id} (${chunk.label}) wrote no findings and has no session to resume`,
		);
	const retry = writeIn(
		path.join(scratch, "tasks"),
		`chunk-${chunk.id}-retry.md`,
		`Write the fenced json block to ${chunk.findingsPath} now. Reply with only the WROTE line.\n`,
	);
	const second = await runProxy(cfg, state, [
		"--resume",
		first.sessionId,
		"--prompt-file",
		retry,
	]);
	if (second.exitCode !== 0 || !existsSync(chunk.findingsPath)) {
		throw new Error(
			`chunk ${chunk.id} (${chunk.label}) wrote no findings after a retry: ${failure(second)}`,
		);
	}
}

function readState(): State | null {
	const state = JSON.parse(readFileSync(statePath, "utf8")) as State;
	return state.skipped ? null : state;
}

async function review(cfg: Config): Promise<void> {
	const state = readState();
	if (!state) return;
	if (cfg.backend === "copilot" && !env.COPILOT_GITHUB_TOKEN) {
		throw new Error("the copilot backend needs the copilot-token input");
	}
	const results = await Promise.allSettled(state.plan.chunks.map((_, i) => reviewChunk(cfg, state, i)));
	const failed = results.flatMap((r) => (r.status === "rejected" ? [String(r.reason?.message ?? r.reason)] : []));
	if (failed.length > 0) throw new Error(`${failed.length} of ${results.length} chunk(s) failed: ${failed.join("; ")}`);
}

async function publish(cfg: Config): Promise<void> {
	const state = readState();
	if (!state) return;
	const execution = {
		...scratchEnv(),
		THRASH_EXECUTION_CONTEXT: JSON.stringify({ origin: "action" }),
	};
	const compiled = lastJson<CompileResult>(
		await dgSkills(compileArgs({
				target: state.event.url,
				diffPath: state.plan.diffPath,
				spice: cfg.spice,
				heading: cfg.heading,
				round: state.round,
				policyPath: state.policyPath,
				maxComments: cfg.maxComments,
				verdict: cfg.verdict,
				reviewer: cfg.botLogin,
				sass: cfg.sass,
			}),
			execution,
		),
	);
	const postFlags = cfg.dryRun
		? ["--dry-run"]
		: compiled.verdict === "comment"
			? []
			: ["--confirm"];
	const posted = lastJson<PostResult>(
		await dgSkills([
				"thrash",
				"post",
				state.event.url,
				"--review",
				compiled.reviewPath,
				...postFlags,
			],
			execution,
		),
	);
	if (posted.degraded)
		console.log(
			"::warning::GitHub refused the verdict, so the review posted as a comment. The summary still states the verdict.",
		);

	setOutput("verdict", compiled.verdict);
	setOutput("tally", JSON.stringify(compiled.tally));
	setOutput("review-url", posted.url ?? "");
	if (env.GITHUB_STEP_SUMMARY) {
		appendFileSync(
			env.GITHUB_STEP_SUMMARY,
			await dgSkills(["thrash", "tally", compiled.reviewPath], execution),
		);
	}
	console.log(
		`Verdict: ${compiled.verdict} (${compiled.reason})${cfg.dryRun ? " [dry run, nothing posted]" : ""}`,
	);
	if (compiled.verdict === "request_changes" && cfg.failOnRequestChanges) {
		console.log(`::error::Thrashley requested changes: ${compiled.reason}.`);
		failedCheck = true;
	}
}

const PHASES: Record<string, (cfg: Config) => Promise<void>> = { prepare, review, publish };

export const ACTION_PHASES = Object.keys(PHASES);

/** Runs one GitHub Action phase; failures print a workflow error and return a non-zero exit code. */
export async function runAction(name: string | undefined): Promise<number> {
	const phase = PHASES[name ?? ""];
	if (!phase) {
		console.error(`usage: dg-skills thrash action <${ACTION_PHASES.join("|")}>`);
		return 2;
	}
	try {
		work = required("THRASHLEY_WORK");
		scratch = path.join(work, "scratch");
		statePath = path.join(work, "state.json");
		failedCheck = false;
		await phase(readConfig(env));
		return failedCheck ? 1 : 0;
	} catch (err) {
		console.log(`::error::${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}
