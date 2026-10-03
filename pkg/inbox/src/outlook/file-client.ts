import { fileMessagePages } from "../providers/file-paging";
import { emptyOutlookDataset } from "./fixtures";
import type { ListMessagesInput, MailProviderClient } from "../providers/types";
import type { OutlookDataset, OutlookMessageSummary } from "./types";

export class FileBackedOutlookClient implements MailProviderClient {
	readonly provider = "outlook" as const;

	private dataset?: OutlookDataset;

	constructor(
		private readonly input: {
			dataPath?: string;
			dataset?: OutlookDataset;
		} = {},
	) {
		this.dataset = input.dataset;
	}

	async listFolders() {
		return (await this.loadDataset()).folders;
	}

	async listFilters() {
		return (await this.loadDataset()).filters;
	}

	async listMessages(
		input: ListMessagesInput,
	): Promise<OutlookMessageSummary[]> {
		const messages: OutlookMessageSummary[] = [];
		for await (const page of this.listMessagesStream(input))
			messages.push(...page);
		return messages;
	}
	async *listMessagesStream(
		input: ListMessagesInput,
	): AsyncGenerator<OutlookMessageSummary[]> {
		if (input.limit <= 0) return;
		yield* fileMessagePages(await this.loadDataset(), input);
	}

	async moveMessages(): Promise<void> {
		throw new Error(
			"File-backed Outlook client is read-only. Use a live Graph client for confirmed moves.",
		);
	}

	async markMessagesRead(): Promise<void> {
		throw new Error(
			"File-backed Outlook client is read-only. Use a live Graph client for confirmed read-state updates.",
		);
	}

	private async loadDataset(): Promise<OutlookDataset> {
		if (this.dataset) {
			return this.dataset;
		}
		if (!this.input.dataPath) {
			this.dataset = structuredClone(emptyOutlookDataset);
			return this.dataset;
		}

		const file = Bun.file(this.input.dataPath);
		if (!(await file.exists())) {
			throw new Error(`Outlook data file not found: ${this.input.dataPath}`);
		}
		this.dataset = (await file.json()) as OutlookDataset;
		return this.dataset;
	}
}
