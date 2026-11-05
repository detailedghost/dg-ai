import { browser } from "wxt/browser";
import { PW_EXT_APPROVAL_PORT } from "@/lib/background/pw-ext-approval";
import { mountPwApprove } from "@/lib/features/pw-approve-page";

mountPwApprove(
	document,
	browser.runtime.connect({ name: PW_EXT_APPROVAL_PORT }),
	location.hash.slice(1),
);
