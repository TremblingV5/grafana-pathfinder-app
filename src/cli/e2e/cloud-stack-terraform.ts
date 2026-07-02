import { spawn } from 'child_process';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => Promise<CommandResult>;

export async function defaultCommandRunner(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

export function hclString(value: string): string {
  return JSON.stringify(value);
}

export function hclStringMap(value: Record<string, string>): string {
  return Object.entries(value)
    .map(([key, mapValue]) => `    ${hclString(key)} = ${hclString(mapValue)}`)
    .join('\n');
}

export function redact(text: string, secrets: string[]): string {
  return secrets.reduce((current, secret) => (secret ? current.split(secret).join('[redacted]') : current), text);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

export function assertCommandSuccess(result: CommandResult, action: string, secrets: string[]): void {
  if (result.exitCode === 0) {
    return;
  }
  const detail = redact(result.stderr || result.stdout || `exit ${result.exitCode}`, secrets);
  throw new Error(`terraform ${action} failed: ${detail}`);
}

export function terraformEnv(options: {
  accessPolicyToken: string;
  region?: string;
  pluginVersion?: string;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TF_IN_AUTOMATION: '1',
    TF_VAR_cloud_access_policy_token: options.accessPolicyToken,
    ...(options.region ? { TF_VAR_cloud_stack_region: options.region } : {}),
    ...(options.pluginVersion ? { TF_VAR_pathfinder_plugin_version: options.pluginVersion } : {}),
  };
}
