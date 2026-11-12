import { installModelContextShim } from "@/lib/features/webmcp-shim";

export default defineUnlistedScript(() => {
	installModelContextShim();
});
