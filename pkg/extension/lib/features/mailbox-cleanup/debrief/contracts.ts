export type MailboxDebriefDownload = Readonly<{
	filename: string;
	mimeType: "text/plain;charset=utf-8";
	content: string;
}>;

export type MailboxDebriefResult = Readonly<{
	status: "downloaded" | "download_pending" | "download_failed";
	filename: string;
	content: string;
	downloadId?: number;
}>;

export type MailboxDebriefDownloadState =
	| "in_progress"
	| "complete"
	| "interrupted"
	| "missing";

export type MailboxDebriefCommand = Readonly<{
	planAlias: string;
	revisionAlias: string;
}>;

export type MailboxDebriefService = Readonly<{
	generate(input: unknown): Promise<MailboxDebriefResult>;
	regenerate(input: MailboxDebriefCommand): Promise<MailboxDebriefResult>;
}>;
