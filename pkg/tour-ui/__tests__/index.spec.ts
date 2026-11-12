import { describe, expect, it } from "bun:test";
import * as api from "../src/index";

describe("@dg/tour-ui public exports", () => {
	it("exposes the runner, screens, engine and moved helpers", () => {
		for (const name of [
			"runTour",
			"showStartScreen",
			"showEditPanel",
			"buildOverlay",
			"positionCard",
			"renderStep",
			"initialPlayState",
			"recordingStartState",
			"restartState",
			"completeSetupPhase",
			"automaticPlayback",
			"advanceClickNeeded",
			"performAction",
			"stepEffect",
			"runVideoStepSequence",
			"editMachine",
			"scriptToDraft",
			"draftToScript",
			"editorReviewRows",
			"holdFor",
			"cssSelectorFor",
			"injectTheme",
			"waitForEl",
			"NarrationProgressTracker",
		]) {
			expect(typeof (api as Record<string, unknown>)[name]).toBe("function");
		}
	});
});
