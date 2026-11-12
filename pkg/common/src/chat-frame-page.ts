import { chatFrameRules, createChatFrameValidator, PAGE_RELAY_WIRE } from "./chat-format";

export const PAGE_CHAT_FRAME_RULES = chatFrameRules(PAGE_RELAY_WIRE);

/** Validates a frame for the chat and board pages, which never receive pw-ext relay frames. */
export const validatePageChatFrame = createChatFrameValidator(PAGE_CHAT_FRAME_RULES);
