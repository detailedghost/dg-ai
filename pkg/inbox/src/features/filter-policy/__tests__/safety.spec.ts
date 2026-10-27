import { describe, expect, test } from "bun:test";
import type { LiveFilter, PlanAction, PlanNotice } from "../plan";
import {
	blockedDestinations,
	globIsSubset,
	globToRegExp,
	keepFirstSatisfied,
	routesToBlocked,
	safetyIssues,
	verificationSenders,
	type SafetyIssue,
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

function create(name: string, body: string, ref?: string): PlanAction {
	return { op: "create-filter", ref, name, enabled: true, sieve: body };
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
			liveFilters: [],
		});
		expect(
			issues.filter((issue) => issue.code === "protected-destination"),
		).toHaveLength(7);
		expect(
			issues.filter((issue) => issue.code === "verification-destination")
				.length,
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
			liveFilters: [],
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
			liveFilters: [],
		});
		expect(issues.map((issue) => issue.code)).toEqual([
			"protected-destination",
			"verification-destination",
		]);
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
			liveFilters: [],
		});
		expect(truncated.map((issue) => issue.code)).toContain("truncated-sieve");
		const blank = safetyIssues({
			actions: [],
			notices: [],
			policy: { ...policy, protectedPlusAlias: "  " },
			keepFirst: [],
			liveFilters: [],
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
			liveFilters: [],
		});
		expect(unresolved.map((issue) => issue.code)).toEqual([
			"unresolved-drift",
			"order",
		]);
		expect(keepFirstSatisfied(["+Owner", "Fin - Banking"], ["+Owner"])).toBe(
			true,
		);
		expect(keepFirstSatisfied(["Fin - Banking"], [])).toBe(true);
		expect(keepFirstSatisfied(["Fin - Banking"], ["+Owner"])).toBe(false);
	});

	test("matches globs, destinations, and leading order", () => {
		expect(globToRegExp("a.b*").test("a.bc")).toBe(true);
		expect(globToRegExp("a.b*").test("axbc")).toBe(false);
		expect(
			globToRegExp("owner+*@example.test").test("owner+family@example.test"),
		).toBe(true);
		expect(routesToBlocked(sieve("a@example.test", "fin/spam"), ["spam"])).toBe(
			true,
		);
		expect(
			routesToBlocked(sieve("a@example.test", "fin/banking"), ["spam"]),
		).toBe(false);
		expect(routesToBlocked('require ["fileinto"];\nDISCARD;\n', ["spam"])).toBe(
			true,
		);
		expect(routesToBlocked(sieve("a@example.test", "spam"), ["spam"])).toBe(
			true,
		);
		expect(routesToBlocked('fileinto "${x}";', ["spam"])).toBe(true);
		expect(routesToBlocked("if true {", ["spam"])).toBe(true);
		expect(
			keepFirstSatisfied(["+Owner", "Fin - Banking"], ["+Owner", "Shop"]),
		).toBe(false);
		expect(verificationSenders(["github.com", " github.com "])).toEqual([
			"github.com",
			"gitlab.com",
		]);
	});

	test("nests globs", () => {
		expect(globIsSubset("owner+*@example.test", "*@example.test")).toBe(true);
		expect(globIsSubset("owner+*@example.test", "owner+*@example.test")).toBe(
			true,
		);
		expect(globIsSubset("owner+*@example.test", "owner+a*@example.test")).toBe(
			false,
		);
		expect(globIsSubset("owner+*@example.test", "owner+?@example.test")).toBe(
			false,
		);
		expect(globIsSubset("owner+a@example.test", "owner+?@example.test")).toBe(
			false,
		);
	});

	test("checks create, update, revert, and pull sieves and ignores a reorder", () => {
		const body = sieve("owner+bot@example.test", "Spam");
		const issues = safetyIssues({
			actions: [
				{
					op: "update-filter",
					id: "u",
					fromName: "Old",
					name: "Updated",
					enabled: true,
					sieve: body,
					changes: ["sieve"],
				},
				{
					op: "revert-filter",
					id: "r",
					name: "Reverted",
					enabled: true,
					sieve: body,
				},
				{
					op: "pull-filter",
					id: "p",
					name: "Pulled",
					enabled: true,
					sieve: body,
				},
				{ op: "reorder-filters", names: ["Updated"] },
				{ op: "delete-filter", id: "d", name: "Gone" },
			],
			notices: [],
			policy,
			keepFirst: [],
			liveFilters: [],
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

	describe("keep-first order", () => {
		const live = (id: string, name: string): LiveFilter => ({
			id,
			name,
			enabled: true,
			sieve: "keep;",
		});
		const orderCodes = (
			actions: PlanAction[],
			liveFilters: LiveFilter[],
		): string[] =>
			safetyIssues({
				actions,
				notices: [],
				policy,
				keepFirst: ["Owner"],
				liveFilters,
			}).flatMap((issue) => (issue.code === "order" ? [issue.code] : []));

		test("blocks a pulled filter order that puts Owner after Work", () => {
			expect(
				orderCodes(
					[{ op: "pull-filter-order", ids: ["w", "o"] }],
					[live("w", "Work"), live("o", "Owner")],
				),
			).toEqual(["order"]);
		});

		test("allows a pulled filter order that keeps Owner first", () => {
			expect(
				orderCodes(
					[{ op: "pull-filter-order", ids: ["o", "w"] }],
					[live("o", "Owner"), live("w", "Work")],
				),
			).toEqual([]);
		});

		test("projects a pulled order from the action ids, not the response order", () => {
			expect(
				orderCodes(
					[{ op: "pull-filter-order", ids: ["w", "o"] }],
					[live("o", "Owner"), live("w", "Work")],
				),
			).toEqual(["order"]);
			expect(
				orderCodes(
					[{ op: "pull-filter-order", ids: ["o", "w"] }],
					[live("w", "Work"), live("o", "Owner")],
				),
			).toEqual([]);
		});

		test("checks the reorder action names over the declared names", () => {
			expect(
				orderCodes(
					[{ op: "reorder-filters", names: ["Work", "Owner"] }],
					[live("o", "Owner"), live("w", "Work")],
				),
			).toEqual(["order"]);
		});
	});

	describe("what mail a rule can match", () => {
		const plain: {
			notices: PlanNotice[];
			policy: SafetyPolicy;
			keepFirst: string[];
			liveFilters: LiveFilter[];
		} = {
			notices: [],
			liveFilters: [],
			policy: { ...policy, verificationSenders: [] },
			keepFirst: [],
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

		test("treats asterisks in :contains keys as literal text", () => {
			expect(
				codes(
					spam(
						'allof(not envelope :contains "to" "*", not envelope :contains "from" "*")',
					),
				),
			).toEqual(both);
		});

		test("blocks an unconditional Spam or Trash rule on both protections", () => {
			expect(codes('fileinto "Spam";')).toEqual(both);
			expect(
				codes('require ["fileinto"];\nif true {\n fileinto "trash";\n}'),
			).toEqual(both);
			expect(codes("discard;")).toEqual(both);
		});

		test("blocks address :matches and :contains that reach the protected pattern", () => {
			expect(
				codes(spam('address :matches "To" "owner+*@example.test"')),
			).toEqual(both);
			expect(codes(spam('address :matches "To" "*@example.test"'))).toEqual(
				both,
			);
			expect(codes(spam('address :contains "To" "owner+"'))).toEqual(both);
			expect(codes(spam('address :localpart :is "To" "owner+bot"'))).toEqual(
				both,
			);
			expect(codes(spam('address :domain :is "To" "example.test"'))).toEqual(
				both,
			);
			expect(
				codes(
					spam(
						'address :comparator "i;ascii-casemap" :is "To" "Owner+X@example.test"',
					),
				),
			).toEqual(both);
			expect(
				codes(spam('envelope :to :is "to" "owner+bot@example.test"')),
			).toEqual(both);
			expect(
				codes(
					spam('address :all :is ["Subject", "To"] "owner+bot@example.test"'),
				),
			).toEqual(both);
		});

		test("blocks a positive recipient test, since another recipient can carry the alias", () => {
			expect(codes(spam('address :is "To" "shop@example.test"'))).toEqual(both);
			expect(
				codes(spam('address :matches "To" "shop+*@example.test"')),
			).toEqual(both);
			expect(codes(spam('address :domain :is "To" "other.test"'))).toEqual(
				both,
			);
			expect(codes(spam('address :localpart :is "To" "shop"'))).toEqual(both);
			expect(codes(spam('header :is "To" "shop@other.test"'))).toEqual(both);
			expect(codes(spam('envelope :is "to" "shop@other.test"'))).toEqual(both);
			expect(
				codes(
					spam(
						'allof(address :is "To" "shop@example.test", header :contains "From" "news")',
					),
				),
			).toEqual(both);
		});

		test("treats a test it cannot analyze as able to match", () => {
			expect(codes(spam('header :contains "To" "shop"'))).toEqual(both);
			expect(codes(spam('header :is "To" "owner+bot@example.test"'))).toEqual(
				both,
			);
			expect(codes(spam('address :regex "To" "shop"'))).toEqual(both);
			expect(
				codes(
					spam('address :count "ge" :comparator "i;ascii-numeric" "To" "1"'),
				),
			).toEqual(both);
			expect(codes(spam('address :is "X-Other" "shop@example.test"'))).toEqual(
				both,
			);
			expect(
				codes(spam('address :is ["To", "X-Other"] "shop@example.test"')),
			).toEqual(both);
			expect(codes(spam('address :is "To"'))).toEqual(both);
			expect(codes(spam("size :over 100K"))).toEqual(both);
			expect(codes(spam('exists "To"'))).toEqual(both);
			expect(codes(spam('header :contains "Subject" "sale"'))).toEqual(both);
		});

		test("combines tests with allof, anyof, and not", () => {
			const other = 'address :is "To" "shop@example.test"';
			const mine = 'address :matches "To" "owner+*@example.test"';
			const toAll =
				'["To", "Cc", "Bcc", "Delivered-To", "X-Original-To", "Resent-To"]';
			const mineAll = `address :matches ${toAll} "owner+*@example.test"`;
			const sender = 'address :domain :is "From" "github.com"';
			expect(codes(spam(`allof(${other}, ${mine})`))).toEqual(both);
			expect(
				codes(spam(`allof(header :contains "Subject" "x", ${other})`)),
			).toEqual(both);
			expect(codes(spam(`allof(false, ${other})`))).toEqual([]);
			expect(codes(spam(`anyof(${other}, ${mine})`))).toEqual(both);
			expect(codes(spam(`anyof(${other}, ${other})`))).toEqual(both);
			expect(codes(spam(`not ${mine}`))).toEqual(both);
			expect(codes(spam(`not ${mineAll}`))).toEqual([
				"verification-destination",
			]);
			expect(codes(spam(`not header :contains "to" "me+"`))).toEqual(both);
			expect(codes(spam(`not address :matches "to" "*"`))).toEqual(both);
			expect(
				codes(spam(`not address :matches ${toAll} "*@example.test"`)),
			).toEqual(["verification-destination"]);
			expect(codes(spam(`not address :contains ${toAll} "@"`))).toEqual([
				"verification-destination",
			]);
			expect(
				codes(spam(`not address :matches "To" "owner+a*@example.test"`)),
			).toEqual(both);
			expect(
				codes(spam(`not address :is "To" "owner+*@example.test"`)),
			).toEqual(both);
			expect(codes(spam(`not address :matches "X-Other" "*"`))).toEqual(both);
			expect(
				codes(spam(`not address :matches "To" "owner+?@example.test"`)),
			).toEqual(both);
			expect(codes(spam(`not header :matches ${toAll} "*"`))).toEqual([
				"verification-destination",
			]);
			expect(codes(spam(`not not ${other}`))).toEqual(both);
			expect(codes(spam(`not not ${mine}`))).toEqual(both);
			expect(codes(spam(`not size :over 5`))).toEqual(both);
			expect(codes(spam(`not true`))).toEqual([]);
			expect(
				codes(spam(`not anyof(${sender}, address :matches ${toAll} "*")`)),
			).toEqual(["verification-destination"]);
			expect(
				codes(spam(`not allof(true, address :matches ${toAll} "*")`)),
			).toEqual(["verification-destination"]);
			expect(
				codes(spam(`not anyof(false, address :matches ${toAll} "*")`)),
			).toEqual(["verification-destination"]);
			expect(
				codes(spam(`not allof(address :matches "To" "*", ${sender})`)),
			).toEqual(both);
			expect(codes(spam("false"))).toEqual([]);
			expect(codes(spam("true"))).toEqual(both);
		});

		test("blocks verification senders reached by address, header, and envelope tests", () => {
			const only = ["verification-destination"];
			const toAll =
				'["To", "Cc", "Bcc", "Delivered-To", "X-Original-To", "Resent-To"]';
			const nobody = `not address :matches ${toAll} "*"`;
			expect(
				codes(
					spam(`allof(${nobody}, address :domain :is "From" "github.com")`),
				),
			).toEqual(only);
			expect(
				codes(spam(`allof(${nobody}, address :matches "From" "*@github.com")`)),
			).toEqual(only);
			expect(
				codes(spam(`allof(${nobody}, address :contains "From" "github")`)),
			).toEqual(only);
			expect(
				codes(
					spam(`allof(${nobody}, address :matches "From" "*@*.github.com")`),
				),
			).toEqual(only);
			expect(
				codes(
					spam(`allof(${nobody}, address :localpart :is "From" "noreply")`),
				),
			).toEqual(only);
			expect(
				codes(spam(`allof(${nobody}, header :contains "From" "hub")`)),
			).toEqual(only);
			expect(
				codes(spam(`allof(${nobody}, header :matches "From" "*github.com*")`)),
			).toEqual(only);
			expect(
				codes(spam(`allof(${nobody}, envelope :is "from" "ci@gitlab.com")`)),
			).toEqual(only);
			expect(
				codes(spam(`allof(${nobody}, address :is "Reply-To" "ci@gitlab.com")`)),
			).toEqual(only);
			expect(
				codes(spam(`allof(${nobody}, address :is "Sender" "ci@gitlab.com")`)),
			).toEqual(only);
			expect(
				codes(
					spam(`allof(${nobody}, address :is "Return-Path" "ci@gitlab.com")`),
				),
			).toEqual(only);
			expect(
				codes(spam(`allof(${nobody}, address :is "From" "a@shop.test")`)),
			).toEqual(only);
			expect(
				codes(spam(`allof(${nobody}, address :domain :is "From" "shop.test")`)),
			).toEqual(only);
			expect(
				codes(spam(`allof(${nobody}, address :matches "From" "*@shop.test")`)),
			).toEqual(only);
			expect(
				codes(spam(`allof(${nobody}, envelope :is "to" "a@shop.test")`)),
			).toEqual(only);
			expect(
				codes(
					spam(`allof(${nobody}, address :is "From" "a@security.example")`),
					{
						policy,
					},
				),
			).toEqual(only);
		});

		test("handles else and elsif branches without losing a matching condition", () => {
			const other = 'address :is "To" "shop@example.test"';
			const body = `if ${other} { keep; } else { fileinto "Spam"; }`;
			expect(codes(body)).toEqual(both);
			const nobody =
				'not address :matches ["To", "Cc", "Bcc", "Delivered-To", "X-Original-To", "Resent-To"] "*"';
			const chain = `if ${nobody} { keep; } elsif ${nobody} { fileinto "Spam"; }`;
			expect(codes(chain)).toEqual(["verification-destination"]);
			const nested = `if true { if ${nobody} { fileinto "Spam"; } }`;
			expect(codes(nested)).toEqual(["verification-destination"]);
		});

		test("blocks fileinto tagged forms and refuses a form it cannot read", () => {
			expect(codes('fileinto :copy "Spam";')).toEqual(both);
			expect(codes('fileinto :create :copy "Spam";')).toEqual(both);
			expect(codes('fileinto :copy :flags "\\\\Seen" "trash";')).toEqual(both);
			expect(codes('fileinto :copy "inbox";')).toEqual([]);
			expect(codes('fileinto :mailboxid "x" "inbox";')).toEqual([
				"unreadable-sieve",
			]);
			expect(codes('fileinto "${folder}";')).toEqual(["unreadable-sieve"]);
			expect(codes("if true {\n fileinto")).toEqual(["truncated-sieve"]);
			expect(codes("keep keep {\n}")).toEqual(["unreadable-sieve"]);
		});

		test("refuses a script that runs an include", () => {
			expect(
				codes('require ["include"];\ninclude :personal "other";\n'),
			).toEqual(["unreadable-sieve"]);
			expect(codes('require ["include"];\nif true { include "other"; }')).toEqual([
				"unreadable-sieve",
			]);
			expect(codes('require ["include"];\nkeep;\n')).toEqual([]);
		});

		test("excludes a rule only when a negated test covers every header of the protected or sender class", () => {
			const toAll =
				'["To", "Cc", "Bcc", "Delivered-To", "X-Original-To", "Resent-To"]';
			const fromAll = '["From", "Sender", "Return-Path", "Reply-To"]';
			const protectedOnly = ["protected-destination"];
			const senderOnly = ["verification-destination"];
			expect(codes(spam(`not address :matches ${fromAll} "*"`))).toEqual(
				protectedOnly,
			);
			expect(
				codes(spam(`not address :localpart :matches ${fromAll} "*"`)),
			).toEqual(protectedOnly);
			expect(
				codes(spam(`not address :domain :matches ${fromAll} "*"`)),
			).toEqual(protectedOnly);
			expect(codes(spam(`not envelope :matches "from" "*"`))).toEqual(
				protectedOnly,
			);
			expect(codes(spam(`not envelope :matches "to" "*"`))).toEqual(senderOnly);
			expect(codes(spam(`not header :contains ${fromAll} "@"`))).toEqual(
				protectedOnly,
			);
			expect(
				codes(spam(`not address :localpart :matches ${toAll} "*"`)),
			).toEqual(senderOnly);
			expect(
				codes(spam(`not address :localpart :matches ${toAll} "owner+*"`)),
			).toEqual(senderOnly);
			expect(
				codes(spam(`not address :localpart :matches ${toAll} "other*"`)),
			).toEqual(both);
			expect(
				codes(spam(`not address :domain :matches ${toAll} "example.test"`)),
			).toEqual(senderOnly);
			expect(
				codes(spam(`not address :domain :matches ${toAll} "other.test"`)),
			).toEqual(both);
			expect(codes(spam(`not address :matches ${toAll} "*"`))).toEqual(
				senderOnly,
			);
			expect(
				codes(spam(`not header :matches ${toAll} "*owner+*@example.test*"`)),
			).toEqual(senderOnly);
			expect(codes(spam(`not header :matches ${toAll} "*other*"`))).toEqual(
				both,
			);
			expect(
				codes(spam(`not address :matches ${toAll} "*"`), {
					policy: { ...plain.policy, protectedPlusAlias: "owner+*" },
				}),
			).toEqual(senderOnly);
			expect(
				codes(spam(`not address :domain :matches ${toAll} "x.test"`), {
					policy: { ...plain.policy, protectedPlusAlias: "owner+*" },
				}),
			).toEqual(both);
			expect(
				codes(spam(`not address :localpart :matches ${toAll} "owner+*"`), {
					policy: { ...plain.policy, protectedPlusAlias: "owner+*" },
				}),
			).toEqual(senderOnly);
		});

		test("explains each blocking issue", () => {
			const messages = (
				body: string,
				over: Partial<typeof plain> = {},
			): string[] =>
				safetyIssues({
					...plain,
					...over,
					actions: [create("Rule", body)],
				}).map((issue) => issue.message);
			expect(messages("if true {\n fileinto")).toEqual([
				"Refusing to write a truncated sieve for Rule",
			]);
			expect(messages("keep keep {\n}")).toEqual([
				"Refusing to write Rule: its sieve has a form the safety check cannot read",
			]);
			expect(
				messages("keep;", {
					policy: { ...plain.policy, protectedPlusAlias: "" },
				}),
			).toEqual([
				"Set policy.safety.protectedPlusAlias before applying. The pattern lives in the declared filters file.",
			]);
			expect(
				messages("keep;", { keepFirst: ["A", "B"] }),
			).toEqual(["Declared filters must start with A, B"]);
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
		const riskySieve = 'require ["fileinto"];\nfileinto "Spam";\n';
		const live = (
			id: string,
			sieve: string,
			over: Partial<LiveFilter> = {},
		): LiveFilter => ({ id, name: id, enabled: true, sieve, ...over });
		const update = (
			id: string,
			sieve: string,
			enabled = true,
		): PlanAction => ({
			op: "update-filter",
			id,
			fromName: id,
			name: id,
			enabled,
			sieve,
			changes: enabled ? ["sieve"] : ["enabled"],
		});
		const codesOf = (input: Partial<Parameters<typeof safetyIssues>[0]>) =>
			safetyIssues({
				...base,
				actions: [],
				liveFilters: [],
				...input,
			}).map((issue) => issue.code);
		const both: SafetyIssue["code"][] = [
			"protected-destination",
			"verification-destination",
		];

		test("checks an unchanged Spam rule that a reorder moves past a keep filter", () => {
			const issues = safetyIssues({
				...base,
				actions: [{ op: "reorder-filters", names: ["Risky", "Safe"] }],
				liveFilters: [live("safe", "keep;"), live("Risky", riskySieve)],
			});
			expect(issues.map((issue) => issue.code)).toEqual(both);
			expect(issues[0]?.message).toContain("Risky");
		});

		test("fails keepFirst when a withheld delete leaves another filter first", () => {
			const lead = [live("old", "keep;", { name: "Retired", sequence: 1 }), live("guard", "keep;", { name: "Guard", sequence: 2 })];
			const withheld: PlanNotice = { op: "delete-withheld", target: "filter", id: "old", name: "Retired" };
			expect(codesOf({ keepFirst: ["Guard"], notices: [withheld], liveFilters: lead })).toEqual(["order"]);
			expect(
				codesOf({
					keepFirst: ["Guard"],
					actions: [{ op: "delete-filter", id: "old", name: "Retired" }],
					liveFilters: lead,
				}),
			).toEqual([]);
		});

		test("checks keepFirst against the renamed live name", () => {
			const lead = [live("g", "keep;", { name: "Guard", sequence: 1 })];
			expect(
				codesOf({
					keepFirst: ["Guard"],
					actions: [
						{
							op: "update-filter",
							id: "g",
							fromName: "Guard",
							name: "Other",
							enabled: true,
							sieve: "keep;",
							changes: ["name"],
						},
					],
					liveFilters: lead,
				}),
			).toEqual(["order"]);
		});

		test("checks an unchanged Spam rule when a delete removes a keep filter", () => {
			expect(
				codesOf({
					actions: [{ op: "delete-filter", id: "gone", name: "Gone" }],
					liveFilters: [live("gone", "keep;"), live("risky", riskySieve)],
				}),
			).toEqual(both);
		});

		test("checks an unchanged Spam rule when a filter that runs an include is deleted", () => {
			expect(
				codesOf({
					actions: [{ op: "delete-filter", id: "gone", name: "Gone" }],
					liveFilters: [
						live("gone", 'require ["include"];\ninclude :personal "other";\n'),
						live("risky", riskySieve),
					],
				}),
			).toEqual(both);
		});

		test("checks an unchanged Spam rule when a stop filter is disabled", () => {
			expect(
				codesOf({
					actions: [update("lead", "stop;", false)],
					liveFilters: [live("lead", "stop;"), live("risky", riskySieve)],
				}),
			).toEqual(both);
		});

		test("checks an unchanged Spam rule when a keep filter is edited", () => {
			expect(
				codesOf({
					actions: [update("lead", "# edited\nkeep;")],
					liveFilters: [live("lead", "keep;"), live("risky", riskySieve)],
				}),
			).toEqual(both);
		});

		test("checks a reverted keep filter against the rule below it", () => {
			expect(
				codesOf({
					actions: [
						{
							op: "revert-filter",
							id: "lead",
							name: "lead",
							enabled: false,
							sieve: "keep;",
						},
					],
					liveFilters: [live("lead", "keep;"), live("risky", riskySieve)],
				}),
			).toEqual(both);
		});

		test("stays narrow when the edited filter has no keep or stop", () => {
			expect(
				codesOf({
					actions: [update("lead", "# edited\nfileinto \"Work\";")],
					liveFilters: [live("lead", 'fileinto "Work";'), live("risky", riskySieve)],
				}),
			).toEqual([]);
		});

		test("stays narrow when the plan only creates filters", () => {
			expect(
				codesOf({
					actions: [create("Safe", "keep;")],
					liveFilters: [live("lead", "keep;"), live("risky", riskySieve)],
				}),
			).toEqual([]);
		});

		test("keeps a withheld delete in the chain", () => {
			expect(
				codesOf({
					actions: [{ op: "delete-filter", id: "gone", name: "Gone" }],
					notices: [
						{ op: "delete-withheld", target: "filter", id: "risky", name: "risky" },
					],
					liveFilters: [live("gone", "keep;"), live("risky", riskySieve)],
				}),
			).toEqual(both);
		});

		test("drops an approved delete of a Spam rule from the chain", () => {
			expect(
				codesOf({
					actions: [
						{ op: "delete-filter", id: "gone", name: "Gone" },
						{ op: "delete-filter", id: "risky", name: "risky" },
					],
					liveFilters: [live("gone", "keep;"), live("risky", riskySieve)],
				}),
			).toEqual([]);
		});

		test("skips destination checks for a written filter that is disabled", () => {
			expect(
				codesOf({
					actions: [update("risky", riskySieve, false)],
					liveFilters: [live("risky", riskySieve)],
				}),
			).toEqual([]);
			expect(
				codesOf({
					actions: [
						{
							op: "create-filter",
							name: "Off",
							enabled: false,
							sieve: riskySieve,
						},
					],
				}),
			).toEqual([]);
		});

		test("still rejects an unreadable sieve in a disabled written filter", () => {
			expect(
				codesOf({
					actions: [update("risky", "fileinto :bogus", false)],
					liveFilters: [live("risky", riskySieve)],
				}),
			).not.toEqual([]);
		});

		test("drops a disabled live Spam rule from the chain", () => {
			expect(
				codesOf({
					actions: [{ op: "delete-filter", id: "gone", name: "Gone" }],
					liveFilters: [
						live("gone", "keep;"),
						live("risky", riskySieve, { enabled: false }),
					],
				}),
			).toEqual([]);
		});

		test("replaces a live filter with its written version by id", () => {
			expect(
				codesOf({
					actions: [
						update("p1", "keep;"),
						{ op: "reorder-filters", names: ["Same", "Same"] },
					],
					liveFilters: [live("p1", "keep;"), live("p2", riskySieve)],
				}),
			).toEqual(both);
			expect(
				codesOf({
					actions: [
						update("p1", "keep;"),
						update("p2", "keep;"),
						{ op: "reorder-filters", names: ["Same", "Same"] },
					],
					liveFilters: [live("p1", "keep;"), live("p2", riskySieve)],
				}),
			).toEqual([]);
		});

		test("drops a reverted or pulled filter from the unchanged set by id", () => {
			for (const op of ["revert-filter", "pull-filter"] as const) {
				const issues = safetyIssues({
					...base,
					actions: [
						{ op, id: "p1", name: "Same", enabled: true, sieve: "keep;" },
						{ op: "reorder-filters", names: ["Same"] },
					],
					liveFilters: [live("p1", riskySieve)],
				});
				expect(issues).toEqual([]);
			}
		});

		test("uses the written sieve over the live one and reports each filter once", () => {
			const issues = safetyIssues({
				...base,
				actions: [
					update("a", 'require ["fileinto"];\nfileinto "inbox";\n'),
					create("Other", riskySieve, "new:2"),
					{ op: "reorder-filters", names: ["a", "Safe", "Other"] },
				],
				liveFilters: [live("a", riskySieve), live("s", "keep;")],
			});
			expect(issues.map((issue) => issue.message)).toEqual([
				"Refusing to route protected plus-alias mail to Spam or Trash in Other",
				"Refusing to route verification mail to Spam or Trash in Other",
			]);
		});

		test("passes a chain with no risky rule", () => {
			expect(
				codesOf({
					actions: [{ op: "reorder-filters", names: ["Safe"] }],
					liveFilters: [live("s", "keep;")],
				}),
			).toEqual([]);
		});

		test("fails closed when a live keep check cannot read the script", () => {
			expect(
				codesOf({
					actions: [{ op: "delete-filter", id: "gone", name: "Gone" }],
					liveFilters: [live("gone", "keep keep {\n}"), live("risky", riskySieve)],
				}),
			).toEqual(both);
		});
	});

	describe("comparators", () => {
		const toAll =
			'["To", "Cc", "Bcc", "Delivered-To", "X-Original-To", "Resent-To"]';
		const body = (comparator: string): string =>
			`require ["fileinto"];\nif not address ${comparator} :matches ${toAll} "OWNER+*@EXAMPLE.TEST" {\n  fileinto "Spam";\n}\n`;
		const run = (sieveBody: string): string[] =>
			safetyIssues({
				actions: [create("Rule", sieveBody)],
				notices: [],
				policy: { ...policy, verificationSenders: [] },
				keepFirst: [],
				liveFilters: [],
			}).map((issue) => issue.code);

		test("treats a case-sensitive comparator as not excluding lowercase protected mail", () => {
			expect(run(body(':comparator "i;octet"'))).toContain(
				"protected-destination",
			);
		});

		test("fails closed on an unknown comparator", () => {
			expect(run(body(':comparator "i;unknown"'))).toContain(
				"protected-destination",
			);
		});

		test("still reasons case-insensitively under i;ascii-casemap", () => {
			expect(run(body(':comparator "i;ascii-casemap"'))).not.toContain(
				"protected-destination",
			);
		});
	});
});
