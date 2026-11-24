#!/usr/bin/env bun
/** In-memory Nostr relay over TLS for the RAM budget run; prints its wss:// URL first. */
type Filter = Record<string, unknown> & { kinds?: number[]; ids?: string[]; authors?: string[]; since?: number };
type NostrEvent = { id: string; pubkey: string; kind: number; created_at: number; tags: string[][] };
type Socket = Bun.ServerWebSocket<unknown>;
type Sub = { ws: Socket; id: string; filters: Filter[] };

const [cert, key] = Bun.argv.slice(2);
if (!cert || !key) throw new Error("usage: relay.ts <cert.pem> <key.pem>");

const events: NostrEvent[] = [];
const subs: Sub[] = [];

function tagMatches(filter: Filter, event: NostrEvent): boolean {
	return Object.keys(filter)
		.filter((name) => name.startsWith("#"))
		.every((name) => event.tags.some((tag) => tag[0] === name.slice(1) && (filter[name] as string[]).includes(tag[1] as string)));
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

function onMessage(ws: Socket, raw: string | Buffer): void {
	const message = JSON.parse(String(raw)) as [string, ...unknown[]];
	if (message[0] === "EVENT") {
		const event = message[1] as NostrEvent;
		events.push(event);
		ws.send(JSON.stringify(["OK", event.id, true, ""]));
		for (const sub of subs) if (sub.filters.some((filter) => matches(filter, event))) sub.ws.send(JSON.stringify(["EVENT", sub.id, event]));
	} else if (message[0] === "REQ") {
		const [, id, ...filters] = message as [string, string, ...Filter[]];
		subs.push({ ws, id, filters });
		for (const event of events) if (filters.some((filter) => matches(filter, event))) ws.send(JSON.stringify(["EVENT", id, event]));
		ws.send(JSON.stringify(["EOSE", id]));
	} else if (message[0] === "CLOSE") {
		const index = subs.findIndex((sub) => sub.ws === ws && sub.id === message[1]);
		if (index >= 0) subs.splice(index, 1);
	}
}

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	tls: { cert: Bun.file(cert), key: Bun.file(key) },
	fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("relay")),
	websocket: {
		message: onMessage,
		close(ws) {
			for (let i = subs.length - 1; i >= 0; i--) if (subs[i]?.ws === ws) subs.splice(i, 1);
		},
	},
});
console.log(`wss://127.0.0.1:${server.port}`);
