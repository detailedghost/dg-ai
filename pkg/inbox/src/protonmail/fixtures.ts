import type { ProtonDataset } from "./types";

export const emptyDataset: ProtonDataset = {
	folders: [],
	filters: [],
	messages: [],
};

export const demoDataset: ProtonDataset = {
	folders: [
		{ id: "inbox", name: "Inbox", type: "system", total: 3, unread: 1 },
		{ id: "receipts", name: "Receipts", type: "folder", total: 0, unread: 0 },
		{ id: "finance", name: "Finance", type: "folder", total: 0, unread: 0 },
		{ id: "work", name: "Work", type: "folder", total: 0, unread: 0 },
	],
	filters: [
		{
			id: "f_receipts",
			name: "Receipts",
			enabled: true,
			conditions: ["from contains receipt"],
			actions: ["move Receipts"],
		},
	],
	messages: [
		{
			id: "demo-1",
			from: "billing@stripe.com",
			senderName: "Stripe",
			subject: "Receipt for payment",
			snippet: "Payment received for invoice ending 1234.",
			folderId: "inbox",
			folderName: "Inbox",
			receivedAt: "2026-06-01T12:00:00Z",
		},
		{
			id: "demo-2",
			from: "alerts@bank.example",
			senderName: "Bank",
			subject: "Monthly statement is ready",
			snippet: "Your statement is available in online banking.",
			folderId: "inbox",
			folderName: "Inbox",
			receivedAt: "2026-06-02T12:00:00Z",
		},
		{
			id: "demo-3",
			from: "teammate@company.example",
			senderName: "Teammate",
			subject: "Project follow up",
			snippet: "Following up on the project notes.",
			folderId: "inbox",
			folderName: "Inbox",
			receivedAt: "2026-06-03T12:00:00Z",
		},
	],
};
