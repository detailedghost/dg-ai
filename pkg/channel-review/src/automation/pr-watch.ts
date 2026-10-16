import { describeError } from "@dg/common";
import type { ChannelConfig } from "../config";
import type { Log } from "../engine";
import type { StateStore } from "../state";
import type { Notify } from "./notify";
import type { RepoClient } from "./repos";

const NO_CHECKS_GRACE_MS = 5 * 60_000;

export type PrWatcherDeps = {
	state: StateStore;
	config: ChannelConfig;
	notify: Notify;
	repos: Pick<RepoClient, "prStatus" | "markReady">;
	clock: () => Date;
	log: Log;
};

export type PrWatcher = {
	tick(): Promise<void>;
};

export function createPrWatcher({ state, config, notify, repos, clock, log }: PrWatcherDeps): PrWatcher {
	const ciTimeoutMs = config.deps.ciTimeoutMinutes * 60_000;

	async function check(url: string, startedAt: string): Promise<void> {
		const { state: prState, isDraft, checks } = await repos.prStatus(url);
		const age = clock().getTime() - Date.parse(startedAt);
		const finish = async (text: string, link?: string) => {
			state.unwatchPr(url);
			await notify(text, link);
		};

		if (prState !== "OPEN") return void state.unwatchPr(url);
		if (!isDraft) return finish("Deps upgrade ready:", url);

		const failing = checks.filter((entry) => entry.done && !entry.ok);
		if (failing.length > 0) {
			return finish(`CI failed on ${url}: ${failing.map((entry) => entry.name).join(", ")}`);
		}
		const settled = checks.length === 0 ? age >= NO_CHECKS_GRACE_MS : checks.every((entry) => entry.done);
		if (settled) {
			await repos.markReady(url);
			return finish("Deps upgrade ready:", url);
		}
		if (age >= ciTimeoutMs) {
			return finish(`CI did not finish within ${config.deps.ciTimeoutMinutes} minutes on ${url}.`);
		}
	}

	async function tick(): Promise<void> {
		for (const [url, entry] of Object.entries(state.get().prWatch)) {
			try {
				await check(url, entry.startedAt);
			} catch (error) {
				log.warn(`watching ${url} failed: ${describeError(error)}`);
			}
		}
	}

	return { tick };
}
