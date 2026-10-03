import type { GmailDataset } from "./types";

export const emptyGmailDataset: GmailDataset = {
	folders: [
		{
			id: "INBOX",
			name: "Inbox",
			type: "system",
			path: "Inbox",
			aliases: ["inbox"],
			total: 0,
			unread: 0,
		},
		{
			id: "UNREAD",
			name: "Unread",
			type: "system",
			path: "Unread",
			aliases: ["unread"],
			total: 0,
			unread: 0,
		},
	],
	filters: [],
	messages: [],
};
