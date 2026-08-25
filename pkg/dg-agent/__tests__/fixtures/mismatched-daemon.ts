#!/usr/bin/env bun

import { CHAT_HEALTH_PATH, CHAT_PROTOCOL_VERSION } from "@dg/common";
import { resolveDgPaths, writePidFileAtomic } from "@dg/common/node";

const INSTANCE_ID = "mismatched-daemon";

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.DG_PORT ?? 0),
	fetch(req) {
		return new URL(req.url).pathname === CHAT_HEALTH_PATH
			? Response.json({ instanceId: INSTANCE_ID })
			: new Response("not found", { status: 404 });
	},
});

writePidFileAtomic(resolveDgPaths(), {
	pid: process.pid,
	port: server.port ?? 0,
	instanceId: INSTANCE_ID,
	versions: { package: "0.0.0", protocol: CHAT_PROTOCOL_VERSION + 99 },
});
