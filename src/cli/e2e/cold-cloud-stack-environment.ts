import { randomUUID } from 'crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CloudChainEnvironment, ProvisionedCloudStack } from './cloud-chain-environment';
import {
  CLOUD_STACK_TOKEN_TTL_SECONDS,
  DEFAULT_CLOUD_STACK_SLUG_PREFIX,
  PATHFINDER_E2E_LABELS,
  PATHFINDER_E2E_LABEL_VALUES,
  PLUGIN_ID,
  TERRAFORM_PROVIDER_VERSION,
  generatedCloudStackSlug,
  normalizeCloudStackSlugPrefix,
  requireNonEmptyOption,
  type CloudStackProvisioningConfig,
} from './cloud-stack-common';
import {
  assertCommandSuccess,
  defaultCommandRunner,
  errorMessage,
  hclString,
  hclStringMap,
  redact,
  terraformEnv,
  type CommandResult,
  type CommandRunner,
} from './cloud-stack-terraform';
import { CLOUD_STACK_FETCH_TIMEOUT_MS } from './shared-cloud-stack-environment';

export interface ColdCloudStackConfigInput {
  accessPolicyTokenEnvVar?: string;
  region?: string;
  slugPrefix?: string;
  pluginVersion?: string;
  env?: NodeJS.ProcessEnv;
}

export type ColdCloudStackProvisioningConfig = CloudStackProvisioningConfig;

export type { ProvisionedCloudStack } from './cloud-chain-environment';
export type { CommandResult, CommandRunner } from './cloud-stack-terraform';

interface TerraformOutput {
  stack_url?: { value?: unknown };
  stack_slug?: { value?: unknown };
  service_account_token?: { value?: unknown };
}

function hasAnyStackConfig(input: ColdCloudStackConfigInput): boolean {
  return Boolean(input.accessPolicyTokenEnvVar || input.region || input.slugPrefix || input.pluginVersion);
}

export function createColdCloudStackProvisioningConfig(
  input: ColdCloudStackConfigInput
): ColdCloudStackProvisioningConfig | undefined {
  if (!hasAnyStackConfig(input)) {
    return undefined;
  }

  const env = input.env ?? process.env;
  const envVar = requireNonEmptyOption(
    input.accessPolicyTokenEnvVar,
    '--cloud-stack-access-policy-token is required when Cloud stack provisioning options are set'
  );
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar)) {
    throw new Error(`Invalid --cloud-stack-access-policy-token env var "${envVar}".`);
  }
  const accessPolicyToken = env[envVar];
  if (!accessPolicyToken) {
    throw new Error(`--cloud-stack-access-policy-token references unset or empty environment variable ${envVar}.`);
  }

  return {
    accessPolicyTokenEnvVar: envVar,
    accessPolicyToken,
    region: requireNonEmptyOption(
      input.region,
      '--cloud-stack-region is required when Cloud stack provisioning is enabled'
    ),
    slugPrefix: normalizeCloudStackSlugPrefix(input.slugPrefix ?? DEFAULT_CLOUD_STACK_SLUG_PREFIX),
    pluginVersion: input.pluginVersion?.trim() || undefined,
  };
}

function pathfinderPluginResource(): string {
  return `
resource "grafana_cloud_plugin_installation" "pathfinder" {
  provider = grafana.cloud
  stack_slug = grafana_cloud_stack.e2e.slug
  slug = ${hclString(PLUGIN_ID)}
  version = var.pathfinder_plugin_version
}
`;
}

function terraformModule(options: {
  slug: string;
  createdAtSeconds: number;
  runId: string;
  installPathfinderPlugin: boolean;
}): string {
  const labels = {
    [PATHFINDER_E2E_LABELS.base]: PATHFINDER_E2E_LABEL_VALUES.true,
    [PATHFINDER_E2E_LABELS.kind]: PATHFINDER_E2E_LABEL_VALUES.coldRun,
    [PATHFINDER_E2E_LABELS.createdAt]: String(options.createdAtSeconds),
    [PATHFINDER_E2E_LABELS.runId]: options.runId,
  };

  return `terraform {
  required_providers {
    grafana = {
      source = "grafana/grafana"
      version = ${hclString(TERRAFORM_PROVIDER_VERSION)}
    }
  }
}

variable "cloud_access_policy_token" {
  type = string
  sensitive = true
}

variable "cloud_stack_region" {
  type = string
}

variable "pathfinder_plugin_version" {
  type = string
}

provider "grafana" {
  alias = "cloud"
  cloud_access_policy_token = var.cloud_access_policy_token
}

resource "grafana_cloud_stack" "e2e" {
  provider = grafana.cloud
  name = ${hclString(options.slug)}
  slug = ${hclString(options.slug)}
  region_slug = var.cloud_stack_region
  delete_protection = false
  labels = {
${hclStringMap(labels)}
  }
}
${options.installPathfinderPlugin ? pathfinderPluginResource() : ''}

resource "grafana_cloud_stack_service_account" "e2e" {
  provider = grafana.cloud
  stack_slug = grafana_cloud_stack.e2e.slug
  name = "pathfinder-e2e"
  role = "Admin"
}

resource "grafana_cloud_stack_service_account_token" "e2e" {
  provider = grafana.cloud
  stack_slug = grafana_cloud_stack.e2e.slug
  name = "pathfinder-e2e"
  service_account_id = grafana_cloud_stack_service_account.e2e.id
  seconds_to_live = ${CLOUD_STACK_TOKEN_TTL_SECONDS}
}

output "stack_url" {
  value = grafana_cloud_stack.e2e.url
}

output "stack_slug" {
  value = grafana_cloud_stack.e2e.slug
}

output "service_account_token" {
  value = grafana_cloud_stack_service_account_token.e2e.key
  sensitive = true
}
`;
}

function parseTerraformOutput(text: string): ProvisionedCloudStack {
  const parsed = JSON.parse(text) as TerraformOutput;
  const targetUrl = parsed.stack_url?.value;
  const token = parsed.service_account_token?.value;
  const stackSlug = parsed.stack_slug?.value;
  if (typeof targetUrl !== 'string' || typeof token !== 'string' || typeof stackSlug !== 'string') {
    throw new Error('terraform output did not include stack_url, stack_slug, and service_account_token string values.');
  }
  return { kind: 'cold', targetUrl, token, stackSlug };
}

export class ColdCloudStackEnvironment implements CloudChainEnvironment {
  private moduleDir: string | null = null;
  private currentStackSlug: string | null = null;
  private teardownPromise: Promise<string[]> | null = null;
  private readonly secrets: string[];

  constructor(
    private readonly config: ColdCloudStackProvisioningConfig,
    private readonly verbose: boolean,
    private readonly runner: CommandRunner = defaultCommandRunner,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.secrets = [config.accessPolicyToken];
  }

  async provisionChain(): Promise<ProvisionedCloudStack> {
    const slug = generatedCloudStackSlug(this.config.slugPrefix);
    const moduleDir = mkdtempSync(join(tmpdir(), 'pathfinder-e2e-stack-'));
    chmodSync(moduleDir, 0o700);
    const createdAtSeconds = Math.floor(Date.now() / 1000);
    const runId = randomUUID();
    const modulePath = join(moduleDir, 'main.tf');

    this.moduleDir = moduleDir;
    this.currentStackSlug = slug;
    writeFileSync(modulePath, terraformModule({ slug, createdAtSeconds, runId, installPathfinderPlugin: false }));

    try {
      await this.runTerraform(['init', '-input=false', '-no-color'], 'init');
      await this.runTerraform(['apply', '-input=false', '-auto-approve', '-no-color'], 'apply');
      const output = await this.runTerraform(['output', '-json', '-no-color'], 'output');
      let provisioned = parseTerraformOutput(output.stdout);
      this.secrets.push(provisioned.token);

      if (!(await this.isPathfinderPluginInstalled(provisioned))) {
        writeFileSync(modulePath, terraformModule({ slug, createdAtSeconds, runId, installPathfinderPlugin: true }));
        await this.runTerraform(['apply', '-input=false', '-auto-approve', '-no-color'], 'apply');
        const updatedOutput = await this.runTerraform(['output', '-json', '-no-color'], 'output');
        provisioned = parseTerraformOutput(updatedOutput.stdout);
        this.secrets.push(provisioned.token);
      } else if (this.verbose) {
        console.log(`   ☁️ Pathfinder plugin already installed on ${provisioned.stackSlug}; skipping plugin install`);
      }

      if (this.verbose) {
        console.log(`   ☁️ Provisioned Cloud stack ${provisioned.stackSlug} (${provisioned.targetUrl})`);
      }
      return provisioned;
    } catch (err) {
      await this.teardownChain();
      throw new Error(redact(errorMessage(err), this.secrets));
    }
  }

  teardownChain(): Promise<string[]> {
    return (this.teardownPromise ??= this.runTeardown());
  }

  private async runTeardown(): Promise<string[]> {
    const moduleDir = this.moduleDir;
    if (!moduleDir) {
      return [];
    }

    const warnings: string[] = [];
    try {
      await this.runTerraform(
        ['destroy', '-input=false', '-auto-approve', '-lock-timeout=60s', '-no-color'],
        'destroy'
      );
      if (this.verbose && this.currentStackSlug) {
        console.log(`   🧹 Destroyed Cloud stack ${this.currentStackSlug}`);
      }
    } catch (err) {
      const slug = this.currentStackSlug ?? 'unknown';
      const warning = `Failed to destroy Cloud stack ${slug}: ${redact(errorMessage(err), this.secrets)}`;
      warnings.push(warning);
      console.warn(`   ⚠ ${warning}`);
    } finally {
      rmSync(moduleDir, { recursive: true, force: true });
      this.moduleDir = null;
      this.currentStackSlug = null;
    }
    return warnings;
  }

  async teardownAll(): Promise<string[]> {
    return this.teardownChain();
  }

  private async runTerraform(args: string[], action: string): Promise<CommandResult> {
    if (!this.moduleDir) {
      throw new Error('Terraform module directory has not been initialized.');
    }
    const result = await this.runner('terraform', args, {
      cwd: this.moduleDir,
      env: terraformEnv({
        accessPolicyToken: this.config.accessPolicyToken,
        region: this.config.region,
        pluginVersion: this.config.pluginVersion ?? 'latest',
      }),
    });
    assertCommandSuccess(result, action, this.secrets);
    return result;
  }

  private async isPathfinderPluginInstalled(stack: ProvisionedCloudStack): Promise<boolean> {
    const url = new URL(`/api/plugins/${PLUGIN_ID}/settings`, stack.targetUrl).toString();
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${stack.token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(CLOUD_STACK_FETCH_TIMEOUT_MS),
    });
    if (response.ok) {
      return true;
    }
    if (response.status === 404) {
      return false;
    }
    throw new Error(`Pathfinder plugin probe failed: HTTP ${response.status} ${response.statusText}`);
  }
}
