import type { ThreadRole } from "../types";

// One place to resolve how a thread author (ai vs user) is named and styled.
export function roleName(role: ThreadRole): string {
	return role === "ai" ? "AI" : "You";
}

export function threadBubbleClass(role: ThreadRole): string {
	return role === "ai" ? "bg-accent-soft" : "bg-panel-2";
}

export function threadLabelClass(role: ThreadRole): string {
	return role === "ai" ? "text-accent" : "text-mid";
}

export function threadDotClass(role: ThreadRole): string {
	return role === "ai" ? "bg-accent" : "bg-mid";
}
