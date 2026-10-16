import { isRecord } from "@dg/common";
import { MIN_LEVELS, type ChannelConfig, type MinLevel } from "../config";
import type { Log } from "../engine";
import { AuthError, ConfigError, RateLimitError } from "./errors";
import type { ErrorReport, ErrorSink, SinkIssue } from "./types";

const DEFAULT_SITE = "datadoghq.com";
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_SECONDS = 60;
const MIN_RETRY_SECONDS = 1;
const MAX_RETRY_SECONDS = 300;
const EVENTS_WINDOW = "now-30d";
const REPO_URL = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:](.+?)(?:\.git)?\/?$/i;

export type DatadogDeps = {
	config: ChannelConfig;
	env: Record<string, string | undefined>;
	fetch: typeof fetch;
	clock: () => Date;
	log: Log;
};

type Json = Record<string, unknown>;

export function normalizeRepoUrl(url: string): string | undefined {
	const match = url.trim().match(REPO_URL);
	if (match === null) return undefined;
	const [, host, path] = match;
	return `${host?.toLowerCase()}/${path}`;
}

export function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function toIso(value: unknown): string | undefined {
	const date =
		typeof value === "number"
			? new Date(value)
			: typeof value === "string"
				? new Date(/^\d+$/.test(value) ? Number(value) : value)
				: undefined;
	return date !== undefined && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
}

export function records(value: unknown): Json[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function nested(value: unknown, ...path: string[]): unknown {
	let current = value;
	for (const key of path) {
		if (!isRecord(current)) return undefined;
		current = current[key];
	}
	return current;
}

function queryList(key: string, values: string[]): string[] {
	return values.length === 0 ? [] : [`${key}:(${values.join(" OR ")})`];
}

export function buildQuery(
	services: { include: string[]; exclude: string[] },
	envs: { include: string[]; exclude: string[] },
): string {
	return [
		...queryList("service", services.include),
		...queryList("env", envs.include),
		...queryList("-service", services.exclude),
		...queryList("-env", envs.exclude),
	].join(" ");
}

export function retryAfterMs(header: string | null): number {
	const seconds = header === null || header.trim() === "" ? Number.NaN : Number(header);
	const value = Number.isFinite(seconds) ? seconds : DEFAULT_RETRY_SECONDS;
	return Math.min(Math.max(value, MIN_RETRY_SECONDS), MAX_RETRY_SECONDS) * 1000;
}

function findRepoTag(tags: unknown): string | undefined {
	if (!Array.isArray(tags)) return undefined;
	for (const tag of tags) {
		if (typeof tag === "string" && tag.startsWith("git.repository_url:")) {
			return tag.slice("git.repository_url:".length);
		}
	}
	return undefined;
}

function extractEvent(event: unknown): { stack?: string; message?: string; repoTag?: string } {
	const attributes = nested(event, "attributes");
	const inner = nested(attributes, "attributes");
	const repoUrl =
		text(nested(inner, "git", "repository_url")) ??
		text(nested(inner, "custom", "git", "repository_url")) ??
		text(nested(inner, "git.repository_url")) ??
		text(nested(inner, "custom", "git.repository_url")) ??
		findRepoTag(nested(attributes, "tags"));
	return {
		stack: text(nested(inner, "error", "stack")) ?? text(nested(inner, "error.stack")),
		message: text(nested(inner, "error", "message")) ?? text(nested(inner, "error.message")),
		repoTag: repoUrl === undefined ? undefined : normalizeRepoUrl(repoUrl),
	};
}

export function createDatadogSink({ config, env, fetch: doFetch, clock, log }: DatadogDeps): ErrorSink {
	const { tracks, services, envs } = config.errorWatch.providers.datadog;
	const minRank = MIN_LEVELS.indexOf(config.errorWatch.minLevel);
	const trackById = new Map<string, string>();

	function site(): string {
		return text(env.DATADOG_SITE) ?? DEFAULT_SITE;
	}

	async function call(
		method: "GET" | "POST",
		path: string,
		body: unknown,
		signal?: AbortSignal,
	): Promise<Json> {
		const apiKey = text(env.DATADOG_API_KEY);
		const appKey = text(env.DATADOG_APP_KEY);
		const missing = [
			...(apiKey === undefined ? ["DATADOG_API_KEY"] : []),
			...(appKey === undefined ? ["DATADOG_APP_KEY"] : []),
		];
		if (apiKey === undefined || appKey === undefined) throw new ConfigError(missing);
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const response = await doFetch(`https://api.${site()}${path}`, {
			method,
			headers: {
				"DD-API-KEY": apiKey,
				"DD-APPLICATION-KEY": appKey,
				Accept: "application/json",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
		});
		if (response.status === 429) {
			throw new RateLimitError(retryAfterMs(response.headers.get("Retry-After")));
		}
		if (response.status === 401 || response.status === 403) {
			throw new AuthError(`datadog rejected the credentials (${response.status})`);
		}
		if (!response.ok) throw new Error(`datadog ${method} ${path} failed (${response.status})`);
		let parsed: unknown;
		try {
			parsed = await response.json();
		} catch {
			throw new Error(`datadog ${method} ${path} returned invalid JSON`);
		}
		if (!isRecord(parsed)) throw new Error(`datadog ${method} ${path} returned an unexpected body`);
		return parsed;
	}

	function toIssue(row: Json, track: string): SinkIssue | undefined {
		const id = text(row.id);
		const attributes = row.attributes;
		if (id === undefined || !isRecord(attributes)) return undefined;
		const state = text(attributes.state);
		if (state === "IGNORED" || state === "EXCLUDED") return undefined;
		const service = text(attributes.service);
		const firstSeen = toIso(attributes.first_seen);
		if (service === undefined || firstSeen === undefined) return undefined;
		const regressedAt = toIso(nested(attributes, "regression", "regressed_at"));
		const lastSeen = toIso(attributes.last_seen) ?? firstSeen;
		const titleParts = [text(attributes.error_type), text(attributes.error_message)];
		trackById.set(id, track);
		return {
			id,
			title: titleParts.filter((part) => part !== undefined).join(": ") || id,
			service,
			env: envs.include.length === 1 ? (envs.include[0] ?? "unknown") : "unknown",
			level: attributes.is_crash === true ? "fatal" : "error",
			firstSeen,
			lastSeen: regressedAt !== undefined && regressedAt > lastSeen ? regressedAt : lastSeen,
			link: `https://app.${site()}/error-tracking?issueId=${encodeURIComponent(id)}`,
			regressed: regressedAt !== undefined,
		};
	}

	function passes(issue: SinkIssue): boolean {
		return (
			MIN_LEVELS.indexOf(issue.level as MinLevel) >= minRank &&
			!services.exclude.includes(issue.service)
		);
	}

	async function pollTrack(track: string, since: Date, signal: AbortSignal): Promise<SinkIssue[]> {
		const body = await call(
			"POST",
			"/api/v2/error-tracking/issues/search?include=issue",
			{
				data: {
					type: "search_request",
					attributes: {
						query: buildQuery(services, envs),
						from: since.getTime(),
						to: clock().getTime(),
						track,
						order_by: "FIRST_SEEN",
					},
				},
			},
			signal,
		);
		const data = records(body.data);
		if (data.length >= PAGE_SIZE) {
			log.warn(`datadog ${track} search returned a full page of ${PAGE_SIZE}; some issues may be missed`);
		}
		const byId = new Map<string, SinkIssue>();
		for (const row of records(body.included)) {
			if (row.type !== "issue") continue;
			const issue = toIssue(row, track);
			if (issue !== undefined) byId.set(issue.id, issue);
		}
		return [...byId.values()];
	}

	async function lookupEvent(issue: SinkIssue): Promise<ReturnType<typeof extractEvent>> {
		const track = trackById.get(issue.id) ?? tracks[0];
		const path =
			track === "trace"
				? "/api/v2/spans/events/search"
				: track === "logs"
					? "/api/v2/logs/events/search"
					: undefined;
		if (path === undefined) return {};
		try {
			const body = await call("POST", path, {
				filter: { query: `issue.id:${issue.id}`, from: EVENTS_WINDOW, to: "now" },
				page: { limit: 1 },
			});
			return extractEvent(records(body.data)[0]);
		} catch (error) {
			log.warn(
				`datadog events lookup failed for issue ${issue.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return {};
		}
	}

	return {
		name: "datadog",
		async poll({ since, signal }) {
			const issues = new Map<string, SinkIssue>();
			for (const track of tracks) {
				for (const issue of await pollTrack(track, since, signal)) {
					if (passes(issue)) issues.set(issue.id, issue);
				}
			}
			const list = [...issues.values()];
			const cursor = list.map((issue) => issue.firstSeen).sort().at(-1);
			return { issues: list, cursor };
		},
		async detail(issue): Promise<ErrorReport> {
			const body = await call("GET", `/api/v2/error-tracking/issues/${encodeURIComponent(issue.id)}`, undefined);
			const attributes = nested(body, "data", "attributes");
			const event = await lookupEvent(issue);
			return {
				...issue,
				message:
					event.message ??
					text(nested(attributes, "error_message")) ??
					text(nested(attributes, "title")) ??
					issue.title,
				stack: event.stack,
				repoTag: event.repoTag,
			};
		},
	};
}
