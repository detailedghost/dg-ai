import { describe, expect, test } from "bun:test";
import type { PlanAction, PlanNotice } from "../plan";
import {
	blockedDestinations,
	globToRegExp,
	keepFirstSatisfied,
	mentionsVerificationSender,
	routesToBlocked,
	safetyIssues,
	textMatchesAlias,
	verificationSenders,
	type SafetyPolicy,
} from "../safety";

const policy: SafetyPolicy = {
	protectedPlusAlias: "owner+*@example.test",
	verificationSenders: ["security.example"],
	blockedDestinations: ["junk"],
};

function sieve(address: string, folder: string): string {
	return `require ["fileinto"];\nif address :all :is "To" "${address}" {\n  fileinto "${folder}";\n}\n`;
}

function create(name: string, body: string): PlanAction {
	return { op: "create-filter", name, enabled: true, sieve: body };
}

describe("filter policy safety", () => {
	test("blocks protected plus-alias mail and verification mail to Spam, Trash, or discard", () => {
		const issues = safetyIssues({
			actions: [
				create("Bot", sieve("owner+bot@example.test", "Spam")),
				create("Code", sieve("owner+bot@example.test", "Trash")),
				create(
					"Drop",
					'require ["fileinto"];\nif address :all :is "To" "owner+bot@example.test" {\n  discard;\n}\n',
				),
				create("GitHub", sieve("notify@github.com", "trash")),
				create("GitLab", sieve("notify@gitlab.com", "Spam")),
				create("Extra", sieve("alerts@security.example", "junk")),
				create("Nested", sieve("notify@notifications.github.com", "Spam")),
			],
			notices: [],
			policy,
			keepFirst: [],
			desiredNames: [],
		});
		expect(issues.filter((issue) => issue.code === "protected-destination")).toHaveLength(
			3,
		);
		expect(
			issues.filter((issue) => issue.code === "verification-destination").length,
		).toBeGreaterThanOrEqual(4);
		expect(issues.some((issue) => issue.message.includes("Bot"))).toBe(true);
	});

	test("allows protected and verification mail into a normal folder", () => {
		const issues = safetyIssues({
			actions: [
				create("Owner", sieve("owner+owner@example.test", "inbox")),
				create("GitHub", sieve("notify@github.com", "work/code")),
			],
			notices: [],
			policy,
			keepFirst: ["Owner"],
			desiredNames: ["Owner", "GitHub"],
		});
		expect(issues).toEqual([]);
	});

	test("still blocks GitHub when the policy list is empty and Spam when no extra destinations are set", () => {
		const issues = safetyIssues({
			actions: [create("GitHub", sieve("notify@github.com", "Spam"))],
			notices: [],
			policy: {
				protectedPlusAlias: "owner+*@example.test",
				verificationSenders: [],
				blockedDestinations: [],
			},
			keepFirst: [],
			desiredNames: [],
		});
		expect(issues.map((issue) => issue.code)).toEqual(["verification-destination"]);
		expect(verificationSenders([])).toEqual(["github.com", "gitlab.com"]);
		expect(blockedDestinations([])).toEqual(["spam", "trash"]);
		expect(blockedDestinations([" junk ", ""])).toContain("junk");
	});

	test("blocks a missing alias, a truncated sieve, unresolved drift, and a bad leading order", () => {
		const truncated = safetyIssues({
			actions: [create("Cut", 'require ["fileinto"]; fileinto "fin')],
			notices: [],
			policy,
			keepFirst: [],
			desiredNames: ["Cut"],
		});
		expect(truncated.map((issue) => issue.code)).toContain("truncated-sieve");
		const blank = safetyIssues({
			actions: [],
			notices: [],
			policy: { ...policy, protectedPlusAlias: "  " },
			keepFirst: [],
			desiredNames: [],
		});
		expect(blank.map((issue) => issue.code)).toEqual(["alias-unconfigured"]);
		const drift: PlanNotice = {
			op: "drift",
			target: "filter",
			id: "f1",
			name: "Fin - Banking",
			detail: "Proton changed this filter after the last import or sync",
		};
		const unresolved = safetyIssues({
			actions: [],
			notices: [drift],
			policy,
			keepFirst: ["+Owner"],
			desiredNames: ["Fin - Banking"],
		});
		expect(unresolved.map((issue) => issue.code)).toEqual([
			"unresolved-drift",
			"order",
		]);
		expect(keepFirstSatisfied(["+Owner", "Fin - Banking"], ["+Owner"])).toBe(true);
		expect(keepFirstSatisfied(["Fin - Banking"], [])).toBe(true);
		expect(keepFirstSatisfied(["Fin - Banking"], ["+Owner"])).toBe(false);
	});

	test("matches alias globs and sender domains without treating an inbox copy as blocked", () => {
		expect(textMatchesAlias("owner+family@example.test", "owner+*@example.test")).toBe(
			true,
		);
		expect(textMatchesAlias("other@example.test", "owner+*@example.test")).toBe(
			false,
		);
		expect(textMatchesAlias("owner+family", "owner+*@example.test")).toBe(true);
		expect(globToRegExp("a.b*").test("a.bc")).toBe(true);
		expect(mentionsVerificationSender('from "gitlab.com"', ["gitlab.com"])).toBe(
			true,
		);
		expect(mentionsVerificationSender("shop.example", ["gitlab.com"])).toBe(false);
		expect(routesToBlocked(sieve("a@example.test", "fin/spam"), ["spam"])).toBe(
			true,
		);
		expect(routesToBlocked(sieve("a@example.test", "fin/banking"), ["spam"])).toBe(
			false,
		);
		expect(globToRegExp("a.b*").test("axbc")).toBe(false);
		expect(globToRegExp("owner+*@example.test").test("owner+family@example.test")).toBe(
			true,
		);
		expect(mentionsVerificationSender("notgitlab.com", ["gitlab.com"])).toBe(false);
		expect(mentionsVerificationSender("notify@gitlab.com", ["gitlab.com"])).toBe(true);
		expect(keepFirstSatisfied(["+Owner", "Fin - Banking"], ["+Owner", "Shop"])).toBe(
			false,
		);
		expect(verificationSenders(["github.com", " github.com "])).toEqual([
			"github.com",
			"gitlab.com",
		]);
		expect(routesToBlocked('require ["fileinto"];\nDISCARD;\n', ["spam"])).toBe(true);
		expect(routesToBlocked(sieve("a@example.test", "spam"), ["spam"])).toBe(true);
	});

	test("checks create, update, revert, and pull sieves and ignores a reorder", () => {
		const body = sieve("owner+bot@example.test", "Spam");
		const issues = safetyIssues({
			actions: [
				{ op: "update-filter", id: "u", fromName: "Old", name: "Updated", enabled: true, sieve: body, changes: ["sieve"] },
				{ op: "revert-filter", id: "r", name: "Reverted", enabled: true, sieve: body },
				{ op: "pull-filter", id: "p", name: "Pulled", enabled: true, sieve: body },
				{ op: "reorder-filters", names: ["Updated"] },
				{ op: "delete-filter", id: "d", name: "Gone" },
			],
			notices: [],
			policy,
			keepFirst: [],
			desiredNames: ["Updated"],
		});
		expect(issues.map((issue) => issue.message)).toEqual([
			"Refusing to route protected plus-alias mail to Spam or Trash in Updated",
			"Refusing to route protected plus-alias mail to Spam or Trash in Reverted",
			"Refusing to route protected plus-alias mail to Spam or Trash in Pulled",
		]);
	});
});
