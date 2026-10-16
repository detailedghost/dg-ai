import type { MinLevel } from "../config";

export type SinkIssue = {
	id: string;
	title: string;
	service: string;
	env: string;
	level: MinLevel;
	firstSeen: string;
	lastSeen: string;
	link: string;
	regressed: boolean;
};

export type ErrorReport = SinkIssue & {
	message: string;
	stack?: string;
	repoTag?: string;
};

export type ErrorSink = {
	name: string;
	poll(request: {
		since: Date;
		signal: AbortSignal;
	}): Promise<{ issues: SinkIssue[]; cursor?: string }>;
	detail(issue: SinkIssue): Promise<ErrorReport>;
};
