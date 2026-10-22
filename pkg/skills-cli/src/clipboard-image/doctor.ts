import {
	allowRuleCheck,
	anyToolCheck,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const clipboardImageChecks: DoctorCheck[] = [
	skillFilesCheck(["clipboard-img"]),
	anyToolCheck(
		"tool-clipboard",
		["wl-paste", "xclip", "powershell.exe", "osascript"].map((tool) => ({ tool })),
		{ required: false, why: "no clipboard backend is available for this platform" },
	),
	allowRuleCheck("clipboard-image"),
];
