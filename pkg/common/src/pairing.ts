import { fail, requireRecord, requireString } from "./assert";
import {
	type SessionBootstrap,
	validateSessionBootstrap,
} from "./chat-format";

export const CHAT_PAIR_PATH = "/pair";

export type PairRequest = {
	code: string;
};

export type PairResponse = Omit<SessionBootstrap, "agentIdentity"> & {
	agentIdentity: "extension";
};

export function validatePairRequest(value: unknown): PairRequest {
	requireRecord(value, "pair request");
	requireString(value.code, "pair request.code");
	if (!/^\d{6}$/.test(value.code)) {
		fail("pair request.code must be exactly six digits");
	}
	return value as PairRequest;
}

export function validatePairResponse(value: unknown): PairResponse {
	const response = validateSessionBootstrap(value);
	if (response.agentIdentity !== "extension") {
		fail('pair response.agentIdentity must be "extension"');
	}
	return { ...response, agentIdentity: response.agentIdentity };
}
