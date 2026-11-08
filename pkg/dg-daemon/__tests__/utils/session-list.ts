import {
	collectFrames,
	type Credentials,
	frameType,
	sendConnectHandshake,
	waitForOpen,
	waitForValue,
	wsExtensionSocket,
} from "./daemon-harness";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";

export type ListedSession = {
	sessionId: string;
	presence?: string;
	role?: string;
};

export async function readSessionList(
	port: number,
	credentials: Credentials,
): Promise<ListedSession[]> {
	const ws = wsExtensionSocket(port);
	try {
		await waitForOpen(ws);
		const frames = collectFrames(ws);
		sendConnectHandshake(ws, credentials, CHAT_PROTOCOL_VERSION);
		const listed = await waitForValue(
			() => frames.find((frame) => frameType(frame) === "session-list"),
			2000,
			"session-list",
		);
		return (listed as { sessions: ListedSession[] }).sessions;
	} finally {
		ws.close();
	}
}
