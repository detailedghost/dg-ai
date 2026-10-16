import { describeError } from "@dg/common";
import { runCapture } from "@dg/common/node";
import type { ChannelConfig } from "../config";
import type { Engine, Log } from "../engine";
import type { Sleep } from "../providers/teams-relay/sleep";
import type { ChatProvider } from "../providers/types";
import { createSinks, missingEnvByProvider } from "../sinks";
import { createErrorPoller } from "../sinks/poller";
import type { ErrorReport, ErrorSink } from "../sinks/types";
import type { StateStore } from "../state";
import type { CaptureFn } from "../verdict/cli";
import { createDepsFlow } from "./deps-flow";
import { createFixFlow } from "./fix-flow";
import { createNotifier } from "./notify";
import { createPrWatcher } from "./pr-watch";
import { createRepoJobRunner } from "./repo-job";
import { createRepoClient } from "./repos";
import { runTicker } from "./ticker";

const MINUTE_MS = 60_000;
const DEPS_INTERVAL_MS = MINUTE_MS;
const PR_WATCH_INTERVAL_MS = 2 * MINUTE_MS;

export type AutomationSeams = {
	env?: Record<string, string | undefined>;
	fetch?: typeof fetch;
	capture?: CaptureFn;
	sleep?: Sleep;
	sinks?: ErrorSink[];
};

export type Automation = { stop(): Promise<void> };

export function startAutomation({
	config,
	engine,
	state,
	provider,
	jobsDir,
	seams,
	log,
	signal,
}: {
	config: ChannelConfig;
	engine: Engine;
	state: StateStore;
	provider: ChatProvider;
	jobsDir: string;
	seams: AutomationSeams;
	log: Log;
	signal: AbortSignal;
}): Automation {
	const { errorWatch, deps } = config;
	const controller = new AbortController();
	const stopSignal = AbortSignal.any([signal, controller.signal]);
	const tickers: Promise<void>[] = [];
	const clock = () => new Date();
	const capture = seams.capture ?? runCapture;
	const notify = createNotifier({ provider, config, log });
	const repos = createRepoClient(capture);
	const runRepoJob = createRepoJobRunner({
		capture,
		cloneRoot: config.automation.cloneRoot,
		log,
	});
	const enqueue: Engine["enqueueRepo"] = (job) => engine.enqueueRepo(job);

	const start = (name: string, intervalMs: number, tick: (signal: AbortSignal) => Promise<void>) => {
		tickers.push(
			runTicker({ name, intervalMs, tick, signal: stopSignal, log, sleep: seams.sleep }),
		);
	};

	function activeSinks(): ErrorSink[] {
		if (!errorWatch.enabled) return [];
		if (seams.sinks) return seams.sinks;
		const env = seams.env ?? process.env;
		const missing = missingEnvByProvider(config, env);
		for (const [name, names] of Object.entries(missing)) {
			const message = `missing environment variables: ${names.join(", ")}`;
			state.updateSink(name, { lastError: message });
			log.warn(`error watch ${name} is skipped: ${message}`);
		}
		return createSinks(config, env, { fetch: seams.fetch ?? fetch, clock, log }).filter(
			(sink) => !(sink.name in missing),
		);
	}

	const sinks = activeSinks();
	if (sinks.length > 0) {
		const fixFlow = createFixFlow({
			state,
			config,
			notify,
			repos,
			runRepoJob,
			run: capture,
			enqueue,
			clock,
			log,
		});
		const poller = createErrorPoller({
			config,
			sinks,
			state,
			log,
			clock,
			sleep: seams.sleep,
			onIssue: async (issue, sinkName) => {
				let report: ErrorReport = { ...issue, message: issue.title };
				try {
					report = (await sinks.find((sink) => sink.name === sinkName)?.detail(issue)) ?? report;
				} catch (error) {
					log.warn(`${sinkName} issue ${issue.id} detail failed: ${describeError(error)}`);
				}
				await fixFlow.handleIssue(sinkName, report);
			},
		});
		start("error watch", errorWatch.pollMinutes * MINUTE_MS, (tickSignal) => poller.tick(tickSignal));
	}

	if (deps.enabled) {
		const depsFlow = createDepsFlow({
			state,
			config,
			notify,
			repos,
			runRepoJob,
			enqueue,
			jobsDir,
			clock,
			log,
		});
		const watcher = createPrWatcher({ state, config, notify, repos, clock, log });
		start("deps upgrades", DEPS_INTERVAL_MS, (tickSignal) => depsFlow.tick(tickSignal));
		start("pr watch", PR_WATCH_INTERVAL_MS, () => watcher.tick());
	}

	return {
		async stop() {
			controller.abort();
			await Promise.allSettled(tickers);
		},
	};
}
