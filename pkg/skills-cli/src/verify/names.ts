/** Reject a session, item, or role id that could escape the session directory. */
export function assertVerifyName(name: string, label = "name"): string {
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))
		throw new Error(`invalid verify ${label}: ${JSON.stringify(name)}`);
	return name;
}
