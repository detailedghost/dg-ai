import { join } from "node:path";
import { errorCode, slug } from "../address";
import { type ChannelConfig, githubHostsOf } from "../config";
import type { Engine, Log, RepoJobHost } from "../engine";
import { type CrCode, ownerName, replyText } from "../errors";
import type { StateStore } from "../state";
import { VerdictError } from "../verdict/types";
import type { Notify } from "./notify";
import { type RepoJobRunner, sweepCloneRoot } from "./repo-job";
import { parseRepo, type RepoClient } from "./repos";
import { dueWindow, resolveSchedule } from "./schedule";
import { DEPS_RUNNING, type OpenPr, type RepoRef } from "./types";


export type DepsFlowDeps = {
	state: StateStore;
	config: ChannelConfig;
	notify: Notify;
	repos: RepoClient;
	runRepoJob: RepoJobRunner;
	enqueue: Engine["enqueueRepo"];
	jobsDir: string;
	clock: () => Date;
	log: Log;
};

export type DepsFlow = {
	tick(signal: AbortSignal): Promise<void>;
};

export function createDepsFlow(deps: DepsFlowDeps): DepsFlow {
	const { state, config, notify, repos, runRepoJob, enqueue, jobsDir, clock, log } = deps;
	const { deps: settings } = config;
	const githubHosts = githubHostsOf(config.hosts);
	const owner = ownerName(config.owner.token);
	const timeoutMs = settings.timeoutMinutes * 60_000;

	async function upgrade(
		key: string,
		repo: RepoRef,
		branch: string | undefined,
		windowStart: string,
	): Promise<void> {
		const id = `deps:${key}`;
		const record = (result: string) => state.recordDepsRun(key, { windowStart, result });
		const failed = (code: CrCode) => {
			record("failed");
			return notify(
				`Deps upgrade failed for ${key}. ${replyText(code, { agent: "claude", minutes: settings.timeoutMinutes, owner })} Job log: ${join(jobsDir, `${slug(id)}.log`)}`,
			);
		};

		record(DEPS_RUNNING);
		const job = async (host: RepoJobHost): Promise<void> => {
			const startedAt = clock().getTime();
			try {
				const base = branch ?? (await repos.defaultBranch(repo));
				const outcome = await runRepoJob<null>({
					id,
					repo,
					branch: base,
					signal: host.signal,
					timeoutMs,
					task: async ({ dir, signal }) => {
						const code = await host.runAgent({
							task: { task: "deps", cooldownDays: settings.cooldownDays },
							cwd: dir,
							timeoutMs,
							logName: slug(id),
							signal,
						});
						if (code) throw new VerdictError(code);
					},
					finish: async () => null,
				});
				if (outcome.kind === "timeout") return await failed("CR-204");
				if (outcome.kind === "aborted") return await failed("CR-205");
				if (outcome.kind === "error") {
					log.warn(`deps ${id} failed: ${String(outcome.error)}`);
					return await failed(errorCode(outcome.error, "CR-405"));
				}
				const created = (await repos.openPrs(repo)).find(
					(pr) =>
						pr.headRefName.startsWith(settings.branchPrefix) &&
						Date.parse(pr.createdAt) >= startedAt,
				);
				if (!created) {
					record("no-changes");
					await notify(`No dependency upgrades for ${key}.`);
				} else if (created.isDraft) {
					state.watchPr(created.url, { repo: key, kind: "deps" });
					record("draft-pr");
					await notify(
						`Deps upgrade PR opened as draft for ${key}, waiting for CI:`,
						created.url,
					);
				} else {
					record("ready");
					await notify(`Deps upgrade ready for ${key}:`, created.url);
				}
			} catch (error) {
				log.warn(`deps ${id} failed: ${String(error)}`);
				await failed(errorCode(error, "CR-405"));
			}
		};
		const accepted = enqueue({
			id,
			url: `https://${key}`,
			work: async (host) => {
				try {
					await job(host);
				} finally {
					sweepCloneRoot(config.automation.cloneRoot, [], log);
				}
			},
		});
		if (!accepted) log.info(`deps ${id} is already running`);
	}

	async function tick(signal: AbortSignal): Promise<void> {
		if (!settings.enabled) return;
		for (const entry of settings.repos) {
			if (signal.aborted) return;
			const window = dueWindow(clock(), resolveSchedule(settings.schedule, entry.schedule));
			if (!window) continue;
			const windowStart = window.windowStart.toISOString();
			if (state.get().deps.lastRun[entry.repo]?.windowStart === windowStart) continue;

			const repo = parseRepo(entry.repo, githubHosts);
			let open: OpenPr | undefined;
			try {
				open = (await repos.openPrs(repo)).find((pr) =>
					pr.headRefName.startsWith(settings.branchPrefix),
				);
			} catch (error) {
				log.warn(`could not list open PRs for ${entry.repo}: ${String(error)}`);
				continue;
			}
			if (open) {
				log.info(`skipping deps upgrade for ${entry.repo}: ${open.url} is still open`);
				state.recordDepsRun(entry.repo, { windowStart, result: "skipped" });
				continue;
			}
			await upgrade(entry.repo, repo, entry.branch, windowStart);
		}
	}

	return { tick };
}
