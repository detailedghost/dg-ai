import { fileMessagePages } from "../providers/file-paging";
import { nanoid } from "nanoid";
import { readJsonFile, stringifyJson } from "../utils/json";
import { emptyDataset } from "./fixtures";
import type {
	CreateProtonFilterInput,
	CreateProtonFolderInput,
	ListMessagesInput,
	ProtonDataset,
	ProtonMailClient,
	ProtonMessageSummary,
	UpdateProtonFilterInput,
} from "./types";

export class FileBackedProtonMailClient implements ProtonMailClient {
	readonly provider = "protonmail" as const;

	private readonly dataPath?: string;
	private dataset?: ProtonDataset;

	constructor(input: { dataPath?: string; dataset?: ProtonDataset } = {}) {
		this.dataPath = input.dataPath;
		this.dataset = input.dataset;
	}

	async close(): Promise<void> {}
	async listFolders() {
		return (await this.loadDataset()).folders;
	}

	async createFolder(input: CreateProtonFolderInput) {
		const dataset = await this.loadDataset();
		const existing = dataset.folders.find(
			(folder) =>
				folder.name.toLowerCase() === input.name.toLowerCase() ||
				folder.path?.toLowerCase() === input.name.toLowerCase(),
		);
		if (existing) {
			return existing;
		}
		const folder = {
			id: `folder-${nanoid()}`,
			name: input.name,
			path: input.name,
			type: input.type ?? "label",
			total: 0,
			unread: 0,
		};
		dataset.folders.push(folder);
		await this.persistDataset();
		return folder;
	}

	async listFilters() {
		return (await this.loadDataset()).filters;
	}

	async createFilter(input: CreateProtonFilterInput) {
		const dataset = await this.loadDataset();
		const filter = {
			id: `filter-${nanoid()}`,
			name: input.name,
			enabled: input.enabled !== false,
			conditions: [input.sieve],
			actions: [input.sieve],
		};
		dataset.filters.push(filter);
		await this.persistDataset();
		return filter;
	}

	async updateFilter(input: UpdateProtonFilterInput) {
		const dataset = await this.loadDataset();
		const index = dataset.filters.findIndex((filter) => filter.id === input.id);
		if (index < 0) {
			throw new Error(`Filter not found in file-backed dataset: ${input.id}`);
		}
		const filter = {
			...dataset.filters[index],
			name: input.name,
			enabled: input.enabled !== false,
			conditions: [input.sieve],
			actions: [input.sieve],
		};
		dataset.filters[index] = filter;
		await this.persistDataset();
		return filter;
	}

	async deleteFilter(input: { id: string }) {
		const dataset = await this.loadDataset();
		dataset.filters = dataset.filters.filter(
			(filter) => filter.id !== input.id,
		);
		await this.persistDataset();
	}

	async listMessages(
		input: ListMessagesInput,
	): Promise<ProtonMessageSummary[]> {
		const messages: ProtonMessageSummary[] = [];
		for await (const page of this.listMessagesStream(input))
			messages.push(...page);
		return messages;
	}
	async *listMessagesStream(
		input: ListMessagesInput,
	): AsyncGenerator<ProtonMessageSummary[]> {
		if (input.limit <= 0) return;
		yield* fileMessagePages(await this.loadDataset(), input);
	}

	async moveMessages(input: {
		messageIds: string[];
		targetFolderId: string;
	}): Promise<void> {
		const dataset = await this.loadDataset();
		const target = dataset.folders.find(
			(folder) => folder.id === input.targetFolderId,
		);
		if (!target) {
			throw new Error(
				`Target folder not found in file-backed dataset: ${input.targetFolderId}`,
			);
		}
		const ids = new Set(input.messageIds);
		for (const message of dataset.messages) {
			if (!ids.has(message.id)) {
				continue;
			}
			message.folderId = target.id;
			message.folderName = target.name;
		}
		await this.persistDataset();
	}

	async unlabelMessages(_input: {
		messageIds: string[];
		labelId: string;
	}): Promise<void> {
		// File-backed messages have one folder field, so moveMessages already removes the source folder.
	}

	async markMessagesRead(input: { messageIds: string[] }): Promise<void> {
		const dataset = await this.loadDataset();
		const ids = new Set(input.messageIds);
		for (const message of dataset.messages) {
			if (ids.has(message.id)) {
				message.read = true;
			}
		}
		await this.persistDataset();
	}

	private async loadDataset(): Promise<ProtonDataset> {
		if (this.dataset) {
			return this.dataset;
		}
		if (!this.dataPath) {
			this.dataset = structuredClone(emptyDataset);
			return this.dataset;
		}

		const file = Bun.file(this.dataPath);
		if (!(await file.exists())) {
			throw new Error(`Proton data file not found: ${this.dataPath}`);
		}
		this.dataset = await readJsonFile<ProtonDataset>(this.dataPath);
		return this.dataset;
	}

	private async persistDataset(): Promise<void> {
		if (!this.dataPath || !this.dataset) {
			return;
		}
		await Bun.write(this.dataPath, stringifyJson(this.dataset));
	}
}
