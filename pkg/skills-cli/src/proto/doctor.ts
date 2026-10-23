import {
	allowRuleCheck,
	extensionChecks,
	skillFilesCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";

export const protoChecks: DoctorCheck[] = [
	skillFilesCheck(["proto"]),
	...extensionChecks,
	allowRuleCheck("proto"),
];

export const prototypeChecks: DoctorCheck[] = [
	skillFilesCheck(["proto"]),
	allowRuleCheck("prototype"),
];
