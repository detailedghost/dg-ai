import {
	applyWorkspace,
	batchMessages,
	cleanupWorkspaceCommand,
	createClassificationDoc,
	initWorkspace,
	loadFilters,
	loadFolders,
	loadLabels,
	loginWorkspace,
	probeFolder,
	relocateFolder,
	reviewWorkspace,
	statusWorkspace,
	summarizeWorkspace,
} from "../commands/workflow";
import {
	analyzeWorkspace,
	decideWorkspace,
	inventoryFolders,
	inventoryLabels,
	recommendFilters,
	sampleWorkspace,
	suggestWorkspace,
} from "../commands/decision-support";
import { applyRecommendedFilters } from "../commands/filter-apply";
import { consolidateFilters } from "../commands/filter-consolidate";
import { groupGeneratedFilters } from "../commands/filter-group";
import { routeProfileFilter } from "../features/filter-routing/command";
import { discoverInboxProjects } from "../features/inbox-planning/projects";
import { validateSpecCommand } from "../features/spec-validation/command";
import {
	applyCleanupPlanPatch,
	applyOutlookFilters,
	applyOutlookFolderTree,
	applyOutlookInboxRoutes,
	applyOutlookLabels,
	exportInboxReviewQueue,
	planOutlookFilters,
	planOutlookFolderTree,
	planOutlookInboxRoutes,
	planOutlookLabels,
	validateCleanupPolicy,
	verifyCleanupPolicy,
	visualizeCleanupPolicy,
} from "../features/outlook-cleanup/command";
import { printHelp, type CommandRegistry } from "./router";

export const commandRegistry: CommandRegistry = {
	help: async () => printHelp(),
	analyze: analyzeWorkspace,
	apply: applyWorkspace,
	batch: batchMessages,
	"classify-doc": createClassificationDoc,
	cleanup: cleanupWorkspaceCommand,
	"cleanup:plan-patch": applyCleanupPlanPatch,
	"cleanup:validate": validateCleanupPolicy,
	"cleanup:verify": verifyCleanupPolicy,
	"cleanup:visualize": visualizeCleanupPolicy,
	decide: decideWorkspace,
	"folders:apply-tree": applyOutlookFolderTree,
	"folders:inventory": inventoryFolders,
	"folders:plan-tree": planOutlookFolderTree,
	"folders:relocate": relocateFolder,
	"labels:apply": applyOutlookLabels,
	"labels:inventory": inventoryLabels,
	"labels:plan": planOutlookLabels,
	"filters:apply": async (context) => {
		if (context.config.provider === "outlook") {
			await applyOutlookFilters(context);
			return;
		}
		await applyRecommendedFilters(context);
	},
	"filters:consolidate": consolidateFilters,
	"filters:group": groupGeneratedFilters,
	"filters:plan": planOutlookFilters,
	"filters:route": routeProfileFilter,
	"inbox:projects": discoverInboxProjects,
	"inbox:review-queue": exportInboxReviewQueue,
	"inbox:route-apply": applyOutlookInboxRoutes,
	"inbox:route-plan": planOutlookInboxRoutes,
	init: initWorkspace,
	login: loginWorkspace,
	"load:folders": loadFolders,
	"load:labels": loadLabels,
	"load:filters": loadFilters,
	probe: probeFolder,
	"recommend:filters": recommendFilters,
	review: reviewWorkspace,
	sample: sampleWorkspace,
	status: statusWorkspace,
	summary: summarizeWorkspace,
	suggest: suggestWorkspace,
	"validate:spec": validateSpecCommand,
};
