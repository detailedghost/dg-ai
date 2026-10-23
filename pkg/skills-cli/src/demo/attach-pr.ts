/** The non-upload half of `dg:demo --attach-pr <ref>`, pending a future authenticated-upload spike: GitHub hands back the files and the PR link, GitLab is refused — neither mutates the PR. */

import { detectProvider as detectProviderDefault, type DetectResult } from "../provider/detect";
import { getProvider as getProviderDefault } from "../provider/index";
import type { PrRef, Provider, ProviderKind } from "../provider/types";

export type AttachPrOutcome =
	| { kind: "gitlab-unsupported" }
	| { kind: "no-login-handoff"; prUrl: string; files: readonly string[] };

export type AttachPrDeps = {
	detect: (remoteUrl?: string) => Promise<DetectResult>;
	getProvider: (override?: ProviderKind) => Promise<Provider>;
};

const defaultDeps: AttachPrDeps = {
	detect: detectProviderDefault,
	getProvider: getProviderDefault,
};

/** A bare number, or a PR/MR URL — `github.com/.../pull/83` or `.../-/merge_requests/83`. */
export function parsePrRefArg(ref: string): PrRef {
	if (/^\d+$/.test(ref)) return { number: Number(ref) };
	const match = /\/(?:pull|merge_requests)\/(\d+)(?:[/?#].*)?$/.exec(ref);
	if (match) return { number: Number(match[1] as string) };
	throw new Error(`--attach-pr <ref> must be a PR/MR number or URL, got "${ref}"`);
}

export async function resolveAttachPr(
	ref: string,
	files: readonly string[],
	deps: AttachPrDeps = defaultDeps,
): Promise<AttachPrOutcome> {
	const detected = await deps.detect();
	if (detected.kind === "gitlab") return { kind: "gitlab-unsupported" };
	const provider = await deps.getProvider("github");
	const pr = await provider.viewPullRequest(parsePrRefArg(ref));
	return { kind: "no-login-handoff", prUrl: pr.url, files };
}

/** The message `dg:demo` prints for either outcome — never silent about what did or didn't happen. */
export function describeAttachPrOutcome(outcome: AttachPrOutcome): string {
	if (outcome.kind === "gitlab-unsupported") {
		return "--attach-pr: GitLab attachment is not supported yet. The PR was not changed.";
	}
	const prefix = "--attach-pr: no authenticated upload path yet (that waits for the upload spike).";
	if (outcome.files.length === 0) {
		return `${prefix} Once you've recorded and downloaded it, attach it to ${outcome.prUrl} yourself — it was not changed.`;
	}
	const fileList = outcome.files.map((f) => `  - ${f}`).join("\n");
	return `${prefix} Attach these files to ${outcome.prUrl} yourself — it was not changed:\n${fileList}`;
}
