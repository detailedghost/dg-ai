import { resolveDgPaths } from "@dg/common/node";
import type { Command } from "commander";
import { createPairingCode } from "../pairing";

export function registerPairCommand(program: Command): void {
	program
		.command("pair")
		.description("create a short one-time code for pairing the dg extension")
		.action(() => {
			const { code, expiresAt } = createPairingCode(resolveDgPaths());
			console.log(`Pairing code: ${code}`);
			console.log(`Expires at: ${new Date(expiresAt).toISOString()}`);
			console.log("Enter this code in the dg extension: Pair");
		});
}
