/** Unread ids to leave unread. `--new` skips whatever was already unread when watch started. The default prints that backlog. */
export function watchSkipIds(existingUnreadIds: readonly string[], onlyNew: boolean): ReadonlySet<string> | undefined {
	if (!onlyNew) return undefined;
	return new Set(existingUnreadIds);
}
