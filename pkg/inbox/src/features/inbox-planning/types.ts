export type InboxProjectCandidateSource =
	| "domain"
	| "subject"
	| "parenthetical"
	| "keyword";

export type InboxProjectCandidate = {
	name: string;
	count: number;
	score: number;
	domains: string[];
	signals: InboxProjectCandidateSource[];
	samples: {
		id: string;
		domain: string;
		subject: string;
	}[];
};

export type InboxProjectDiscoveryOptions = {
	limit: number;
	minCount: number;
	sampleLimit: number;
	domain?: string;
	domainContains?: string;
};

export type InboxProjectDiscoveryResult = {
	kind: "workspace-inbox-project-candidates";
	dir: string;
	totalMessages: number;
	candidates: InboxProjectCandidate[];
	candidatesShown: number;
	options: InboxProjectDiscoveryOptions;
	warning: string;
};
