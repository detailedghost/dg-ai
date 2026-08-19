import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import type { SessionRegistry } from "../session/registry";
import { describeKeySource } from "../utils/key-source";
import type { WslNetworkingMode } from "./wsl-guard";

/** Kept in lockstep with package.json's version by hand — no JSON import in a --compile binary. */
export const DG_SERVER_PACKAGE_VERSION = "1.0.0";

export type StatusReport = {
	daemon: "dg-server";
	instanceId: string;
	boundPort: number;
	keySource: string;
	lastError: string | null;
	wslNetworkingMode: WslNetworkingMode | "n/a";
	sessionCount: number;
	versions: {
		package: string;
		protocol: number;
		userVersion: number;
		extension: string | null;
	};
};

export type StatusDeps = {
	instanceId: string;
	boundPort: number;
	registry: SessionRegistry;
	wslNetworkingMode: WslNetworkingMode | "n/a";
	getLastError(): string | null;
	getExtensionVersion(): string | null;
};

export function renderStatus(deps: StatusDeps): StatusReport {
	return {
		daemon: "dg-server",
		instanceId: deps.instanceId,
		boundPort: deps.boundPort,
		keySource: describeKeySource(),
		lastError: deps.getLastError(),
		wslNetworkingMode: deps.wslNetworkingMode,
		sessionCount: deps.registry.activeCount(),
		versions: {
			package: DG_SERVER_PACKAGE_VERSION,
			protocol: CHAT_PROTOCOL_VERSION,
			userVersion: 0, // pre-slice-3: no SQLite store yet
			extension: deps.getExtensionVersion(),
		},
	};
}
