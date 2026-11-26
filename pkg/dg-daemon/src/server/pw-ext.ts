import type { PW_EXT_RELAY } from "@dg/common";
import { deleteStagedAsset } from "../assets/delete";
import type { RelayHooks } from "./browser-relay";
import type { FrameHandlerDeps } from "./frame-handlers";

export const PW_EXT_STOPPED = "The person clicked Stop in the browser; pw --ext is off for this dg session. Nothing ran. Next: start a new dg session.";

const revokedByManager = new WeakMap<object, Set<string>>();

/** Session ids whose Stop the extension reported. A closed session leaves the set, and session ids come from randomUUID, so none returns. */
function revokedSessions(deps: FrameHandlerDeps): Set<string> {
	let revoked = revokedByManager.get(deps.connections);
	if (!revoked) {
		const held = new Set<string>();
		revoked = held;
		revokedByManager.set(deps.connections, held);
		deps.registry.on("closed", ({ sessionId }: { sessionId: string }) => held.delete(sessionId));
	}
	return revoked;
}

export function revokePwExt(deps: FrameHandlerDeps, sessionId: string): void {
	if (deps.registry.get(sessionId)?.state === "active") revokedSessions(deps).add(sessionId);
}

/** Refuses requests of a stopped session, and deletes a staged upload asset once its request ends for any reason. */
export function pwExtRelayHooks(
	deps: FrameHandlerDeps,
): RelayHooks<typeof PW_EXT_RELAY> {
	return {
		prepare({ sessionId, cli }) {
			return revokedSessions(deps).has(sessionId) ? { error: PW_EXT_STOPPED } : cli;
		},
		settled({ cli, sessionId }) {
			if (cli.request.verb !== "upload" || !cli.request.assetId) return;
			try {
				deleteStagedAsset(
					{ paths: deps.paths, store: deps.store },
					sessionId,
					cli.request.assetId,
				);
			} catch {}
		},
	};
}
