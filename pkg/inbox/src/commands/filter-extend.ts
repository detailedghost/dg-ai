import { getBooleanFlag, getListFlag, getStringFlag } from "../cli/args";
import { workspaceDirForContext, type CliContext } from "../cli/context";
import { printJson } from "../cli/output";
import { redactPublicValue } from "../privacy/redact";
import {
	createMailProviderClient,
	resolveProvider,
} from "../providers/factory";
import { readFilters, workspacePaths } from "../workspace/store";

const domainPattern =
	/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * Inserts sender domains into the first `address :domain :is "From"` test.
 * Leaves the rest of the Sieve script unchanged. Refuses scripts with no such test.
 */
export function extendSieveDomains(
	sieve: string,
	domains: string[],
): { sieve: string; added: string[]; alreadyPresent: string[] } {
	const match = /address\s+:domain\s+:is\s+"From"\s+(\[[^\]]*\]|"[^"]*")/i.exec(
		sieve,
	);
	if (!match?.[1]) {
		throw new Error(
			'Filter has no address :domain :is "From" test to extend. Refusing to rewrite an unrecognized Sieve script.',
		);
	}
	const existing = parseSieveStrings(match[1]);
	if (existing.length === 0) {
		throw new Error(
			"Filter domain test has no quoted domains. Refusing to rewrite it.",
		);
	}
	const added: string[] = [];
	const alreadyPresent: string[] = [];
	const next = [...existing];
	for (const domain of domains) {
		if (next.some((item) => item.toLowerCase() === domain)) {
			alreadyPresent.push(domain);
			continue;
		}
		next.push(domain);
		added.push(domain);
	}
	if (added.length === 0) {
		return { sieve, added, alreadyPresent };
	}
	const listText =
		next.length === 1
			? sieveString(next[0])
			: `[${next.map(sieveString).join(", ")}]`;
	const listStart = match.index + match[0].length - match[1].length;
	return {
		sieve:
			sieve.slice(0, listStart) +
			listText +
			sieve.slice(listStart + match[1].length),
		added,
		alreadyPresent,
	};
}

export async function extendFilter(context: CliContext): Promise<void> {
	const filterId = getStringFlag(context.args.flags, "filter-id");
	if (!filterId) {
		throw new Error("filters extend requires --filter-id <id>");
	}
	const domains = (getListFlag(context.args.flags, "add-domains") ?? []).map(
		(domain) => domain.toLowerCase(),
	);
	if (domains.length === 0) {
		throw new Error(
			"filters extend requires --add-domains <domain,domain>",
		);
	}
	for (const domain of domains) {
		if (!domainPattern.test(domain)) {
			throw new Error(`filters extend refused invalid domain: ${domain}`);
		}
	}
	const dryRunFlag = getBooleanFlag(context.args.flags, "dry-run");
	const confirm = getBooleanFlag(context.args.flags, "confirm");
	if (dryRunFlag && confirm) {
		throw new Error(
			"filters extend accepts either --dry-run or --confirm, not both",
		);
	}
	const dryRun = !confirm;
	const provider = resolveProvider(
		context.config,
		getStringFlag(context.args.flags, "provider"),
	);
	const client = createMailProviderClient(context.config, provider);
	try {
		if (!client.updateFilter) {
			throw new Error(
				`${provider} client cannot update a filter. filters extend needs a provider update.`,
			);
		}
		const liveFilters = await client.listFilters();
		const filter = liveFilters.find((item) => item.id === filterId);
		if (!filter) {
			throw new Error(`filter not found: ${filterId}`);
		}
		const sieve = filter.conditions[0] ?? filter.actions[0] ?? "";
		if (!sieve.trim()) {
			throw new Error(`filter ${filterId} has no Sieve body to extend`);
		}
		const extended = extendSieveDomains(sieve, domains);
		let mutated = false;
		if (!dryRun && extended.added.length > 0) {
			await client.updateFilter({
				id: filter.id,
				name: filter.name,
				sieve: extended.sieve,
				enabled: filter.enabled,
			});
			mutated = true;
		}
		const saved = await readSavedSieve(
			workspaceDirForContext(context),
			filterId,
		);
		printJson({
			kind: "workspace-filter-extend",
			dryRun,
			mutated,
			filterId: filter.id,
			name: publicText(filter.name),
			addedDomains: extended.added,
			alreadyPresent: extended.alreadyPresent,
			source: "live-filter",
			filtersJsonTruncated: saved !== undefined && saved !== sieve,
			before: publicText(sieve),
			after: publicText(extended.sieve),
			note: "The diff uses the live provider rule. filters.json keeps a redacted snippet and is not the source of this rewrite.",
		});
	} finally {
		await client.close?.();
	}
}

function parseSieveStrings(raw: string): string[] {
	return [...raw.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) =>
		match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
	);
}

function sieveString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function publicText(value: string): string {
	const redacted = redactPublicValue(value);
	return typeof redacted === "string" ? redacted : value;
}

async function readSavedSieve(
	dir: string,
	filterId: string,
): Promise<string | undefined> {
	try {
		const saved = await readFilters(workspacePaths(dir));
		const match = saved.find(
			(filter) =>
				filter &&
				typeof filter === "object" &&
				"id" in filter &&
				filter.id === filterId,
		);
		if (!match || typeof match !== "object") return undefined;
		const conditions = "conditions" in match ? match.conditions : undefined;
		const actions = "actions" in match ? match.actions : undefined;
		const parts = [
			...(Array.isArray(conditions) ? conditions : []),
			...(Array.isArray(actions) ? actions : []),
		].filter((part): part is string => typeof part === "string");
		return parts.join("\n");
	} catch {
		return undefined;
	}
}
