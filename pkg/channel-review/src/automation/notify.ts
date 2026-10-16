import { describeError } from "@dg/common";
import type { ChannelConfig } from "../config";
import type { Log } from "../engine";
import type { ChatProvider } from "../providers/types";

const MAX_TEXT = 400;
const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/g;
const LONG_TOKEN = /[A-Za-z0-9_\-+=]{32,}/g;
const URL_QUERY = /(https?:\/\/[^\s?#]+)\?[^\s#]*/g;

export type Notify = (text: string, link?: string) => Promise<void>;

export function redact(text: string): string {
	const clean = text
		.replace(URL_QUERY, "$1")
		.replace(EMAIL, "[email]")
		.replace(LONG_TOKEN, "[redacted]");
	return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1)}…` : clean;
}

export function createNotifier({
	provider,
	config,
	log,
}: {
	provider: ChatProvider;
	config: ChannelConfig;
	log: Log;
}): Notify {
	const { target } = config.automation.notify;
	return async (text, link) => {
		const body = link === undefined ? redact(text) : `${redact(text)}\n${link}`;
		try {
			if (target === "owner") await provider.dm({ text: body });
			else await provider.reply({ chatId: target, text: body });
		} catch (error) {
			log.warn(`notification failed: ${describeError(error)}`);
		}
	};
}
