import { programCommand } from "@dg/common/node/program";

export interface AwsSecretRef {
	id: string;
	key: string;
	profile?: string;
	region?: string;
}

const SECRET_ENV = "DG_DB_SECRET";
const CHILD_ENV = "DG_DB_ASM_CHILD";
const UNRESOLVED_PREFIX = "{{resolve:";

export function placeholder(id: string, key: string): string {
	return `{{resolve:secretsmanager:${id}:SecretString:${key}}}`;
}

export function asmExecArgv(ref: AwsSecretRef, command: readonly string[]): string[] {
	return [
		"asm-exec",
		"--",
		"env",
		`${SECRET_ENV}=${placeholder(ref.id, ref.key)}`,
		...command,
	];
}

export function isAsmChild(): boolean {
	return process.env[CHILD_ENV] === "1";
}

export function childSecret(connectionName: string): string {
	const value = process.env[SECRET_ENV];
	if (!value || value.startsWith(UNRESOLVED_PREFIX))
		throw new Error(
			`connection "${connectionName}": ${SECRET_ENV} was not resolved by asm-exec — check the secret id, key and AWS credentials`,
		);
	return value;
}

export async function rerunUnderAsm(
	ref: AwsSecretRef,
	verb: string,
	args: readonly string[],
): Promise<number> {
	if (!Bun.which("asm-exec", { PATH: process.env.PATH ?? "" }))
		throw new Error(
			"asm-exec not found on PATH — install the Agent Toolkit for AWS aws-core plugin",
		);
	const env: Record<string, string | undefined> = { ...process.env, [CHILD_ENV]: "1" };
	if (ref.profile) env.AWS_PROFILE = ref.profile;
	if (ref.region) env.AWS_REGION = ref.region;
	const child = Bun.spawn(
		asmExecArgv(ref, programCommand("dg-skills", ["db", verb, ...args])),
		{ env, stdio: ["inherit", "inherit", "inherit"] },
	);
	return child.exited;
}
