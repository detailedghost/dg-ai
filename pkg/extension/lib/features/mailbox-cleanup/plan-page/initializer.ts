import {
	serializeMailboxPlanRevision,
	validateMailboxPlanRevision,
	type MailboxPlanRevision,
} from "@dg/common";
import type { MailboxLifecycle } from "../lifecycle";
import type { MailboxPlanWorkspaceInput } from "./contracts";

export async function ensureMailboxPlanBaseRevision(
	value: unknown,
	lifecycle: Pick<MailboxLifecycle, "create" | "get">,
): Promise<MailboxPlanRevision> {
	const revision = validateMailboxPlanRevision(value);
	const plan = await lifecycle.get(revision.planAlias);
	const existing = plan?.revisions.find(
		(candidate) =>
			candidate.revisionAlias === revision.revisionAlias,
	);
	if (existing !== undefined) {
		if (
			serializeMailboxPlanRevision(existing) !==
			serializeMailboxPlanRevision(revision)
		) {
			throw new Error("Mailbox base revision mismatch");
		}
		return existing;
	}
	return lifecycle.create(revision);
}

export async function initializeMailboxPlanPage<
	TWorkspace,
	TDispose,
>(
	input: MailboxPlanWorkspaceInput,
	deps: Readonly<{
		lifecycle: Pick<MailboxLifecycle, "create" | "get">;
		createWorkspace(input: MailboxPlanWorkspaceInput): TWorkspace;
		mount(workspace: TWorkspace): TDispose;
	}>,
): Promise<Readonly<{ workspace: TWorkspace; dispose: TDispose }>> {
	const baseRevision = await ensureMailboxPlanBaseRevision(
		input.baseRevision,
		deps.lifecycle,
	);
	const workspace = deps.createWorkspace({
		...input,
		baseRevision,
	});
	const dispose = deps.mount(workspace);
	return Object.freeze({ workspace, dispose });
}
