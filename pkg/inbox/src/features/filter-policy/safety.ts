import { orderedFilters, type LiveFilter, type PlanAction, type PlanNotice } from "./plan";
import {
	fileintoDestination,
	flattenCommands,
	parseCommands,
	sieveLooksTruncated,
	type SieveCommand,
	type SieveTest,
} from "./parse";

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
		| "unreadable-sieve"
		| "unresolved-drift"
		| "order";
	message: string;
};

export const requiredVerificationSenders = ["github.com", "gitlab.com"];
export const requiredBlockedDestinations = ["spam", "trash"];
const unseenScriptCommands = ["include", "global", "return"];

export function safetyIssues(input: {
	actions: PlanAction[];
	notices: PlanNotice[];
	policy: SafetyPolicy;
	keepFirst: string[];
	liveFilters: LiveFilter[];
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
	const protectedMail = alias ? protectedClass(alias) : undefined;
	const senderMail = senderClass(senders);
	for (const filter of effectiveFilters(input)) {
		if (sieveLooksTruncated(filter.sieve)) {
			issues.push({
				code: "truncated-sieve",
				message: `Refusing to write a truncated sieve for ${filter.name}`,
			});
			continue;
		}
		const routes = blockedRoutes(filter.sieve, blocked);
		if (!routes) {
			issues.push({
				code: "unreadable-sieve",
				message: `Refusing to write ${filter.name}: its sieve has a form the safety check cannot read`,
			});
			continue;
		}
		if (!filter.enabled) continue;
		if (
			protectedMail &&
			routes.some((route) => canMatch(route, protectedMail))
		) {
			issues.push({
				code: "protected-destination",
				message: `Refusing to route protected plus-alias mail to Spam or Trash in ${filter.name}`,
			});
		}
		if (routes.some((route) => canMatch(route, senderMail))) {
			issues.push({
				code: "verification-destination",
				message: `Refusing to route verification mail to Spam or Trash in ${filter.name}`,
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
	if (!keepFirstSatisfied(projectedNames(input), input.keepFirst)) {
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

export function routesToBlocked(sieve: string, blocked: string[]): boolean {
	return blockedRoutes(sieve, blocked)?.length !== 0;
}

type Route = SieveTest[];

type MailClass = {
	headers: string[];
	envelopeParts: string[];
	all: string[];
	localpart: string[];
	domain: string[];
};

type KeyedTest = {
	source: "address" | "header" | "envelope";
	names: string[];
	keys: string[];
	match: "is" | "contains" | "matches";
	part: "all" | "localpart" | "domain";
};

function blockedRoutes(sieve: string, blocked: string[]): Route[] | undefined {
	const commands = parseCommands(sieve);
	if (!commands) return undefined;
	const routes: Route[] = [];
	let readable = true;
	const walk = (list: SieveCommand[], conditions: SieveTest[]): void => {
		for (const command of list) {
			if (unseenScriptCommands.includes(command.name)) readable = false;
			if (command.name === "discard") routes.push(conditions);
			if (command.name === "fileinto") {
				const path = fileintoDestination(command);
				if (path === undefined) readable = false;
				else if (isBlockedPath(path, blocked)) routes.push(conditions);
			}
			if (command.block) {
				walk(
					command.block,
					command.test ? [...conditions, command.test] : conditions,
				);
			}
		}
	};
	walk(commands, []);
	return readable ? routes : undefined;
}

function isBlockedPath(path: string, blocked: string[]): boolean {
	const full = path.toLowerCase();
	const last = full.split("/").filter(Boolean).at(-1) ?? full;
	return blocked.some((item) => item === full || item === last);
}

function canMatch(route: Route, mail: MailClass): boolean {
	return !route.some((test) => excludes(test, mail));
}

function protectedClass(alias: string): MailClass {
	const at = alias.lastIndexOf("@");
	return {
		headers: ["to", "cc", "bcc", "delivered-to", "x-original-to", "resent-to"],
		envelopeParts: ["to"],
		all: [alias],
		localpart: [at === -1 ? alias : alias.slice(0, at)],
		domain: [at === -1 ? "*" : alias.slice(at + 1)],
	};
}

function senderClass(domains: string[]): MailClass {
	return {
		headers: ["from", "sender", "return-path", "reply-to"],
		envelopeParts: ["from"],
		all: domains.flatMap((domain) => [`*@${domain}`, `*@*.${domain}`]),
		localpart: ["*"],
		domain: domains.flatMap((domain) => [domain, `*.${domain}`]),
	};
}

function excludes(test: SieveTest, mail: MailClass): boolean {
	if (test.name === "false") return true;
	if (test.name === "allof") return test.tests.some((t) => excludes(t, mail));
	if (test.name === "anyof") return test.tests.every((t) => excludes(t, mail));
	if (test.name === "not") return test.tests.every((t) => covers(t, mail));
	return false;
}

function covers(test: SieveTest, mail: MailClass): boolean {
	if (test.name === "true") return true;
	if (test.name === "allof") return test.tests.every((t) => covers(t, mail));
	if (test.name === "anyof") return test.tests.some((t) => covers(t, mail));
	if (test.name === "not") return test.tests.every((t) => excludes(t, mail));
	const keyed = readKeyed(test);
	if (!keyed || keyed.match === "is") return false;
	const known = keyed.source === "envelope" ? mail.envelopeParts : mail.headers;
	if (!known.every((name) => keyed.names.includes(name))) return false;
	return patternsOf(keyed, mail).every((pattern) =>
		keyed.keys.some((key) =>
			keyed.match === "contains"
				? containsLiteral(pattern, key)
				: globIsSubset(pattern, key),
		),
	);
}

function readKeyed(test: SieveTest): KeyedTest | undefined {
	if (
		test.name !== "address" &&
		test.name !== "header" &&
		test.name !== "envelope"
	) {
		return undefined;
	}
	let match: KeyedTest["match"] = "is";
	let part: KeyedTest["part"] = "all";
	const positional: string[][] = [];
	for (let index = 0; index < test.args.length; index += 1) {
		const arg = test.args[index];
		if (arg?.type === "string") {
			positional.push(arg.values);
		} else if (arg?.type === "tag" && arg.name === "comparator") {
			const next = index + 1 < test.args.length ? test.args[index + 1] : undefined;
			if (
				next?.type !== "string" ||
				next.values.length !== 1 ||
				next.values[0]?.toLowerCase() !== "i;ascii-casemap"
			) {
				return undefined;
			}
			index += 1;
		} else if (
			arg?.type === "tag" &&
			(arg.name === "is" || arg.name === "contains" || arg.name === "matches")
		) {
			match = arg.name;
		} else if (
			arg?.type === "tag" &&
			(arg.name === "all" || arg.name === "localpart" || arg.name === "domain")
		) {
			part = arg.name;
		} else {
			return undefined;
		}
	}
	const [names, keys] = positional;
	if (positional.length !== 2 || !names || !keys) return undefined;
	return {
		source: test.name,
		names: names.map((name) => name.toLowerCase()),
		keys,
		match,
		part,
	};
}

function patternsOf(keyed: KeyedTest, mail: MailClass): string[] {
	if (keyed.source === "header") return mail.all.map((glob) => `*${glob}*`);
	return mail[keyed.part];
}

function containsLiteral(inner: string, key: string): boolean {
	if (inner.includes("?")) return false;
	const body = `.*${escapeRegExp(key)}.*`;
	return new RegExp(`^${body}$`, "i").test(inner.replaceAll("*", "\u0001"));
}

export function globIsSubset(inner: string, outer: string): boolean {
	if (inner.includes("?") || outer.includes("?")) return false;
	return globToRegExp(outer).test(inner.replaceAll("*", "\u0001"));
}

function effectiveFilters(input: {
	actions: PlanAction[];
	liveFilters: LiveFilter[];
}): Array<{ name: string; sieve: string; enabled: boolean }> {
	const written = input.actions.flatMap(
		(action) => writtenFilter(action) ?? [],
	);
	if (!reshapesChain(input)) return written;
	const replaced = new Set(written.flatMap((filter) => filter.key ?? []));
	const deleted = new Set(
		input.actions.flatMap((action) =>
			action.op === "delete-filter" ? action.id : [],
		),
	);
	const staying = input.liveFilters.filter(
		(filter) =>
			filter.enabled && !replaced.has(filter.id) && !deleted.has(filter.id),
	);
	return [...written, ...staying];
}

function reshapesChain(input: {
	actions: PlanAction[];
	liveFilters: LiveFilter[];
}): boolean {
	const guards = new Set(
		input.liveFilters
			.filter((filter) => guardsChain(filter.sieve))
			.map((filter) => filter.id),
	);
	return input.actions.some((action) => {
		if (action.op === "reorder-filters") return guards.size > 0;
		return (
			(action.op === "delete-filter" ||
				action.op === "update-filter" ||
				action.op === "revert-filter") &&
			guards.has(action.id)
		);
	});
}

export function guardsChain(sieve: string): boolean {
	const commands = parseCommands(sieve);
	if (!commands) return true;
	return flattenCommands(commands).some(
		(command) =>
			command.name === "keep" ||
			command.name === "stop" ||
			unseenScriptCommands.includes(command.name),
	);
}

function projectedNames(input: {
	actions: PlanAction[];
	liveFilters: LiveFilter[];
}): string[] {
	const reorder = input.actions.find((action) => action.op === "reorder-filters");
	if (reorder) return reorder.names;
	const pull = input.actions.find((action) => action.op === "pull-filter-order");
	const rank = (id: string): number => {
		if (!pull) return 0;
		const index = pull.ids.indexOf(id);
		return index < 0 ? pull.ids.length : index;
	};
	const renamed = new Map(
		input.actions.flatMap((action) => {
			const written = writtenFilter(action);
			return written?.key ? [[written.key, written.name] as const] : [];
		}),
	);
	const deleted = new Set(
		input.actions.flatMap((action) =>
			action.op === "delete-filter" ? action.id : [],
		),
	);
	const created = input.actions.flatMap((action) =>
		action.op === "create-filter" ? action.name : [],
	);
	const ordered = pull
		? [...input.liveFilters].sort((left, right) => rank(left.id) - rank(right.id))
		: orderedFilters(input.liveFilters);
	return [
		...ordered
			.filter((filter) => !deleted.has(filter.id))
			.map((filter) => renamed.get(filter.id) ?? filter.name),
		...created,
	];
}

export function keepFirstSatisfied(
	names: string[],
	keepFirst: string[],
): boolean {
	if (keepFirst.length === 0) return true;
	return keepFirst.every((name, index) => names[index] === name);
}

export function globToRegExp(glob: string): RegExp {
	const marked = glob.replaceAll("*", "\u0000");
	const body = escapeRegExp(marked).replaceAll("\u0000", ".*");
	return new RegExp(`^${body}$`, "i");
}

function writtenFilter(
	action: PlanAction,
): { name: string; sieve: string; enabled: boolean; key?: string } | undefined {
	if (action.op === "create-filter") {
		return {
			name: action.name,
			sieve: action.sieve,
			enabled: action.enabled,
			key: action.ref,
		};
	}
	if (
		action.op === "update-filter" ||
		action.op === "revert-filter" ||
		action.op === "pull-filter"
	) {
		return {
			name: action.name,
			sieve: action.sieve,
			enabled: action.enabled,
			key: action.id,
		};
	}
	return undefined;
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
