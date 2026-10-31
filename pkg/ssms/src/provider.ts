import { UnsupportedCapability } from "./errors";
import type { SmsCapability, SmsProvider, SmsProviderId } from "./types";

export type ProviderOps = { [K in keyof SmsProvider]: SmsProvider[K] };

export function withCapabilities(
	id: SmsProviderId,
	capabilities: SmsProvider["capabilities"],
	impl: Omit<SmsProvider, "id" | "capabilities">,
): SmsProvider {
	const gate = async <T>(
		capability: SmsCapability,
		run: () => Promise<T>,
	): Promise<T> => {
		if (!capabilities[capability]) throw new UnsupportedCapability(id, capability);
		return run();
	};
	return {
		id,
		capabilities,
		link: (input) => gate("link", () => impl.link(input)),
		status: () => gate("status", () => impl.status()),
		listConversations: () =>
			gate("listConversations", () => impl.listConversations()),
		readRecent: (conversationId, limit) =>
			gate("readRecent", () => impl.readRecent(conversationId, limit)),
		receive: (input) => gate("receive", () => impl.receive(input)),
		archive: (input) => gate("archive", () => impl.archive(input)),
		blockAndReportSpam: (input) =>
			gate("blockAndReportSpam", () => impl.blockAndReportSpam(input)),
		draftReply: async (input) => {
			if (input.emoji !== undefined && !capabilities.reactions) {
				throw new UnsupportedCapability(id, "reactions");
			}
			if ((input.attachments?.length ?? 0) > 0 && !capabilities.attachments) {
				throw new UnsupportedCapability(id, "attachments");
			}
			if (input.quote !== undefined && !capabilities.quotes) {
				throw new UnsupportedCapability(id, "quotes");
			}
			return gate("draftReply", () => impl.draftReply(input));
		},
		sendDraft: (input) => gate("sendDraft", () => impl.sendDraft(input)),
	};
}
