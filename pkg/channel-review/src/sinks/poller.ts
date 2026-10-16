import { describeError } from "@dg/common";
import type { ChannelConfig } from "../config";
import type { Log } from "../engine";
import { abortableSleep, type Sleep } from "../providers/teams-relay/sleep";
import type { IssueEntry, StateStore } from "../state";
import { RateLimitError } from "./errors";
import type { ErrorSink, SinkIssue } from "./types";

const MINUTE_MS = 60_000;
const IN_FLIGHT: readonly IssueEntry["status"][] = ["fixing", "deferred"];

export type ErrorPollerDeps = {
	config: ChannelConfig;
	sinks: ErrorSink[];
	state: StateStore;
	onIssue(issue: SinkIssue, sinkName: string): Promise<void>;
	log: Log;
	clock: () => Date;
	sleep?: Sleep;
};

export type ErrorPoller = { tick(signal: AbortSignal): Promise<void> };

export function issueKey(sinkName: string, issueId: string): string {
	return `${sinkName}:${issueId}`;
}

export function createErrorPoller({
	config,
	sinks,
	state,
	onIssue,
	log,
	clock,
	sleep = abortableSleep,
}: ErrorPollerDeps): ErrorPoller {
	const { enabled, lookbackMinutes } = config.errorWatch;

	function sinceFor(cursor: string | undefined, deferredFrom: number[]): Date {
		const floor = clock().getTime() - lookbackMinutes * MINUTE_MS;
		const parsed = cursor === undefined ? Number.NaN : Date.parse(cursor);
		const base = Number.isNaN(parsed) ? floor : Math.max(parsed, floor);
		return new Date(Math.min(base, ...deferredFrom));
	}

	function shouldTrigger(issue: SinkIssue, entry: IssueEntry | undefined): boolean {
		if (entry === undefined || entry.status === "deferred") return true;
		return (
			issue.regressed &&
			!IN_FLIGHT.includes(entry.status) &&
			Date.parse(issue.lastSeen) > Date.parse(entry.at)
		);
	}

	async function handle(sink: ErrorSink, issue: SinkIssue): Promise<boolean> {
		const key = issueKey(sink.name, issue.id);
		const entry = state.get().issues[key];
		if (!shouldTrigger(issue, entry)) return false;
		if (entry?.status !== "deferred") {
			state.setIssue(key, { status: "seen", firstSeen: entry?.firstSeen ?? issue.firstSeen });
		}
		try {
			await onIssue(issue, sink.name);
		} catch (error) {
			log.warn(`${sink.name} issue ${issue.id} hand-off failed: ${describeError(error)}`);
			state.setIssue(key, { status: "failed", firstSeen: entry?.firstSeen ?? issue.firstSeen });
		}
		return true;
	}

	async function pollSink(sink: ErrorSink, signal: AbortSignal): Promise<void> {
		const previous = state.get().sinks[sink.name];
		const prefix = `${sink.name}:`;
		const deferredFrom = Object.entries(state.get().issues)
			.filter(([key, entry]) => key.startsWith(prefix) && entry.status === "deferred")
			.map(([, entry]) => Date.parse(entry.firstSeen))
			.filter((time) => !Number.isNaN(time));
		const now = clock();
		const since = sinceFor(previous?.cursor, deferredFrom);
		const { issues, cursor } = await sink.poll({ since, signal });
		const firstRun = previous?.cursor === undefined;
		let triggered = 0;
		for (const issue of issues) {
			if (firstRun) {
				state.setIssue(issueKey(sink.name, issue.id), {
					status: "seen",
					firstSeen: issue.firstSeen,
				});
			} else if (await handle(sink, issue)) {
				triggered += 1;
			}
		}
		const counts = previous?.counts ?? {};
		state.updateSink(sink.name, {
			cursor: cursor ?? previous?.cursor ?? now.toISOString(),
			lastPollAt: now.toISOString(),
			lastError: undefined,
			counts: {
				...counts,
				polled: (counts.polled ?? 0) + issues.length,
				triggered: (counts.triggered ?? 0) + triggered,
			},
		});
	}

	return {
		async tick(signal) {
			if (!enabled) return;
			let failure: unknown;
			for (const sink of sinks) {
				if (signal.aborted) return;
				try {
					await pollSink(sink, signal);
				} catch (error) {
					state.updateSink(sink.name, { lastError: describeError(error) });
					if (error instanceof RateLimitError) await sleep(error.retryAfterMs, signal);
					failure ??= error;
				}
			}
			if (failure !== undefined) throw failure;
		},
	};
}
