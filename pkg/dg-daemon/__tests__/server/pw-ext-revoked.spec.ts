import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { PW_EXT_STOPPED, pwExtRelayHooks, revokePwExt } from "../../src/server/pw-ext";
import type { FrameHandlerDeps } from "../../src/server/frame-handlers";

function rig(active: string[]) {
	const registry = Object.assign(new EventEmitter(), {
		get: (sessionId: string) => (active.includes(sessionId) ? { state: "active" } : undefined),
	});
	const deps = { connections: {}, registry } as unknown as FrameHandlerDeps;
	const prepare = (sessionId: string) =>
		(pwExtRelayHooks(deps).prepare as (ctx: unknown) => unknown)({ sessionId, cli: { verb: "tabs" } });
	return { registry, deps, prepare };
}

describe("pw --ext revoked sessions", () => {
	it("refuses a revoked session and forgets it when the session closes", () => {
		const { registry, deps, prepare } = rig(["s1"]);
		revokePwExt(deps, "s1");
		expect(prepare("s1")).toEqual({ error: PW_EXT_STOPPED });
		registry.emit("closed", { sessionId: "s1" });
		expect(prepare("s1")).toEqual({ verb: "tabs" });
	});

	it("holds no revocation for a session that is not active", () => {
		const { deps, prepare } = rig([]);
		revokePwExt(deps, "ghost");
		expect(prepare("ghost")).toEqual({ verb: "tabs" });
	});
});
