import { git, redactTokens, ShellError } from "../utils/git";
import { ProviderError, type ProviderKind, parseScpForm } from "./types";

/** Record whether provider selection came from an override, recognized host, or merge-request URL path. */
export type DetectSource = "env" | "host" | "path";

/** The provider identity and the rule that selected it; repository metadata is resolved separately. */
export interface DetectResult {
	kind: ProviderKind;
	source: DetectSource;
}

const GITLAB_MR_PATH_RE = /\/-\/merge_requests\/\d+/;

function parseHost(url: string): string {
	const scpMatch = parseScpForm(url);
	if (scpMatch) return scpMatch.host;
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		throw new ProviderError(
			"HOST_NOT_RECOGNIZED",
			`vcs remote url could not be parsed: "${redactTokens(url)}" (set AI_VCS_PROVIDER=github|gitlab, or add its host to AI_VCS_GITLAB_HOSTS)`,
		);
	}
}

function gitlabHostAllowlist(): string[] {
	const raw = process.env.AI_VCS_GITLAB_HOSTS;
	if (!raw) return [];
	return raw
		.split(",")
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean);
}

function resolveFromUrl(url: string): DetectResult {
	if (GITLAB_MR_PATH_RE.test(url)) {
		return { kind: "gitlab", source: "path" };
	}
	const host = parseHost(url);
	if (host === "github.com") return { kind: "github", source: "host" };
	if (host === "gitlab.com") return { kind: "gitlab", source: "host" };
	if (gitlabHostAllowlist().includes(host)) return { kind: "gitlab", source: "host" };
	throw new ProviderError(
		"HOST_NOT_RECOGNIZED",
		`vcs host not recognized: ${host} (set AI_VCS_PROVIDER=github|gitlab, or add "${host}" to AI_VCS_GITLAB_HOSTS)`,
	);
}

async function originRemoteUrl(): Promise<string> {
	try {
		const result = await git`remote get-url origin`;
		return result.stdout.toString().trim();
	} catch (e) {
		if (e instanceof ShellError) {
			const stderrLine = redactTokens(e.stderr.toString().split("\n")[0] ?? "");
			const detail = stderrLine ? `: ${stderrLine}` : "";
			if (e.exitCode === 128) {
				throw new ProviderError(
					"NO_GIT_REPO",
					`not a git repository here — run this from inside a git checkout${detail}`,
					{ cause: e },
				);
			}
			if (e.exitCode === 2) {
				throw new ProviderError("NO_REMOTE", `no "origin" remote configured for this repository${detail}`, {
					cause: e,
				});
			}
		}
		throw e;
	}
}

function envOverride(): ProviderKind | undefined {
	const envValue = process.env.AI_VCS_PROVIDER;
	const trimmedEnvValue = envValue?.trim();
	if (!trimmedEnvValue) return undefined;
	if (trimmedEnvValue === "github" || trimmedEnvValue === "gitlab") return trimmedEnvValue;
	throw new ProviderError(
		"INVALID_PROVIDER_ENV",
		`AI_VCS_PROVIDER="${envValue}" is not a recognized provider (expected "github" or "gitlab")`,
	);
}

/**
 * An explicitly passed URL outranks AI_VCS_PROVIDER, which falls back to covering only hosts the URL
 * rules cannot place — a caller resolving several hosts in one run must not have them all forced to one.
 */
export async function detectProvider(remoteUrl?: string): Promise<DetectResult> {
	const override = envOverride();
	if (remoteUrl !== undefined) {
		try {
			return resolveFromUrl(remoteUrl);
		} catch (err) {
			if (override !== undefined && err instanceof ProviderError && err.code === "HOST_NOT_RECOGNIZED") {
				return { kind: override, source: "env" };
			}
			throw err;
		}
	}
	if (override !== undefined) return { kind: override, source: "env" };
	return resolveFromUrl(await originRemoteUrl());
}
