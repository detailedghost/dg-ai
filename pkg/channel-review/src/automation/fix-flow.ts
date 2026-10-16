import { rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { errorCode, slug } from "../address";
import { type ChannelConfig, githubHostsOf } from "../config";
import type { Engine, Log, RepoJobHost } from "../engine";
import { type CrCode, ownerName, replyText } from "../errors";
import { issueKey } from "../sinks/poller";
import type { ErrorReport } from "../sinks/types";
import type { IssueStatus, StateStore } from "../state";
import type { CaptureFn } from "../verdict/cli";
import { VerdictError } from "../verdict/types";
import { type Notify, redact } from "./notify";
import type { RepoJobRunner } from "./repo-job";
import { normalizeRepoTag, parseRepo, type RepoClient, repoKey } from "./repos";
import type { RepoRef } from "./types";

const HOUR_MS = 3_600_000;
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const TITLE_CAP = 300;
const MESSAGE_CAP = 2000;
const STACK_CAP = 8000;
const SUBJECT_CAP = 72;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export type FixFlowDeps = {
	state: StateStore;
	config: ChannelConfig;
	notify: Notify;
	repos: RepoClient;
	runRepoJob: RepoJobRunner;
	run: CaptureFn;
	enqueue: Engine["enqueueRepo"];
	clock: () => Date;
	log: Log;
};

export type FixFlow = {
	handleIssue(sink: string, report: ErrorReport): Promise<void>;
};

type Target = { repo: RepoRef; branch?: string };

function cap(text: string, max: number): string {
	return text.replace(CONTROL, "").slice(0, max);
}

function oneLine(text: string, max: number): string {
	return cap(text, max).replace(/\s+/g, " ").trim();
}

export function createFixFlow(deps: FixFlowDeps): FixFlow {
	const { state, config, notify, repos, runRepoJob, run, enqueue, clock, log } =
		deps;
	const { errorWatch } = config;
	const githubHosts = githubHostsOf(config.hosts);
	const owner = ownerName(config.owner.token);
	const timeoutMs = errorWatch.autoFix.timeoutMinutes * 60_000;

	function resolveTarget(report: ErrorReport): Target | undefined {
		const entries = Object.values(errorWatch.repos);
		const tag =
			report.repoTag && normalizeRepoTag(report.repoTag, githubHosts);
		const byTag = tag
			? entries.find(
					(entry) => normalizeRepoTag(entry.repo, githubHosts) === tag,
				)
			: undefined;
		const entry = byTag ?? errorWatch.repos[report.service];
		return (
			entry && {
				repo: parseRepo(entry.repo, githubHosts),
				branch: entry.branch,
			}
		);
	}

	async function command(
		cwd: string,
		tool: "git" | "gh",
		args: string[],
	): Promise<string> {
		const result = await run(tool, args, {
			cwd,
			timeoutMs: COMMAND_TIMEOUT_MS,
		});
		if (result.status !== 0) {
			throw new Error(
				`${tool} ${args[0]} failed (${result.status}): ${result.stderr.trim()}`,
			);
		}
		return result.stdout;
	}

	function reportBody(report: ErrorReport): string {
		return JSON.stringify({
			id: cap(report.id, 200),
			title: cap(report.title, TITLE_CAP),
			service: cap(report.service, 200),
			env: cap(report.env, 100),
			level: report.level,
			regressed: report.regressed,
			firstSeen: report.firstSeen,
			lastSeen: report.lastSeen,
			message: cap(report.message, MESSAGE_CAP),
			stack:
				report.stack === undefined ? undefined : cap(report.stack, STACK_CAP),
		});
	}

	function pullRequestBody(sink: string, report: ErrorReport): string {
		const summary = `${oneLine(report.title, TITLE_CAP)} (${oneLine(report.service, 100)}, ${oneLine(report.env, 50)}, ${report.level})`;
		return [
			`Opened automatically from ${sink} issue ${report.link}.`,
			`Summary: ${redact(summary)}`,
			"Review before merging; this PR was generated from production error data.",
		].join("\n\n");
	}

	async function fix(
		sink: string,
		report: ErrorReport,
		target: Target,
		branch: string,
		host: RepoJobHost,
		id: string,
	): Promise<{ url: string } | { code: CrCode }> {
		let reportPath: string | undefined;
		try {
			const defaultBranch = await repos.defaultBranch(target.repo);
			const base = target.branch ?? defaultBranch;
			const outcome = await runRepoJob<string>({
				id,
				repo: target.repo,
				branch: base,
				signal: host.signal,
				timeoutMs,
				prepare: async ({ dir }) => {
					await command(dir, "git", ["checkout", "-b", branch]);
					reportPath = join(dirname(dir), `${basename(dir)}.report.json`);
					writeFileSync(reportPath, reportBody(report), { mode: 0o600 });
				},
				task: async ({ dir, signal }) => {
					if (reportPath === undefined)
						throw new Error("report file was not written");
					const code = await host.runAgent({
						task: { task: "fix", reportPath },
						cwd: dir,
						timeoutMs,
						logName: slug(id),
						signal,
					});
					if (code) throw new VerdictError(code);
				},
				finish: async ({ dir }) => {
					const changes = await command(dir, "git", ["status", "--porcelain"]);
					if (changes.trim() === "") throw new VerdictError("CR-404");
					await command(dir, "git", ["add", "-A"]);
					const subject = `fix(${oneLine(report.service, 40)}): ${oneLine(report.title, SUBJECT_CAP)}`;
					await command(dir, "git", ["commit", "-m", subject]);
					const head = (
						await command(dir, "git", ["rev-parse", "--abbrev-ref", "HEAD"])
					).trim();
					if (head !== branch || head === defaultBranch) {
						throw new VerdictError(
							"CR-405",
							`refusing to push from branch ${head}`,
						);
					}
					await command(dir, "git", ["push", "-u", "origin", branch]);
					const created = await command(dir, "gh", [
						"pr",
						"create",
						"--draft",
						"--repo",
						repoKey(target.repo),
						"--base",
						base,
						"--head",
						branch,
						"--title",
						subject,
						"--body",
						pullRequestBody(sink, report),
					]);
					const url = created.trim().split("\n").pop() ?? "";
					if (!url.startsWith("http"))
						throw new Error("the pull request command returned no URL");
					return url;
				},
			});
			if (outcome.kind === "ok") return { url: outcome.value };
			if (outcome.kind === "timeout") return { code: "CR-204" };
			if (outcome.kind === "aborted") return { code: "CR-205" };
			log.warn(`fix ${id} failed: ${String(outcome.error)}`);
			return { code: errorCode(outcome.error, "CR-405") };
		} catch (error) {
			log.warn(`fix ${id} failed: ${String(error)}`);
			return { code: errorCode(error, "CR-405") };
		} finally {
			if (reportPath !== undefined) rmSync(reportPath, { force: true });
		}
	}

	async function handleIssue(sink: string, report: ErrorReport): Promise<void> {
		const key = issueKey(sink, report.id);
		const known = state.get().issues[key];
		if (known && known.status !== "seen" && known.status !== "deferred") return;
		const retry = known?.status === "deferred";
		const firstSeen = known?.firstSeen ?? report.firstSeen;
		const mark = (status: IssueStatus, prUrl?: string) =>
			state.setIssue(key, { status, firstSeen, ...(prUrl && { prUrl }) });
		const say = (code: CrCode) =>
			notify(
				replyText(code, {
					agent: "claude",
					minutes: errorWatch.autoFix.timeoutMinutes,
					owner,
				}),
				report.link,
			);

		if (!retry) {
			await notify(
				`New ${report.level} error in ${report.service} (${report.env}): ${oneLine(report.title, TITLE_CAP)}`,
				report.link,
			);
		}
		if (
			!errorWatch.autoFix.enabled ||
			errorWatch.repos[report.service]?.autoFix === false
		) {
			mark("notified");
			return;
		}

		const target = resolveTarget(report);
		if (!target) {
			mark("failed");
			await say("CR-401");
			return;
		}

		const recent = state
			.get()
			.fixStarts.filter(
				(at) => clock().getTime() - Date.parse(at) < HOUR_MS,
			).length;
		if (recent >= errorWatch.autoFix.maxPerHour) {
			mark("deferred");
			if (!retry) await say("CR-402");
			return;
		}

		const branch = `bot/fix/${slug(sink, report.id)}`;
		let existing: { url: string } | undefined;
		try {
			existing = (await repos.openPrs(target.repo)).find(
				(pr) => pr.headRefName === branch,
			);
		} catch (error) {
			log.warn(
				`could not list open PRs for ${repoKey(target.repo)}: ${String(error)}`,
			);
			mark("failed");
			await say("CR-405");
			return;
		}
		if (existing) {
			mark("pr-open", existing.url);
			await notify(replyText("CR-403", { owner }), existing.url);
			return;
		}

		const id = `fix:${key}`;
		mark("fixing");
		enqueue({
			id,
			url: report.link,
			work: async (host) => {
				state.recordFixStart();
				const result = await fix(sink, report, target, branch, host, id);
				if ("code" in result) {
					mark("failed");
					await say(result.code);
					return;
				}
				mark("pr-open", result.url);
				await notify(
					`Draft fix pull request opened for ${oneLine(report.title, TITLE_CAP)}.`,
					result.url,
				);
			},
		});
	}

	return { handleIssue };
}
