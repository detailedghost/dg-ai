declare module "playwright-core/lib/coreBundle" {
	interface RegistryExecutable {
		browserVersion?: string;
		revision: string;
		executablePath(): string | undefined;
	}

	export const registry: {
		registry: {
			findExecutable(name: string): RegistryExecutable | undefined;
			install(executables: RegistryExecutable[]): Promise<void>;
		};
	};
}
