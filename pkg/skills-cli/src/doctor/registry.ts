import { addressChecks } from "../address/doctor";
import { assignChecks } from "../assign/doctor";
import { batchOpenChecks } from "../batch-open/doctor";
import { bgChecks } from "../bg/doctor";
import { catchupChecks } from "../catchup/doctor";
import { chainChecks } from "../chain/doctor";
import { channelReviewChecks } from "../channel-review/doctor";
import { clipboardImageChecks } from "../clipboard-image/doctor";
import { credentialsChecks } from "../credentials/doctor";
import { dbChecks } from "../db/doctor";
import { demoChecks } from "../demo/doctor";
import { depsUpgradeChecks } from "../deps-upgrade/doctor";
import { erdChecks } from "../erd/doctor";
import { fileChecks } from "../file/doctor";
import { inboxChecks } from "../inbox/doctor";
import { installChecks } from "../install/doctor";
import { jotChecks } from "../jot/doctor";
import { launchChecks } from "../launch/doctor";
import { meaningfulChecks } from "../meaningful/doctor";
import { monolithChecks } from "../monolith/doctor";
import { overwatchSnapshotChecks } from "../overwatch-snapshot/doctor";
import { polishChecks } from "../polish/doctor";
import { protoChecks, prototypeChecks } from "../proto/doctor";
import { proxyChecks } from "../proxy/doctor";
import { requireExtensionChecks } from "../require-extension/doctor";
import { rerunChecks } from "../rerun/doctor";
import { sniffChecks } from "../sniff/doctor";
import { specChecks } from "../spec/doctor";
import { stashChecks } from "../stash/doctor";
import { statChecks } from "../stat/doctor";
import { testLiveChecks } from "../test-live/doctor";
import { thrashChecks } from "../thrash/doctor";
import { vcsProviderChecks } from "../vcs-provider/doctor";
import { worktreeChecks } from "../worktree/doctor";
import type { DoctorRegistry } from "./runner";
import { SHARED_ITEM, sharedChecks } from "./shared";

export const DOCTOR_REGISTRY: DoctorRegistry = {
	[SHARED_ITEM]: sharedChecks,
	inbox: inboxChecks,
	"channel-review": channelReviewChecks,
	credentials: credentialsChecks,
	db: dbChecks,
	erd: erdChecks,
	"test-live": testLiveChecks,
	install: installChecks,
	"batch-open": batchOpenChecks,
	launch: launchChecks,
	demo: demoChecks,
	rerun: rerunChecks,
	stash: stashChecks,
	address: addressChecks,
	thrash: thrashChecks,
	chain: chainChecks,
	catchup: catchupChecks,
	file: fileChecks,
	"deps-upgrade": depsUpgradeChecks,
	meaningful: meaningfulChecks,
	"vcs-provider": vcsProviderChecks,
	"clipboard-image": clipboardImageChecks,
	proto: protoChecks,
	prototype: prototypeChecks,
	proxy: proxyChecks,
	"overwatch-snapshot": overwatchSnapshotChecks,
	worktree: worktreeChecks,
	spec: specChecks,
	assign: assignChecks,
	monolith: monolithChecks,
	jot: jotChecks,
	bg: bgChecks,
	stat: statChecks,
	sniff: sniffChecks,
	"require-extension": requireExtensionChecks,
	polish: polishChecks,
};
