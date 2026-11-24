#!/usr/bin/env bun
/** In-memory Nostr relay over TLS for the RAM budget run; prints its wss:// URL first. */
type Filter = Record<string, unknown> & { kinds?: number[]; ids?: string[]; authors?: string[]; since?: number };
type NostrEvent = { id: string; pubkey: string; kind: number; created_at: number; tags: string[][] };
type Socket = Bun.ServerWebSocket<unknown>;
type Sub = { ws: Socket; id: string; filters: Filter[] };

const [cert, key] = Bun.argv.slice(2);
if (!cert || !key) throw new Error("usage: relay.ts <cert.pem> <key.pem>");

const events = new Map<string, NostrEvent>();
const subs: Sub[] = [];

function tagMatches(filter: Filter, event: NostrEvent): boolean {
	const tagKeys = Object.keys(filter).filter((name) => name.startsWith("#"));
	return tagKeys.every((name) => {
		const wanted = filter[name] as string[];
		return event.tags.some((tag) => tag[0] === name.slice(1) && wanted.includes(tag[1] as string));
	});
}

function matches(filter: Filter, event: NostrEvent): boolean {
	return (
		(!filter.kinds || filter.kinds.includes(event.kind)) &&
		(!filter.ids || filter.ids.includes(event.id)) &&
		(!filter.authors || filter.authors.includes(event.pubkey)) &&
		(!filter.since || event.created_at >= filter.since) &&
		tagMatches(filter, event)
	);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEvent(value: unknown): value is NostrEvent {
	if (!isObject(value) || typeof value.id !== "string" || !Array.isArray(value.tags)) return false;
	return value.tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === "string"));
}

function publish(ws: Socket, event: NostrEvent): void {
	ws.send(JSON.stringify(["OK", event.id, true, ""]));
	if (events.has(event.id)) return;
	events.set(event.id, event);
	for (const sub of subs) {
		if (sub.filters.some((filter) => matches(filter, event))) sub.ws.send(JSON.stringify(["EVENT", sub.id, event]));
	}
}

function subscribe(ws: Socket, id: string, filters: Filter[]): void {
	unsubscribe(ws, id);
	subs.push({ ws, id, filters });
	for (const event of events.values()) {
		if (filters.some((filter) => matches(filter, event))) ws.send(JSON.stringify(["EVENT", id, event]));
	}
	ws.send(JSON.stringify(["EOSE", id]));
}

function unsubscribe(ws: Socket, id: unknown): void {
	const index = subs.findIndex((sub) => sub.ws === ws && sub.id === id);
	if (index >= 0) subs.splice(index, 1);
}

function onMessage(ws: Socket, raw: string | Buffer): void {
	let message: unknown;
	try {
		message = JSON.parse(String(raw));
	} catch {
		ws.send(JSON.stringify(["NOTICE", "invalid: not JSON"]));
		return;
	}
	if (!Array.isArray(message)) {
		ws.send(JSON.stringify(["NOTICE", "invalid: not an array"]));
		return;
	}
	const [verb, first, ...rest] = message as [unknown, unknown, ...unknown[]];
	if (verb === "EVENT" && isEvent(first)) publish(ws, first);
	else if (verb === "REQ" && typeof first === "string") subscribe(ws, first, rest.filter(isObject) as Filter[]);
	else if (verb === "CLOSE") unsubscribe(ws, first);
	else ws.send(JSON.stringify(["NOTICE", "invalid: unknown message"]));
}

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	tls: { cert: Bun.file(cert), key: Bun.file(key) },
	fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response("relay")),
	websocket: {
		message: onMessage,
		close(ws) {
			for (let i = subs.length - 1; i >= 0; i--) if (subs[i]?.ws === ws) subs.splice(i, 1);
		},
	},
});
console.log(`wss://127.0.0.1:${server.port}`);
