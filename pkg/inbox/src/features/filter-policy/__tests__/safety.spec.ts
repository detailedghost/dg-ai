import { describe, expect, test } from "bun:test";
import type { PlanAction, PlanNotice } from "../plan";
import {
	blockedDestinations,
	globIsSubset,
	globsIntersect,
	globToRegExp,
	keepFirstSatisfied,
	routesToBlocked,
	safetyIssues,
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
			desiredFilters: [],
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
			desiredFilters: [],
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
			desiredFilters: [],
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
			desiredFilters: [],
		});
		expect(truncated.map((issue) => issue.code)).toContain("truncated-sieve");
		const blank = safetyIssues({
			actions: [],
			notices: [],
			policy: { ...policy, protectedPlusAlias: "  " },
			keepFirst: [],
			desiredNames: [],
			desiredFilters: [],
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
			desiredFilters: [],
		});
		expect(unresolved.map((issue) => issue.code)).toEqual([
			"unresolved-drift",
			"order",
		]);
		expect(keepFirstSatisfied(["+Owner", "Fin - Banking"], ["+Owner"])).toBe(true);
		expect(keepFirstSatisfied(["Fin - Banking"], [])).toBe(true);
		expect(keepFirstSatisfied(["Fin - Banking"], ["+Owner"])).toBe(false);
	});

	test("matches globs, destinations, and leading order", () => {
		expect(globToRegExp("a.b*").test("a.bc")).toBe(true);
		expect(globToRegExp("a.b*").test("axbc")).toBe(false);
		expect(globToRegExp("owner+*@example.test").test("owner+family@example.test")).toBe(
			true,
		);
		expect(routesToBlocked(sieve("a@example.test", "fin/spam"), ["spam"])).toBe(
			true,
		);
		expect(routesToBlocked(sieve("a@example.test", "fin/banking"), ["spam"])).toBe(
			false,
		);
		expect(routesToBlocked('require ["fileinto"];\nDISCARD;\n', ["spam"])).toBe(true);
		expect(routesToBlocked(sieve("a@example.test", "spam"), ["spam"])).toBe(true);
		expect(routesToBlocked('fileinto "${x}";', ["spam"])).toBe(true);
		expect(routesToBlocked("if true {", ["spam"])).toBe(true);
		expect(keepFirstSatisfied(["+Owner", "Fin - Banking"], ["+Owner", "Shop"])).toBe(
			false,
		);
		expect(verificationSenders(["github.com", " github.com "])).toEqual([
			"github.com",
			"gitlab.com",
		]);
	});

	test("intersects and nests globs", () => {
		expect(globsIntersect("owner+*@example.test", "owner+bot@example.test")).toBe(true);
		expect(globsIntersect("owner+*@example.test", "OWNER+*@EXAMPLE.TEST")).toBe(true);
		expect(globsIntersect("*@example.test", "owner+*@*.test")).toBe(true);
		expect(globsIntersect("owner+*", "other*")).toBe(false);
		expect(globsIntersect("a?c", "abc")).toBe(true);
		expect(globsIntersect("a?c", "ab")).toBe(false);
		expect(globsIntersect("abc", "abcd")).toBe(false);
		expect(globsIntersect("abcd", "abc")).toBe(false);
		expect(globsIntersect("*", "")).toBe(true);
		expect(globsIntersect("", "*")).toBe(true);
		expect(globsIntersect("a*", "*b")).toBe(true);
		expect(globsIntersect("*a", "*b")).toBe(false);
		expect(globsIntersect("*a", "b*")).toBe(true);
		expect(globsIntersect("*x*", "abc")).toBe(false);
		expect(globIsSubset("owner+*@example.test", "*@example.test")).toBe(true);
		expect(globIsSubset("owner+*@example.test", "owner+*@example.test")).toBe(true);
		expect(globIsSubset("owner+*@example.test", "owner+a*@example.test")).toBe(false);
		expect(globIsSubset("owner+*@example.test", "owner+?@example.test")).toBe(false);
		expect(globIsSubset("owner+a@example.test", "owner+?@example.test")).toBe(false);
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
			desiredFilters: [],
		});
		expect(
			issues
				.filter((issue) => issue.code === "protected-destination")
				.map((issue) => issue.message),
		).toEqual([
			"Refusing to route protected plus-alias mail to Spam or Trash in Updated",
			"Refusing to route protected plus-alias mail to Spam or Trash in Reverted",
			"Refusing to route protected plus-alias mail to Spam or Trash in Pulled",
		]);
	});

	describe("what mail a rule can match", () => {
		const plain: {
			notices: PlanNotice[];
			policy: SafetyPolicy;
			keepFirst: string[];
			desiredNames: string[];
			desiredFilters: Array<{ name: string; sieve: string }>;
		} = {
			notices: [],
			desiredFilters: [],
			policy: { ...policy, verificationSenders: [] },
			keepFirst: [],
			desiredNames: [],
		};
		const codes = (body: string, over: Partial<typeof plain> = {}): string[] =>
			safetyIssues({
				...plain,
				...over,
				actions: [create("Rule", body)],
			}).map((issue) => issue.code);
		const spam = (test: string): string =>
			`require ["fileinto"];\nif ${test} {\n  fileinto "Spam";\n}\n`;
		const both = ["protected-destination", "verification-destination"];

		test("blocks an unconditional Spam or Trash rule on both protections", () => {
			expect(codes('fileinto "Spam";')).toEqual(both);
			expect(codes('require ["fileinto"];\nif true {\n fileinto "trash";\n}')).toEqual(
				both,
			);
			expect(codes("discard;")).toEqual(both);
		});

		test("blocks address :matches and :contains that reach the protected pattern", () => {
			expect(codes(spam('address :matches "To" "owner+*@example.test"'))).toEqual(
				both,
			);
			expect(codes(spam('address :matches "To" "*@example.test"'))).toEqual(both);
			expect(codes(spam('address :contains "To" "owner+"'))).toEqual(both);
			expect(codes(spam('address :localpart :is "To" "owner+bot"'))).toEqual(both);
			expect(codes(spam('address :domain :is "To" "example.test"'))).toEqual(both);
			expect(
				codes(spam('address :comparator "i;ascii-casemap" :is "To" "Owner+X@example.test"')),
			).toEqual(both);
			expect(codes(spam('envelope :to :is "to" "owner+bot@example.test"'))).toEqual(
				both,
			);
			expect(codes(spam('address :all :is ["Subject", "To"] "owner+bot@example.test"'))).toEqual(
				both,
			);
		});

		test("allows a Spam rule whose recipient test cannot reach the protected pattern", () => {
			const other = 'address :is "To" "shop@example.test"';
			expect(codes(spam(other))).toEqual(["verification-destination"]);
			expect(codes(spam('address :matches "To" "shop+*@example.test"'))).toEqual([
				"verification-destination",
			]);
			expect(codes(spam('address :domain :is "To" "other.test"'))).toEqual([
				"verification-destination",
			]);
			expect(codes(spam('address :localpart :is "To" "shop"'))).toEqual([
				"verification-destination",
			]);
			expect(codes(spam('header :is "To" "shop@other.test"'))).toEqual([
				"verification-destination",
			]);
			expect(codes(spam('envelope :is "to" "shop@other.test"'))).toEqual([
				"verification-destination",
			]);
		});

		test("treats a test it cannot analyze as able to match", () => {
			expect(codes(spam('header :contains "To" "shop"'))).toEqual(both);
			expect(codes(spam('header :is "To" "owner+bot@example.test"'))).toEqual(both);
			expect(codes(spam('address :regex "To" "shop"'))).toEqual(both);
			expect(codes(spam('address :count "ge" :comparator "i;ascii-numeric" "To" "1"'))).toEqual(both);
			expect(codes(spam('address :is "X-Other" "shop@example.test"'))).toEqual(both);
			expect(codes(spam('address :is ["To", "X-Other"] "shop@example.test"'))).toEqual(both);
			expect(codes(spam('address :is "To"'))).toEqual(both);
			expect(codes(spam('size :over 100K'))).toEqual(both);
			expect(codes(spam('exists "To"'))).toEqual(both);
			expect(codes(spam('header :contains "Subject" "sale"'))).toEqual(both);
		});

		test("combines tests with allof, anyof, and not", () => {
			const other = 'address :is "To" "shop@example.test"';
			const mine = 'address :matches "To" "owner+*@example.test"';
			const toAll = '["To", "Cc", "Bcc", "Delivered-To", "X-Original-To", "Resent-To"]';
			const mineAll = `address :matches ${toAll} "owner+*@example.test"`;
			const sender = 'address :domain :is "From" "github.com"';
			expect(codes(spam(`allof(${other}, ${mine})`))).toEqual(["verification-destination"]);
			expect(codes(spam(`allof(header :contains "Subject" "x", ${other})`))).toEqual([
				"verification-destination",
			]);
			expect(codes(spam(`anyof(${other}, ${mine})`))).toEqual(both);
			expect(codes(spam(`anyof(${other}, ${other})`))).toEqual([
				"verification-destination",
			]);
			expect(codes(spam(`not ${mine}`))).toEqual(both);
			expect(codes(spam(`not ${mineAll}`))).toEqual(["verification-destination"]);
			expect(codes(spam(`not header :contains "to" "me+"`))).toEqual(both);
			expect(codes(spam(`not address :matches "to" "*"`))).toEqual(both);
			expect(codes(spam(`not address :matches ${toAll} "*@example.test"`))).toEqual([
				"verification-destination",
			]);
			expect(codes(spam(`not address :contains ${toAll} "@"`))).toEqual([
				"verification-destination",
			]);
			expect(codes(spam(`not address :matches "To" "owner+a*@example.test"`))).toEqual(both);
			expect(codes(spam(`not address :is "To" "owner+*@example.test"`))).toEqual(both);
			expect(codes(spam(`not address :matches "X-Other" "*"`))).toEqual(both);
			expect(codes(spam(`not address :matches "To" "owner+?@example.test"`))).toEqual(both);
			expect(codes(spam(`not header :matches ${toAll} "*"`))).toEqual(
				["verification-destination"],
			);
			expect(codes(spam(`not not ${other}`))).toEqual(["verification-destination"]);
			expect(codes(spam(`not not ${mine}`))).toEqual(both);
			expect(codes(spam(`not size :over 5`))).toEqual(both);
			expect(codes(spam(`not true`))).toEqual([]);
			expect(codes(spam(`not anyof(${sender}, address :matches ${toAll} "*")`))).toEqual([
				"verification-destination",
			]);
			expect(codes(spam(`not allof(true, address :matches ${toAll} "*")`))).toEqual(
				["verification-destination"],
			);
			expect(codes(spam(`not anyof(false, address :matches ${toAll} "*")`))).toEqual(
				["verification-destination"],
			);
			expect(codes(spam(`not allof(address :matches "To" "*", ${sender})`))).toEqual(both);
			expect(codes(spam("false"))).toEqual([]);
			expect(codes(spam("true"))).toEqual(both);
		});

		test("blocks verification senders reached by address, header, and envelope tests", () => {
			const only = ["verification-destination"];
			const nobody = 'address :is "To" "nobody@elsewhere.test"';
			expect(codes(spam(`allof(${nobody}, address :domain :is "From" "github.com")`))).toEqual(only);
			expect(codes(spam(`allof(${nobody}, address :matches "From" "*@github.com")`))).toEqual(only);
			expect(codes(spam(`allof(${nobody}, address :contains "From" "github")`))).toEqual(only);
			expect(codes(spam(`allof(${nobody}, address :matches "From" "*@*.github.com")`))).toEqual(only);
			expect(codes(spam(`allof(${nobody}, address :localpart :is "From" "noreply")`))).toEqual(only);
			expect(codes(spam(`allof(${nobody}, header :contains "From" "hub")`))).toEqual(only);
			expect(codes(spam(`allof(${nobody}, header :matches "From" "*github.com*")`))).toEqual(only);
			expect(codes(spam(`allof(${nobody}, envelope :is "from" "ci@gitlab.com")`))).toEqual(only);
			expect(codes(spam(`allof(${nobody}, address :is "Reply-To" "ci@gitlab.com")`))).toEqual(only);
			expect(codes(spam(`allof(${nobody}, address :is "Sender" "ci@gitlab.com")`))).toEqual(only);
			expect(codes(spam(`allof(${nobody}, address :is "Return-Path" "ci@gitlab.com")`))).toEqual(only);
			expect(codes(spam(`allof(${nobody}, address :is "From" "a@shop.test")`))).toEqual([]);
			expect(codes(spam(`allof(${nobody}, address :domain :is "From" "shop.test")`))).toEqual([]);
			expect(codes(spam(`allof(${nobody}, address :matches "From" "*@shop.test")`))).toEqual([]);
			expect(codes(spam(`allof(${nobody}, envelope :is "to" "a@shop.test")`))).toEqual(only);
			expect(
				codes(spam(`allof(${nobody}, address :is "From" "a@security.example")`), {
					policy,
				}),
			).toEqual(only);
		});

		test("handles else and elsif branches without losing a matching condition", () => {
			const other = 'address :is "To" "shop@example.test"';
			const body = `if ${other} { keep; } else { fileinto "Spam"; }`;
			expect(codes(body)).toEqual(both);
			const chain = `if ${other} { keep; } elsif ${other} { fileinto "Spam"; }`;
			expect(codes(chain)).toEqual(["verification-destination"]);
			const nested = `if true { if ${other} { fileinto "Spam"; } }`;
			expect(codes(nested)).toEqual(["verification-destination"]);
		});

		test("blocks fileinto tagged forms and refuses a form it cannot read", () => {
			expect(codes('fileinto :copy "Spam";')).toEqual(both);
			expect(codes('fileinto :create :copy "Spam";')).toEqual(both);
			expect(codes('fileinto :copy :flags "\\\\Seen" "trash";')).toEqual(both);
			expect(codes('fileinto :copy "inbox";')).toEqual([]);
			expect(codes('fileinto :mailboxid "x" "inbox";')).toEqual(["unreadable-sieve"]);
			expect(codes('fileinto "${folder}";')).toEqual(["unreadable-sieve"]);
			expect(codes("if true {\n fileinto")).toEqual(["truncated-sieve"]);
			expect(codes("keep keep {\n}")).toEqual(["unreadable-sieve"]);
		});

		test("checks a script without a require line", () => {
			expect(codes("keep;")).toEqual([]);
		});

		test("skips the protected check when no alias is configured", () => {
			expect(
				codes(spam('address :is "To" "owner+x@example.test"'), {
					policy: { ...plain.policy, protectedPlusAlias: "" },
				}),
			).toEqual(["alias-unconfigured", "verification-destination"]);
		});

		test("treats an alias with no domain as matching any domain", () => {
			expect(
				codes(spam('address :domain :is "To" "other.test"'), {
					policy: { ...plain.policy, protectedPlusAlias: "owner+*" },
				}),
			).toEqual(both);
		});
	});

	describe("effective filter chain", () => {
		const base = {
			notices: [],
			policy: { ...policy, verificationSenders: [] },
			keepFirst: [],
		};
		const risky = {
			name: "Risky",
			sieve: 'require ["fileinto"];\nfileinto "Spam";\n',
		};
		const safe = { name: "Safe", sieve: "keep;" };

		test("checks an unchanged Spam rule that a reorder-only plan moves", () => {
			const issues = safetyIssues({
				...base,
				actions: [{ op: "reorder-filters", names: ["Risky", "Safe"] }],
				desiredNames: ["Risky", "Safe"],
				desiredFilters: [safe, risky],
			});
			expect(issues.map((issue) => issue.code)).toEqual([
				"protected-destination",
				"verification-destination",
			]);
			expect(issues[0]?.message).toContain("Risky");
		});

		test("skips unchanged rules when the plan does not reorder", () => {
			const issues = safetyIssues({
				...base,
				actions: [create("Safe", safe.sieve)],
				desiredNames: ["Risky", "Safe"],
				desiredFilters: [risky, safe],
			});
			expect(issues).toEqual([]);
		});

		test("uses the written sieve over the declared one and reports each filter once", () => {
			const issues = safetyIssues({
				...base,
				actions: [
					create("Risky", 'require ["fileinto"];\nfileinto "inbox";\n'),
					create("Other", risky.sieve),
				],
				desiredNames: [],
				desiredFilters: [risky, safe, { name: "Other", sieve: risky.sieve }],
			});
			expect(issues.map((issue) => issue.message)).toEqual([
				"Refusing to route protected plus-alias mail to Spam or Trash in Other",
				"Refusing to route verification mail to Spam or Trash in Other",
			]);
		});

		test("passes a chain with no risky rule", () => {
			expect(
				safetyIssues({
					...base,
					actions: [{ op: "reorder-filters", names: ["Safe"] }],
					desiredNames: ["Safe"],
					desiredFilters: [safe],
				}),
			).toEqual([]);
		});
	});
});
