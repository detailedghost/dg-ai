import type {
	ListMessagesInput,
	MailFolder,
	MailMessageSummary,
} from "./types";
export function* fileMessagePages<T extends MailMessageSummary>(
	dataset: { folders: MailFolder[]; messages: T[] },
	input: ListMessagesInput,
): Generator<T[]> {
	if (input.limit <= 0) return;
	const selector = (input.folderId ?? input.folderName)?.toLowerCase();
	const folders = new Map(dataset.folders.map((folder) => [folder.id, folder]));
	let page: T[] = [];
	let emitted = 0;
	for (const message of dataset.messages) {
		const folder = folders.get(message.folderId);
		if (
			selector &&
			message.folderId.toLowerCase() !== selector &&
			message.folderName?.toLowerCase() !== selector &&
			folder?.name.toLowerCase() !== selector &&
			folder?.path?.toLowerCase() !== selector &&
			!folder?.aliases?.some((alias) => alias.toLowerCase() === selector) &&
			!message.labels?.some((label) => label.toLowerCase() === selector)
		)
			continue;
		page.push(message);
		emitted++;
		if (page.length === 200 || emitted === input.limit) {
			yield page;
			page = [];
		}
		if (emitted >= input.limit) return;
	}
	if (page.length) yield page;
}
