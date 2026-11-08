import type { PairingMount, PairingMountOptions } from "../../src/runtime";

export function makeFakePairingMount() {
	let options: PairingMountOptions | undefined;
	const connectedCalls: boolean[] = [];
	const currentSessions: Array<string | undefined> = [];
	const mount: PairingMount = (_host, mountOptions) => {
		options = mountOptions;
		return {
			setConnected: (connected) => {
				connectedCalls.push(connected);
			},
			setCurrentSession: (sessionId) => {
				currentSessions.push(sessionId);
			},
			destroy: () => undefined,
		};
	};
	return {
		mount,
		connectedCalls,
		currentSessions,
		reportDaemon(reachable: boolean): void {
			options?.onDaemon?.(reachable);
		},
		get findPort(): PairingMountOptions["findPort"] {
			return options?.findPort;
		},
		get initialConnected(): boolean | undefined {
			return options?.initialConnected;
		},
	};
}
