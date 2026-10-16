export type RepoRef = { host: string; owner: string; repo: string };

export type OpenPr = {
	url: string;
	headRefName: string;
	isDraft: boolean;
	createdAt: string;
};

export type RepoJobOutcome<T> =
	| { kind: "ok"; value: T }
	| { kind: "timeout" }
	| { kind: "aborted" }
	| { kind: "error"; error: unknown };
