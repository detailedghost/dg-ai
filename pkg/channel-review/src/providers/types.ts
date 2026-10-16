export type ChatSender = { id?: string; name?: string; isBot: boolean };

export type ChatMessage = {
	id: string;
	chatId: string;
	from: ChatSender;
	text: string;
	timestamp: string;
};

export type ChatReaction = {
	id: string;
	chatId: string;
	messageId: string;
	from: ChatSender;
	type: string;
	action: "added" | "removed";
	timestamp: string;
};

export type ChatEvent =
	| { type: "message"; eventId: string; message: ChatMessage }
	| { type: "reaction"; eventId: string; reaction: ChatReaction }
	| { type: "gap" };

export type AdaptiveCard = {
	type: "AdaptiveCard";
	version: "1.4";
	body: { type: "Image"; url: string; altText: string }[];
};

type ReactionRequest = { chatId: string; messageId: string; reactionId: string };

export type ChatProvider = {
	resolveChat(query: {
		chatId?: string;
		topic?: string;
	}): Promise<{ id: string; topic?: string }>;
	subscribe(request: {
		chatId: string;
		resumeId?: string;
		signal: AbortSignal;
	}): AsyncIterable<ChatEvent>;
	react(request: ReactionRequest): Promise<void>;
	unreact(request: ReactionRequest): Promise<void>;
	reply(request: {
		chatId: string;
		text: string;
		html?: boolean;
		card?: AdaptiveCard;
	}): Promise<{ messageIds: string[] }>;
	dm(request: { text: string; html?: boolean }): Promise<{ messageIds: string[] }>;
	listReactions(): Promise<string[]>;
};
