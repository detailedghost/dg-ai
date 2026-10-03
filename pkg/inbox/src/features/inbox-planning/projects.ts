import { orderBy, uniq } from "lodash-es";
import { z } from "zod";
import { getStringFlag } from "../../cli/args";
import type { CliContext } from "../../cli/context";
import { printJson, projectFields } from "../../cli/output";
import { workspaceDirForProfile } from "../../workspace/profile";
import { readMessageWorkItems, workspacePaths } from "../../workspace/store";
import type { MessageWorkItem } from "../../workspace/types";
import type {
	InboxProjectCandidate,
	InboxProjectCandidateSource,
	InboxProjectDiscoveryOptions,
	InboxProjectDiscoveryResult,
} from "./types";

const discoveryOptionsSchema = z.object({
	limit: z.coerce.number().int().positive().max(500).default(50),
	minCount: z.coerce.number().int().positive().max(1000).default(2),
	sampleLimit: z.coerce.number().int().nonnegative().max(20).default(3),
	domain: z.string().trim().min(1).optional(),
	domainContains: z.string().trim().min(1).optional(),
});

const exactProjectDomainHints = new Set([
	"app.lucid.co",
	"appfire.com",
	"asana.com",
	"email.figma.com",
	"figma.com",
	"github.com",
	"go.asana.com",
	"scribehow.com",
	"sharepointonline.com",
]);

const projectKeywordPattern =
	/\b(add-in|admin consent|architecture|automation|deployment|excel|figma|front[ -]?end|investor|jira|lucid|portal|project|replication|review|snowflake|system change|system update|uat)\b/i;
const weakLeadingPattern =
	/^(action required|approved|canceled|completed|fw|fwd|in progress|re|request|scheduled maintenance|statuspage)\s*:?\s*/i;
const nonProjectPattern =
	/\b(admin consent request|log in|oauth application|password|personal access token|verification code|verify your account|your monthly scribe activity)\b/i;

type CandidateAccumulator = {
	name: string;
	count: number;
	domains: Set<string>;
	signals: Set<InboxProjectCandidateSource>;
	samples: InboxProjectCandidate["samples"];
};

export async function discoverInboxProjects(
	context: CliContext,
): Promise<void> {
	const paths = workspacePaths(
		workspaceDirForProfile({
			provider: context.config.provider,
			explicitDir: getStringFlag(context.args.flags, "dir"),
			accountProfile: getStringFlag(context.args.flags, "account-profile"),
		}),
	);
	const options = parseDiscoveryOptions(context);
	const items = (await readMessageWorkItems(paths)).filter((item) =>
		matchesProjectSelector(item, options),
	);
	const candidates = buildProjectCandidates(items, options);
	const rows = context.output.aiFields
		? candidates.map((candidate) =>
				projectFields(candidate, context.output.aiFields),
			)
		: candidates;
	const result: InboxProjectDiscoveryResult = {
		kind: "workspace-inbox-project-candidates",
		dir: paths.dir,
		totalMessages: items.length,
		candidates: rows as InboxProjectCandidate[],
		candidatesShown: candidates.length,
		options,
		warning:
			"Read-only discovery from redacted local message work items. No mailbox folders, labels, rules, or messages were changed.",
	};
	printJson(result);
}

export function buildProjectCandidates(
	items: MessageWorkItem[],
	options: Pick<
		InboxProjectDiscoveryOptions,
		"limit" | "minCount" | "sampleLimit"
	>,
): InboxProjectCandidate[] {
	const groups = new Map<string, CandidateAccumulator>();
	for (const item of items) {
		const candidatesForItem = new Map<
			string,
			{ name: string; sources: Set<InboxProjectCandidateSource> }
		>();
		for (const candidate of candidateNames(item)) {
			const key = candidate.name.toLowerCase();
			const group = candidatesForItem.get(key) ?? {
				name: candidate.name,
				sources: new Set<InboxProjectCandidateSource>(),
			};
			group.sources.add(candidate.source);
			candidatesForItem.set(key, group);
		}
		for (const candidate of candidatesForItem.values()) {
			addCandidate(
				groups,
				item,
				candidate.name,
				candidate.sources,
				options.sampleLimit,
			);
		}
	}

	return orderBy(
		[...groups.values()]
			.filter((candidate) => candidate.count >= options.minCount)
			.map((candidate) => ({
				name: candidate.name,
				count: candidate.count,
				score: scoreCandidate(candidate),
				domains: orderBy([...candidate.domains]),
				signals: orderBy([...candidate.signals]),
				samples: candidate.samples,
			})),
		["score", "count", "name"],
		["desc", "desc", "asc"],
	).slice(0, options.limit);
}

function parseDiscoveryOptions(
	context: CliContext,
): InboxProjectDiscoveryOptions {
	return discoveryOptionsSchema.parse({
		limit: context.args.flags.limit,
		minCount: context.args.flags["min-count"],
		sampleLimit: context.args.flags["sample-limit"],
		domain: context.args.flags.domain,
		domainContains: context.args.flags["domain-contains"],
	});
}

function matchesProjectSelector(
	item: MessageWorkItem,
	options: InboxProjectDiscoveryOptions,
): boolean {
	const domain = item.packet.fromDomain;
	if (options.domain && domain !== options.domain) {
		return false;
	}
	if (options.domainContains && !domain.includes(options.domainContains)) {
		return false;
	}
	return true;
}

function candidateNames(
	item: MessageWorkItem,
): { name: string; source: InboxProjectCandidateSource }[] {
	const subject = normalizeSubject(item.packet.subject);
	const domain = item.packet.fromDomain;
	const candidates: { name: string; source: InboxProjectCandidateSource }[] =
		[];

	if (nonProjectPattern.test(subject)) {
		return [];
	}

	if (isProjectDomainHint(domain)) {
		candidates.push({ name: subject, source: "domain" });
		for (const value of quotedValues(subject)) {
			candidates.push({ name: value, source: "subject" });
		}
	}
	if (projectKeywordPattern.test(subject)) {
		candidates.push({ name: subject, source: "keyword" });
	}
	for (const value of parentheticalValues(subject)) {
		if (projectKeywordPattern.test(value)) {
			candidates.push({ name: value, source: "parenthetical" });
		}
	}
	const normalized = candidates
		.map((candidate) => ({
			...candidate,
			name: normalizeCandidateName(candidate.name),
		}))
		.filter(
			(candidate) => candidate.name.length >= 4 && candidate.name.length <= 90,
		);
	const byName = new Map<
		string,
		{ name: string; sources: Set<InboxProjectCandidateSource> }
	>();
	for (const candidate of normalized) {
		const key = candidate.name.toLowerCase();
		const group = byName.get(key) ?? {
			name: candidate.name,
			sources: new Set<InboxProjectCandidateSource>(),
		};
		group.sources.add(candidate.source);
		byName.set(key, group);
	}
	return [...byName.values()].flatMap((candidate) =>
		[...candidate.sources].map((source) => ({ name: candidate.name, source })),
	);
}

function isProjectDomainHint(domain: string): boolean {
	return (
		exactProjectDomainHints.has(domain) || domain.endsWith(".atlassian.net")
	);
}

function addCandidate(
	groups: Map<string, CandidateAccumulator>,
	item: MessageWorkItem,
	name: string,
	sources: Set<InboxProjectCandidateSource>,
	sampleLimit: number,
): void {
	const key = name.toLowerCase();
	const group = groups.get(key) ?? {
		name,
		count: 0,
		domains: new Set<string>(),
		signals: new Set<InboxProjectCandidateSource>(),
		samples: [],
	};
	group.count += 1;
	group.domains.add(item.packet.fromDomain);
	for (const source of sources) {
		group.signals.add(source);
	}
	if (group.samples.length < sampleLimit) {
		group.samples.push({
			id: item.id,
			domain: item.packet.fromDomain,
			subject: item.packet.subject,
		});
	}
	groups.set(key, group);
}

function scoreCandidate(candidate: CandidateAccumulator): number {
	const signalWeight = candidate.signals.has("parenthetical")
		? 4
		: candidate.signals.has("domain")
			? 3
			: 2;
	const domainWeight = Math.min(candidate.domains.size, 4);
	return candidate.count * 10 + signalWeight + domainWeight;
}

function normalizeSubject(value: string): string {
	return value
		.replace(/\[[^\]]+\]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeCandidateName(value: string): string {
	let name = extractProjectPhrase(normalizeSubject(value))
		.replace(weakLeadingPattern, "")
		.replace(
			/\s+-\s+(assigned|commented|mentioned|updated|status changed|created).*/i,
			"",
		)
		.replace(/\s+\|\s+.*/g, "")
		.replace(/\s+#\d+\b/g, "")
		.replace(/^[("'`]+|[)"'`]+$/g, "")
		.trim();

	const parenthetical = parentheticalValues(name).find((candidate) =>
		projectKeywordPattern.test(candidate),
	);
	if (parenthetical && parenthetical.length < name.length) {
		name = parenthetical;
	}

	return titlePreservingAcronyms(name);
}

function parentheticalValues(value: string): string[] {
	return uniq(
		[...value.matchAll(/\(([^)]{4,90})\)/g)].map((match) =>
			normalizeSubject(match[1] ?? ""),
		),
	).filter(Boolean);
}

function quotedValues(value: string): string[] {
	return uniq(
		[...value.matchAll(/"([^"]{4,90})(?:"|$)/g)].map((match) =>
			normalizeSubject(match[1] ?? ""),
		),
	).filter(Boolean);
}

function extractProjectPhrase(value: string): string {
	const patterns = [
		/^meeting assets for (.+?) are ready!?$/i,
		/^.+? shared (.+?) in otter$/i,
		/^.+? replied to a thread in "?(.+?)"?$/i,
		/^.+? mentioned you in "?(.+?)"?$/i,
		/^.+? left a comment (?:for you )?(?:on|in) "?(.+?)"?$/i,
		/^.+? invited you to a project:\s*(.+)$/i,
	];
	for (const pattern of patterns) {
		const match = value.match(pattern);
		if (match?.[1]) {
			return normalizeSubject(match[1]);
		}
	}
	return value;
}

function titlePreservingAcronyms(value: string): string {
	return value
		.split(" ")
		.map((word) => {
			if (/^[A-Z0-9]{2,}$/.test(word)) {
				return word;
			}
			if (word.includes("-") || word.includes("/")) {
				return word;
			}
			return word.length > 3
				? `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`
				: word;
		})
		.join(" ");
}
