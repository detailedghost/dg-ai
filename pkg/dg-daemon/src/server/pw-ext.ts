import type { PW_EXT_RELAY } from "@dg/common";
import { deleteStagedAsset } from "../assets/delete";
import type { RelayHooks } from "./browser-relay";
import type { FrameHandlerDeps } from "./frame-handlers";

/** Deletes a staged upload asset once its request ends for any reason. */
export function pwExtRelayHooks(
	deps: FrameHandlerDeps,
): RelayHooks<typeof PW_EXT_RELAY> {
	return {
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
