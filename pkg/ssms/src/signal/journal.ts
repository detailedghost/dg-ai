import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Conversation, SmsMessage } from "../types";

function file(home: string, name: string): string {
	return join(home, "ssms", "signal", name);
}

function readJson<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

export function readJournal(home: string): SmsMessage[] {
	const messages = readJson<SmsMessage[]>(file(home, "journal.json"), []);
	return Array.isArray(messages) ? messages : [];
}

export function writeJournal(home: string, messages: SmsMessage[]): void {
	mkdirSync(join(home, "ssms", "signal"), { recursive: true });
	writeFileSync(file(home, "journal.json"), `${JSON.stringify(messages)}\n`);
}

export function appendJournal(home: string, incoming: SmsMessage[]): SmsMessage[] {
	const current = readJournal(home);
	const seen = new Set(current.map((item) => item.id));
	const added = incoming.filter((item) => !seen.has(item.id));
	const next = [...current, ...added];
	writeJournal(home, next);
	return added;
}

export function readIndex(home: string): Conversation[] {
	const rows = readJson<Conversation[]>(file(home, "index.json"), []);
	return Array.isArray(rows) ? rows : [];
}

export function writeIndex(home: string, rows: Conversation[]): void {
	mkdirSync(join(home, "ssms", "signal"), { recursive: true });
	writeFileSync(file(home, "index.json"), `${JSON.stringify(rows)}\n`);
}

export function recentMessages(
	messages: SmsMessage[],
	conversationId: string,
	limit: number,
): SmsMessage[] {
	return messages
		.filter((item) => item.conversationId === conversationId)
		.sort((a, b) => b.timestamp - a.timestamp)
		.slice(0, Math.max(0, limit));
}
