export type LocalSession = {
	sessionId: string;
	cwd: string;
	agentIdentity: string;
	token: string;
};

export type ProjectedLocalSession = {
	sessionId: string;
	cwd: string;
	agentIdentity: string;
	token?: string;
};

/**
 * A listing omits every token. A named session returns that one token, because
 * the owning CLI still has to present it. An unknown id returns nothing.
 */
export function projectLocalSessions(
	sessions: readonly LocalSession[],
	requestedId: string | null,
): { status: 200 | 404; sessions: ProjectedLocalSession[] } {
	if (requestedId === null || requestedId === "") {
		return {
			status: 200,
			sessions: sessions.map((session) => ({
				sessionId: session.sessionId,
				cwd: session.cwd,
				agentIdentity: session.agentIdentity,
			})),
		};
	}
	const match = sessions.find((session) => session.sessionId === requestedId);
	if (!match) return { status: 404, sessions: [] };
	return { status: 200, sessions: [match] };
}
