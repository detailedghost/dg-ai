import { chatFrameRules, createChatFrameValidator, PAGE_RELAY_WIRE } from "./chat-format";
import { PW_EXT_WIRE } from "./pw-ext-format";

export const CHAT_FRAME_RULES = chatFrameRules([...PAGE_RELAY_WIRE, PW_EXT_WIRE]);

export const CHAT_FRAME_TYPES = CHAT_FRAME_RULES.frameTypes;

export const INBOUND_FRAME_TYPES = CHAT_FRAME_RULES.inboundTypes;

export const validateChatFrame = createChatFrameValidator(CHAT_FRAME_RULES);
