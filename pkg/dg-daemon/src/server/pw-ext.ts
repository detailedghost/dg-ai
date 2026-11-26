import type { PW_EXT_RELAY } from "@dg/common";
import { deleteStagedAsset } from "../assets/delete";
import type { RelayHooks } from "./browser-relay";
import type { FrameHandlerDeps } from "./frame-handlers";

export const PW_EXT_STOPPED = "The person clicked Stop in the browser; pw --ext is off for this dg session. Nothing ran. Next: start a new dg session.";

const revokedByRegistry = new WeakMap<object, Set<string>>();

/** Session ids whose Stop the extension reported. A closed session leaves the set, and session ids come from randomUUID, so none returns. */
function revokedSessions(deps: FrameHandlerDeps): Set<string> {
	let revoked = revokedByRegistry.get(deps.registry);
	if (!revoked) {
		const created = new Set<string>();
		revoked = created;
		revokedByRegistry.set(deps.registry, created);
		deps.registry.on("closed", ({ sessionId }: { sessionId: string }) => created.delete(sessionId));
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
