import {
	allowRuleCheck,
	anyToolCheck,
	skillFilesCheck,
	toolCheck,
} from "../doctor/checks";
import type { DoctorCheck } from "../doctor/types";
import { BACKENDS } from "./backends";

const BACKEND_LIST = Object.values(BACKENDS);
const BACKEND_TOOLS = BACKEND_LIST.map((backend) => backend.bin);

export const proxyChecks: DoctorCheck[] = [
	skillFilesCheck(["proxy", "assign"]),
	...BACKEND_LIST.map(({ bin, install }) =>
		toolCheck(
			{ tool: bin },
			{
				required: false,
				why: `the ${bin} backend is unavailable`,
				installFix: install.command,
			},
		),
	),
	anyToolCheck(
		"tool-backend",
		BACKEND_TOOLS.map((tool) => ({ tool })),
		{ required: true, why: "proxy needs at least one backend CLI" },
	),
	allowRuleCheck("proxy"),
];
