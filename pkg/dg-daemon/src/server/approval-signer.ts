import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { APPROVAL_KEY_CREDENTIAL, type ApprovalPurpose } from "@dg/common";
import type { CredentialStore } from "../store/credentials-store";

const DOMAINS: Record<ApprovalPurpose, string> = {
	approval: "dg-plugin-approval-v1",
	statcache: "dg-plugin-statcache-v1",
};
const HEX64 = /^[0-9a-f]{64}$/;

type KeyStore = Pick<CredentialStore, "getCredential" | "setCredential">;

export type ApprovalSigner = {
	sign(purpose: ApprovalPurpose, fields: string[]): string;
	verify(purpose: ApprovalPurpose, fields: string[], mac: string): boolean;
};

/** Signs with the sealed approval key; the key stays inside this module and the store. */
export function createApprovalSigner(store: KeyStore): ApprovalSigner {
	const mac = (key: Buffer, purpose: ApprovalPurpose, fields: string[]): Buffer =>
		createHmac("sha256", key).update([DOMAINS[purpose], ...fields].join("\0")).digest();
	return {
		sign(purpose, fields) {
			let stored = store.getCredential(APPROVAL_KEY_CREDENTIAL)?.value;
			if (stored === undefined) {
				stored = randomBytes(32).toString("hex");
				store.setCredential(APPROVAL_KEY_CREDENTIAL, stored);
			}
			if (!HEX64.test(stored)) throw new Error("the stored plugin approval key is damaged");
			return mac(Buffer.from(stored, "hex"), purpose, fields).toString("hex");
		},
		verify(purpose, fields, claimed) {
			const stored = store.getCredential(APPROVAL_KEY_CREDENTIAL)?.value;
			if (stored === undefined || !HEX64.test(stored) || !HEX64.test(claimed)) return false;
			return timingSafeEqual(mac(Buffer.from(stored, "hex"), purpose, fields), Buffer.from(claimed, "hex"));
		},
	};
}
