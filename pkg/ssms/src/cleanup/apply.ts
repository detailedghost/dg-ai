import { scopeDays } from "../config/parse";
import type { SmsCleanupConfig } from "../config/types";
import {
	classifyConversation,
	type Classification,
	type Classifiable,
} from "../classifier/classify";
import type { Conversation, SmsProvider } from "../types";

export interface CleanupAction extends Classification {
	applied: boolean;
}

export function inScope(item: { ageDays: number }, config: SmsCleanupConfig): boolean {
	const days = scopeDays(config.scope);
	return days === undefined || item.ageDays <= days;
}

export function planCleanup(
	items: Classifiable[],
	config: SmsCleanupConfig,
): Classification[] {
	return items.filter((item) => inScope(item, config)).map((item) => classifyConversation(item, config));
}

export function conversationToClassifiable(item: Conversation): Classifiable {
	return {
		id: item.id,
		sender: item.title,
		preview: item.preview,
		pinned: item.pinned,
		savedContact: item.savedContact,
		ageDays: item.ageDays,
	};
}

export async function applyCleanup(
	provider: SmsProvider,
	items: Conversation[],
	config: SmsCleanupConfig,
	dryRun: boolean,
): Promise<CleanupAction[]> {
	const plan = planCleanup(items.map(conversationToClassifiable), config);
	const actions: CleanupAction[] = [];
	for (const item of plan) {
		const act = !dryRun && !config.dry_run;
		if (act && item.disposition === "archive") {
			await provider.archive({ conversationId: item.id });
			actions.push({ ...item, applied: true });
			continue;
		}
		if (act && item.disposition === "spam") {
			await provider.blockAndReportSpam({ conversationId: item.id });
			actions.push({ ...item, applied: true });
			continue;
		}
		actions.push({ ...item, applied: false });
	}
	return actions;
}
