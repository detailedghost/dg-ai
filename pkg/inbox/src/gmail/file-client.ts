import { fileMessagePages } from "../providers/file-paging";
import { nanoid } from "nanoid";
import { readJsonFile, writeJsonFile } from "../utils/json";
import { emptyGmailDataset } from "./fixtures";
import type { ListMessagesInput, MailProviderClient } from "../providers/types";
import type {
	GmailDataset,
	GmailFilter,
	GmailLabel,
	GmailMessageSummary,
} from "./types";

export class FileBackedGmailClient implements MailProviderClient {
	readonly provider = "gmail" as const;
	private dataset?: GmailDataset;

	constructor(
		private readonly input: { dataPath?: string; dataset?: GmailDataset } = {},
	) {
		this.dataset = input.dataset;
	}

	async listFolders(): Promise<GmailLabel[]> {
		return (await this.loadDataset()).folders;
	}

	async createFolder(input: {
		name: string;
		type?: "folder" | "label";
	}): Promise<GmailLabel> {
		const dataset = await this.loadDataset();
		const existing = dataset.folders.find(
			(folder) =>
				same(folder.name, input.name) || same(folder.path ?? "", input.name),
		);
		if (existing) {
			return existing;
		}
		const label: GmailLabel = {
			id: `Label_${nanoid()}`,
			name: input.name,
			path: input.name,
			type: input.type ?? "label",
			total: 0,
			unread: 0,
		};
		dataset.folders.push(label);
		await this.persistDataset();
		return label;
	}

	async listFilters(): Promise<GmailFilter[]> {
		return (await this.loadDataset()).filters;
	}

	async createFilter(input: {
		name: string;
		criteria?: Record<string, unknown>;
		action?: Record<string, unknown>;
		enabled?: boolean;
	}): Promise<GmailFilter> {
		const dataset = await this.loadDataset();
		const filter: GmailFilter = {
			id: `Filter_${nanoid()}`,
			name: input.name,
			enabled: input.enabled !== false,
			conditions: input.criteria ? [JSON.stringify(input.criteria)] : [],
			actions: input.action ? [JSON.stringify(input.action)] : [],
		};
		dataset.filters.push(filter);
		await this.persistDataset();
		return filter;
	}

	async listMessages(input: ListMessagesInput): Promise<GmailMessageSummary[]> {
		const messages: GmailMessageSummary[] = [];
		for await (const page of this.listMessagesStream(input))
			messages.push(...page);
		return messages;
	}
	async *listMessagesStream(
		input: ListMessagesInput,
	): AsyncGenerator<GmailMessageSummary[]> {
		if (input.limit <= 0) return;
		yield* fileMessagePages(await this.loadDataset(), input);
	}

	async moveMessages(input: {
		messageIds: string[];
		targetFolderId: string;
	}): Promise<void> {
		await this.modifyLabels(input.messageIds, [input.targetFolderId], []);
	}

	async unlabelMessages(input: {
		messageIds: string[];
		labelId: string;
	}): Promise<void> {
		await this.modifyLabels(input.messageIds, [], [input.labelId]);
	}

	async markMessagesRead(input: { messageIds: string[] }): Promise<void> {
		await this.modifyLabels(input.messageIds, [], ["UNREAD"]);
		const dataset = await this.loadDataset();
		const ids = new Set(input.messageIds);
		for (const message of dataset.messages) {
			if (ids.has(message.id)) {
				message.read = true;
			}
		}
		await this.persistDataset();
	}

	private async modifyLabels(
		messageIds: string[],
		add: string[],
		remove: string[],
	): Promise<void> {
		const dataset = await this.loadDataset();
		const ids = new Set(messageIds);
		const removeSet = new Set(remove);
		for (const message of dataset.messages) {
			if (!ids.has(message.id)) {
				continue;
			}
			const labels = new Set(message.labels ?? [message.folderId]);
			for (const label of add) {
				labels.add(label);
			}
			for (const label of removeSet) {
				labels.delete(label);
			}
			message.labels = [...labels].sort();
			if (add.length > 0) {
				message.folderId = add[0];
				message.folderName =
					dataset.folders.find((folder) => folder.id === add[0])?.name ??
					add[0];
			}
		}
		await this.persistDataset();
	}

	private async loadDataset(): Promise<GmailDataset> {
		if (this.dataset) {
			return this.dataset;
		}
		if (!this.input.dataPath) {
			this.dataset = structuredClone(emptyGmailDataset);
			return this.dataset;
		}
		const file = Bun.file(this.input.dataPath);
		if (!(await file.exists())) {
			throw new Error(`Gmail data file not found: ${this.input.dataPath}`);
		}
		this.dataset = await readJsonFile<GmailDataset>(this.input.dataPath);
		return this.dataset;
	}

	private async persistDataset(): Promise<void> {
		if (!this.input.dataPath || !this.dataset) {
			return;
		}
		await writeJsonFile(this.input.dataPath, this.dataset);
	}
}

function same(left: string, right: string): boolean {
	return left.trim().toLowerCase() === right.trim().toLowerCase();
}
