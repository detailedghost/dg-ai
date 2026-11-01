import {
	allowRuleCheck,
	extensionChecks,
	skillFilesCheck,
} from "../doctor/checks";
import { ok, warn, type DoctorCheck } from "../doctor/types";
import {
	PROTON_SIGN_IN_COMMAND,
	readSignedInMarker,
	type ProtonSignInMarker,
} from "./proton-pw";

function signedInDetail(marker: ProtonSignInMarker): string {
	const facts = [
		marker.profile && (marker.profile === "windows" ? "Windows profile" : "local profile"),
		marker.signedInAt && `last verified ${marker.signedInAt.slice(0, 10)}`,
	].filter(Boolean);
	return facts.length ? `signed in (${facts.join(", ")})` : "signed in";
}

export const protonTransportCheck: DoctorCheck = {
	id: "proton-transport",
	run: (ctx) => {
		const marker = readSignedInMarker(ctx.paths.stateDir);
		return marker
			? ok(
					`Proton transport: pw profile, ${signedInDetail(marker)} (--ext uses the extension)`,
				)
			: warn(
					"Proton transport: pw profile, signed out (--ext uses the extension)",
					PROTON_SIGN_IN_COMMAND,
				);
	},
};

export const inboxChecks: DoctorCheck[] = [
	skillFilesCheck(["inbox-cleanup"]),
	protonTransportCheck,
	...extensionChecks,
	allowRuleCheck("inbox"),
];
