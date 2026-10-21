export const PLUGIN_AGENT_PREFIX = "dg:";

export function bareAgent(name: string): string {
	return name.startsWith(PLUGIN_AGENT_PREFIX) ? name.slice(PLUGIN_AGENT_PREFIX.length) : name;
}
