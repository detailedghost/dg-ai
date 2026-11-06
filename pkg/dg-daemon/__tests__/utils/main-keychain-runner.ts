import { mock } from "bun:test";
import * as realBackends from "../../src/crypto/keychain-backends";
import * as realBootstrap from "../../src/server/bootstrap";
import { fakeKeychain } from "./fake-keychain";

const keychain = fakeKeychain(undefined, { label: "main" });
const fakeFor = () => keychain.backend;

mock.module("../../src/crypto/keychain-backends", () => ({
	...realBackends,
	createKeychainBackendForPlatform: fakeFor,
	nativeBackendFor: () => fakeFor,
}));
mock.module("../../src/server/bootstrap", () => ({
	...realBootstrap,
	cmdServe: async () => "deferred",
	cmdStatus: async () => {},
}));

const { main } = await import("../../src/main");
const exitCode = await main(process.argv.slice(2));
process.stdout.write(JSON.stringify({ exitCode, calls: keychain.calls, home: process.env.HOME, dgHome: process.env.DG_HOME }));
