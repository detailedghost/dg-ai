import type { PlanAction, PlanNotice } from "./plan";
import { parseSieve, sieveLooksTruncated } from "./parse";

export type SafetyPolicy = {
	protectedPlusAlias: string;
	verificationSenders: string[];
	blockedDestinations: string[];
};

export type SafetyIssue = {
	code:
		| "alias-unconfigured"
		| "protected-destination"
		| "verification-destination"
		| "truncated-sieve"
		| "unresolved-drift"
		| "order";
	message: string;
};

export const requiredVerificationSenders = ["github.com", "gitlab.com"];
export const requiredBlockedDestinations = ["spam", "trash"];

export function safetyIssues(input: {
	actions: PlanAction[];
	notices: PlanNotice[];
	policy: SafetyPolicy;
	keepFirst: string[];
	desiredNames: string[];
}): SafetyIssue[] {
	const issues: SafetyIssue[] = [];
	const alias = input.policy.protectedPlusAlias.trim();
	if (!alias) {
		issues.push({
			code: "alias-unconfigured",
			message:
				"Set policy.safety.protectedPlusAlias before applying. The pattern lives in the declared filters file.",
		});
	}
	const blocked = blockedDestinations(input.policy.blockedDestinations);
	const senders = verificationSenders(input.policy.verificationSenders);
	for (const action of input.actions) {
		const sieve = actionSieve(action);
		if (sieve === undefined) continue;
		if (sieveLooksTruncated(sieve)) {
			issues.push({
				code: "truncated-sieve",
				message: `Refusing to write a truncated sieve for ${actionLabel(action)}`,
			});
			continue;
		}
		if (!routesToBlocked(sieve, blocked)) continue;
		if (alias && textMatchesAlias(sieve, alias)) {
			issues.push({
				code: "protected-destination",
				message: `Refusing to route protected plus-alias mail to Spam or Trash in ${actionLabel(action)}`,
			});
		}
		if (mentionsVerificationSender(sieve, senders)) {
			issues.push({
				code: "verification-destination",
				message: `Refusing to route verification mail to Spam or Trash in ${actionLabel(action)}`,
			});
		}
	}
	if (input.notices.some((notice) => notice.op === "drift")) {
		issues.push({
			code: "unresolved-drift",
			message:
				"Resolve each drifted filter or folder with --pull or --revert before apply",
		});
	}
	if (!keepFirstSatisfied(input.desiredNames, input.keepFirst)) {
		issues.push({
			code: "order",
			message: `Declared filters must start with ${input.keepFirst.join(", ")}`,
		});
	}
	return issues;
}

export function blockedDestinations(extra: string[]): string[] {
	return unique([
		...requiredBlockedDestinations,
		...extra.map((item) => item.trim().toLowerCase()).filter(Boolean),
	]);
}

export function verificationSenders(extra: string[]): string[] {
	return unique([
		...requiredVerificationSenders,
		...extra.map((item) => item.trim().toLowerCase()).filter(Boolean),
	]);
}

export function textMatchesAlias(text: string, glob: string): boolean {
	const pattern = globToRegExp(glob.trim());
	if (pattern.test(text.trim())) return true;
	const pieces = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
	if (pieces.some((piece) => pattern.test(piece))) return true;
	const local = /^([^*@]+)\+\*@(.+)$/.exec(glob.trim());
	if (!local?.[1] || !local[2]) return false;
	const localPattern = new RegExp(
		`${escapeRegExp(local[1])}\\+[A-Za-z0-9._-]+`,
		"i",
	);
	return localPattern.test(text);
}

export function mentionsVerificationSender(
	text: string,
	domains: string[],
): boolean {
	const lower = text.toLowerCase();
	return domains.some((domain) => {
		const escaped = escapeRegExp(domain.toLowerCase());
		return new RegExp(`(^|@|\\.|\\s|")${escaped}\\b`, "i").test(lower);
	});
}

export function routesToBlocked(sieve: string, blocked: string[]): boolean {
	if (/\bdiscard\s*;/i.test(sieve)) return true;
	return parseSieve(sieve).fileinto.some((path) => {
		const full = path.toLowerCase();
		const last = full.split("/").filter(Boolean).at(-1) ?? full;
		return blocked.some((item) => item === full || item === last);
	});
}

export function keepFirstSatisfied(names: string[], keepFirst: string[]): boolean {
	if (keepFirst.length === 0) return true;
	return keepFirst.every((name, index) => names[index] === name);
}

export function globToRegExp(glob: string): RegExp {
	const marked = glob.replaceAll("*", "\u0000");
	const body = escapeRegExp(marked).replaceAll("\u0000", ".*");
	return new RegExp(`^${body}$`, "i");
}

function actionSieve(action: PlanAction): string | undefined {
	if (
		action.op === "create-filter" ||
		action.op === "update-filter" ||
		action.op === "revert-filter" ||
		action.op === "pull-filter"
	) {
		return action.sieve;
	}
	return undefined;
}

function actionLabel(action: PlanAction): string {
	if (action.op === "update-filter" || action.op === "revert-filter") {
		return action.name;
	}
	if (action.op === "create-filter" || action.op === "pull-filter") {
		return action.name;
	}
	return action.op;
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function escapeRegExp(value: string): string {
	return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
