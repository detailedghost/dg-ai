import { nanoid } from "nanoid";
import { fromDomain } from "../privacy/redact";
import { readJsonFile } from "../utils/json";
import type {
	MailAccessClient,
	MailAttachment,
	MailDraftInput,
	MailMessage,
	MailPage,
	MailQuery,
	MailReplyDraftInput,
} from "./types";

const DRAFT_NOT_FOUND = "draft was already sent or is not a draft";
const FIXTURE_SENDER = "me@example.test";

type MailFixtureDataset = {
	messages: MailMessage[];
};

type MailFixtureState = {
	messages: MailMessage[];
};

const stateByDataPath = new Map<string, MailFixtureState>();

async function loadState(dataPath: string): Promise<MailFixtureState> {
	const existing = stateByDataPath.get(dataPath);
	if (existing) return existing;
	const dataset = await readJsonFile<MailFixtureDataset>(dataPath);
	const state: MailFixtureState = {
		messages: dataset.messages.map((message) => ({ ...message })),
	};
	stateByDataPath.set(dataPath, state);
	return state;
}

function matchesQuery(message: MailMessage, query: MailQuery): boolean {
	if (query.folderId && message.folderId.toLowerCase() !== query.folderId.toLowerCase())
		return false;
	if (query.unread && message.isRead) return false;
	if (
		query.since &&
		new Date(message.receivedAt).getTime() < new Date(query.since).getTime()
	)
		return false;
	if (query.from && fromDomain(message.from).toLowerCase() !== query.from.toLowerCase())
		return false;
	if (
		query.subject &&
		!message.subject.toLowerCase().includes(query.subject.toLowerCase())
	)
		return false;
	if (
		query.text &&
		!`${message.subject} ${message.text}`.toLowerCase().includes(query.text.toLowerCase())
	)
		return false;
	return true;
}

function paginate(messages: MailMessage[], query: MailQuery): MailPage {
	const start = query.page * query.limit;
	return {
		messages: messages.slice(start, start + query.limit),
		hasMore: start + query.limit < messages.length,
	};
}

function draftFrom(fields: {
	to: string[];
	cc: string[];
	subject: string;
	text: string;
}): MailMessage {
	return {
		id: `draft-${nanoid()}`,
		from: FIXTURE_SENDER,
		to: fields.to,
		cc: fields.cc,
		subject: fields.subject,
		receivedAt: new Date().toISOString(),
		folderId: "drafts",
		isRead: true,
		hasAttachments: false,
		text: fields.text,
		attachments: [],
	};
}

/** Reads the fixture dataset and serves every verb from an in-memory, per-process copy; it never writes the file. */
export class FileMailAccessClient implements MailAccessClient {
	private readonly dataPath: string;

	constructor(input: { dataPath: string }) {
		this.dataPath = input.dataPath;
	}

	async listMessages(query: MailQuery): Promise<MailPage> {
		const state = await loadState(this.dataPath);
		const matched = state.messages
			.filter((message) => matchesQuery(message, query))
			.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
		return paginate(matched, query);
	}

	async searchMessages(query: MailQuery): Promise<MailPage> {
		return this.listMessages(query);
	}

	async getMessage(id: string): Promise<MailMessage> {
		const state = await loadState(this.dataPath);
		const message = state.messages.find((entry) => entry.id === id);
		if (!message) throw new Error(`mail fixture message not found: ${id}`);
		return message;
	}

	async listAttachments(id: string): Promise<MailAttachment[]> {
		return (await this.getMessage(id)).attachments;
	}

	async createDraft(input: MailDraftInput): Promise<MailMessage> {
		const state = await loadState(this.dataPath);
		const draft = draftFrom(input);
		state.messages.push(draft);
		return draft;
	}

	async createReplyDraft(input: MailReplyDraftInput): Promise<MailMessage> {
		const state = await loadState(this.dataPath);
		const original = state.messages.find((entry) => entry.id === input.messageId);
		if (!original)
			throw new Error(`mail fixture message not found: ${input.messageId}`);
		const to = [original.from];
		const cc = input.replyAll ? [...original.to, ...original.cc] : input.cc;
		const subject = /^re:/i.test(original.subject)
			? original.subject
			: `Re: ${original.subject}`;
		const draft = draftFrom({ to, cc, subject, text: input.text });
		state.messages.push(draft);
		return draft;
	}

	async getDraft(id: string): Promise<MailMessage> {
		const message = await this.getMessage(id);
		if (message.folderId !== "drafts") throw new Error(DRAFT_NOT_FOUND);
		return message;
	}

	async sendDraft(id: string): Promise<void> {
		const state = await loadState(this.dataPath);
		const message = state.messages.find((entry) => entry.id === id);
		if (!message || message.folderId !== "drafts") throw new Error(DRAFT_NOT_FOUND);
		message.folderId = "sent";
	}

	async close(): Promise<void> {}
}
