import { isRecord } from "@dg/common";
import { MIN_LEVELS, type ChannelConfig, type MinLevel } from "../config";
import type { Log } from "../engine";
import { nested, normalizeRepoUrl, records, retryAfterMs, text, toIso } from "./datadog";
import { AuthError, ConfigError, RateLimitError } from "./errors";
import type { ErrorReport, ErrorSink, SinkIssue } from "./types";

const DEFAULT_BASE_URL = "https://sentry.io";
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MAX_FRAMES = 30;
const REQUEST_TIMEOUT_MS = 30_000;
const NEXT_PAGE = /<[^>]*>;\s*rel="next";\s*results="true";\s*cursor="([^"]+)"/;

export type SentryDeps = {
	config: ChannelConfig;
	env: Record<string, string | undefined>;
	fetch: typeof fetch;
	clock: () => Date;
	log: Log;
};

type Json = Record<string, unknown>;
type Page = { body: unknown; cursor?: string };

function nextCursor(link: string | null): string | undefined {
	return link?.match(NEXT_PAGE)?.[1];
}

function formatStack(event: unknown): string | undefined {
	const entry = records(nested(event, "entries")).find((candidate) => candidate.type === "exception");
	const frames = records(nested(entry, "data", "values")).flatMap((value) =>
		records(nested(value, "stacktrace", "frames")),
	);
	if (frames.length === 0) return undefined;
	return frames
		.slice(-MAX_FRAMES)
		.map((frame) => {
			const file = text(frame.filename) ?? text(frame.module) ?? "<unknown>";
			const line = typeof frame.lineno === "number" ? `:${frame.lineno}` : "";
			const name = text(frame.function);
			return `${file}${line}${name === undefined ? "" : ` in ${name}`}`;
		})
		.join("\n");
}

function tagValue(event: unknown, key: string): string | undefined {
	const tag = records(nested(event, "tags")).find((candidate) => candidate.key === key);
	return text(tag?.value);
}

function findRepoTag(event: unknown): string | undefined {
	const url =
		tagValue(event, "git.repository_url") ??
		tagValue(event, "repository_url") ??
		text(nested(event, "contexts", "repository", "url"));
	return url === undefined ? undefined : normalizeRepoUrl(url);
}

export function createSentrySink({ config, env, fetch: doFetch, clock, log }: SentryDeps): ErrorSink {
	const { projects, envs } = config.errorWatch.providers.sentry;
	const minRank = MIN_LEVELS.indexOf(config.errorWatch.minLevel);

	async function call(
		path: string,
		params: URLSearchParams,
		signal?: AbortSignal,
	): Promise<Page> {
		const token = text(env.SENTRY_AUTH_TOKEN);
		const org = text(env.SENTRY_ORG);
		const missing = [
			...(token === undefined ? ["SENTRY_AUTH_TOKEN"] : []),
			...(org === undefined ? ["SENTRY_ORG"] : []),
		];
		if (token === undefined || org === undefined) throw new ConfigError(missing);
		const base = (text(env.SENTRY_BASE_URL) ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		const query = params.size === 0 ? "" : `?${params.toString()}`;
		const route = `/api/0/organizations/${encodeURIComponent(org)}/${path}`;
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const response = await doFetch(`${base}${route}${query}`, {
			method: "GET",
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
			signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
		});
		if (response.status === 429) {
			const reset = Number(response.headers.get("X-Sentry-Rate-Limit-Reset"));
			const fromReset = Number.isFinite(reset) && reset > 0 ? String(reset - clock().getTime() / 1000) : null;
			throw new RateLimitError(retryAfterMs(response.headers.get("Retry-After") ?? fromReset));
		}
		if (response.status === 401 || response.status === 403) {
			throw new AuthError(`sentry rejected the credentials (${response.status})`);
		}
		if (!response.ok) throw new Error(`sentry GET ${route} failed (${response.status})`);
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new Error(`sentry GET ${route} returned invalid JSON`);
		}
		return { body, cursor: nextCursor(response.headers.get("Link")) };
	}

	function buildParams(since: Date): URLSearchParams {
		const params = new URLSearchParams();
		params.set("query", ["is:unresolved", ...envs.exclude.map((name) => `!environment:${name}`)].join(" "));
		for (const project of projects.include) params.append("project", project);
		for (const name of envs.include) params.append("environment", name);
		params.set("sort", "date");
		params.set("limit", String(PAGE_SIZE));
		params.set("start", since.toISOString());
		params.set("end", clock().toISOString());
		return params;
	}

	function toIssue(row: Json, since: Date): SinkIssue | undefined {
		const id = text(row.id);
		const firstSeen = toIso(row.firstSeen);
		const level = text(row.level);
		const service = text(nested(row, "project", "slug"));
		if (id === undefined || firstSeen === undefined || level === undefined || service === undefined) {
			return undefined;
		}
		const regressed = nested(row, "substatus") === "regressed";
		const isNew = nested(row, "substatus") === "new" || Date.parse(firstSeen) >= since.getTime();
		if (!regressed && !isNew) return undefined;
		return {
			id,
			title: text(row.title) ?? id,
			service,
			env: envs.include.length === 1 ? (envs.include[0] ?? "unknown") : "unknown",
			level: level as MinLevel,
			firstSeen,
			lastSeen: toIso(row.lastSeen) ?? firstSeen,
			link: text(row.permalink) ?? id,
			regressed,
		};
	}

	function passes(issue: SinkIssue): boolean {
		return MIN_LEVELS.indexOf(issue.level) >= minRank && !projects.exclude.includes(issue.service);
	}

	async function latestEvent(issue: SinkIssue): Promise<unknown> {
		try {
			const { body } = await call(
				`issues/${encodeURIComponent(issue.id)}/events/latest/`,
				new URLSearchParams(),
			);
			return isRecord(body) ? body : undefined;
		} catch (error) {
			log.warn(
				`sentry event lookup failed for issue ${issue.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	}

	return {
		name: "sentry",
		async poll({ since, signal }) {
			const params = buildParams(since);
			const issues = new Map<string, SinkIssue>();
			for (let page = 1; page <= MAX_PAGES; page += 1) {
				const { body, cursor } = await call("issues/", params, signal);
				for (const row of records(body)) {
					const issue = toIssue(row, since);
					if (issue !== undefined && passes(issue)) issues.set(issue.id, issue);
				}
				if (cursor === undefined) break;
				if (page === MAX_PAGES) {
					log.warn(`sentry search has more than ${MAX_PAGES} pages; some issues may be missed`);
				}
				params.set("cursor", cursor);
			}
			const list = [...issues.values()];
			return { issues: list, cursor: list.map((issue) => issue.firstSeen).sort().at(-1) };
		},
		async detail(issue): Promise<ErrorReport> {
			const event = await latestEvent(issue);
			return {
				...issue,
				env: issue.env === "unknown" ? (tagValue(event, "environment") ?? issue.env) : issue.env,
				message: text(nested(event, "message")) ?? issue.title,
				stack: formatStack(event),
				repoTag: findRepoTag(event),
			};
		},
	};
}
