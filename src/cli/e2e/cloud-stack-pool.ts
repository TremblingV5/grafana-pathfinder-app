import { randomUUID } from 'crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CloudChainEnvironment, ProvisionedCloudStack } from './cloud-chain-environment';

import {
  CLOUD_STACK_SLUG_PATTERN,
  CLOUD_STACK_TOKEN_TTL_SECONDS,
  DEFAULT_CLOUD_STACK_SLUG_PREFIX,
  PATHFINDER_E2E_LABELS,
  PATHFINDER_E2E_LABEL_VALUES,
  PLUGIN_ID,
  TERRAFORM_PROVIDER_VERSION,
  generatedCloudStackSlug,
  normalizeCloudStackSlugPrefix,
  optionalNonEmptyOption,
  requireNonEmptyOption,
  validateCloudStackLabelValue,
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

const CLOUD_INSTANCES_API_URL = 'https://grafana.com/api/instances';

export interface CloudStackPoolConfigInput {
  accessPolicyTokenEnvVar?: string;
  region?: string;
  slugPrefix?: string;
  pluginVersion?: string;
  poolId?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CloudStackPoolConfig {
  accessPolicyTokenEnvVar: string;
  accessPolicyToken: string;
  region?: string;
  slugPrefix: string;
  pluginVersion?: string;
  poolId?: string;
}

interface CloudStackListResponse {
  items?: CloudStackListItem[];
}

interface CloudStackListItem {
  id?: string | number;
  slug?: string;
  url?: string;
  region?: string;
  regionSlug?: string;
  region_slug?: string;
  labels?: Record<string, string>;
  deleteProtection?: boolean;
  delete_protection?: boolean;
}

interface TerraformTokenOutput {
  service_account_token?: { value?: unknown };
}

interface LeasablePoolStack {
  targetUrl: string;
  stackSlug: string;
  region?: string;
}

export interface CreateCloudStackPoolStackOptions {
  accessPolicyToken: string;
  region: string;
  poolId?: string;
  slugPrefix: string;
  pluginVersion?: string;
  verbose: boolean;
  runner?: CommandRunner;
}

function hasAnyPoolConfig(input: CloudStackPoolConfigInput): boolean {
  return Boolean(
    input.accessPolicyTokenEnvVar || input.region || input.slugPrefix || input.pluginVersion || input.poolId
  );
}

export function createCloudStackPoolConfig(input: CloudStackPoolConfigInput): CloudStackPoolConfig | undefined {
  if (!hasAnyPoolConfig(input)) {
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

  const config: CloudStackPoolConfig = {
    accessPolicyTokenEnvVar: envVar,
    accessPolicyToken,
    slugPrefix: normalizeCloudStackSlugPrefix(input.slugPrefix ?? DEFAULT_CLOUD_STACK_SLUG_PREFIX),
  };
  const region = optionalNonEmptyOption(input.region, '--cloud-stack-region');
  const pluginVersion = optionalNonEmptyOption(input.pluginVersion, '--cloud-stack-plugin-version');
  const poolId = validateCloudStackLabelValue(input.poolId, '--cloud-stack-pool-id');
  if (region) {
    config.region = region;
  }
  if (pluginVersion) {
    config.pluginVersion = pluginVersion;
  }
  if (poolId) {
    config.poolId = poolId;
  }
  return config;
}

export function coldConfigFromPoolConfig(config: CloudStackPoolConfig): CloudStackProvisioningConfig | undefined {
  if (!config.region) {
    return undefined;
  }
  const coldConfig: CloudStackProvisioningConfig = {
    accessPolicyTokenEnvVar: config.accessPolicyTokenEnvVar,
    accessPolicyToken: config.accessPolicyToken,
    region: config.region,
    slugPrefix: config.slugPrefix,
  };
  if (config.pluginVersion) {
    coldConfig.pluginVersion = config.pluginVersion;
  }
  return coldConfig;
}

function tokenModule(stackSlug: string): string {
  const name = `pathfinder-e2e-${randomUUID().slice(0, 8)}`;
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

provider "grafana" {
  alias = "cloud"
  cloud_access_policy_token = var.cloud_access_policy_token
}

resource "grafana_cloud_stack_service_account" "runner" {
  provider = grafana.cloud
  stack_slug = ${hclString(stackSlug)}
  name = ${hclString(name)}
  role = "Admin"
}

resource "grafana_cloud_stack_service_account_token" "runner" {
  provider = grafana.cloud
  stack_slug = ${hclString(stackSlug)}
  name = ${hclString(name)}
  service_account_id = grafana_cloud_stack_service_account.runner.id
  seconds_to_live = ${CLOUD_STACK_TOKEN_TTL_SECONDS}
}

output "service_account_token" {
  value = grafana_cloud_stack_service_account_token.runner.key
  sensitive = true
}
`;
}

function replacementStackLabels(poolId: string | undefined, createdAtSeconds: number): Record<string, string> {
  return {
    [PATHFINDER_E2E_LABELS.pool]: PATHFINDER_E2E_LABEL_VALUES.true,
    ...(poolId ? { [PATHFINDER_E2E_LABELS.poolId]: poolId } : {}),
    [PATHFINDER_E2E_LABELS.state]: PATHFINDER_E2E_LABEL_VALUES.available,
    [PATHFINDER_E2E_LABELS.kind]: PATHFINDER_E2E_LABEL_VALUES.pool,
    [PATHFINDER_E2E_LABELS.createdAt]: String(createdAtSeconds),
  };
}

function replacementStackModule(options: { slug: string; labels: Record<string, string> }): string {
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
  default = "latest"
}

provider "grafana" {
  alias = "cloud"
  cloud_access_policy_token = var.cloud_access_policy_token
}

resource "grafana_cloud_stack" "pool" {
  provider = grafana.cloud
  name = ${hclString(options.slug)}
  slug = ${hclString(options.slug)}
  region_slug = var.cloud_stack_region
  delete_protection = false
  labels = {
${hclStringMap(options.labels)}
  }
}

resource "grafana_cloud_plugin_installation" "pathfinder" {
  provider = grafana.cloud
  stack_slug = grafana_cloud_stack.pool.slug
  slug = ${hclString(PLUGIN_ID)}
  version = var.pathfinder_plugin_version
}
`;
}

function parseTokenOutput(text: string): string {
  const parsed = JSON.parse(text) as TerraformTokenOutput;
  const token = parsed.service_account_token?.value;
  if (typeof token !== 'string') {
    throw new Error('terraform output did not include service_account_token string value.');
  }
  return token;
}

function stackUrl(stack: CloudStackListItem): string | undefined {
  if (stack.slug && CLOUD_STACK_SLUG_PATTERN.test(stack.slug)) {
    return new URL(`https://${stack.slug}.grafana.net/`).toString();
  }
  return undefined;
}

function stackRegion(stack: CloudStackListItem): string | undefined {
  return stack.regionSlug ?? stack.region_slug ?? stack.region;
}

function deleteProtectionEnabled(stack: CloudStackListItem): boolean {
  return stack.deleteProtection === true || stack.delete_protection === true;
}

function isAvailableState(stack: CloudStackListItem): boolean {
  const state = stack.labels?.[PATHFINDER_E2E_LABELS.state];
  return state === undefined || state === PATHFINDER_E2E_LABEL_VALUES.available;
}

function poolLabelMatches(stack: CloudStackListItem): boolean {
  return stack.labels?.[PATHFINDER_E2E_LABELS.pool] === PATHFINDER_E2E_LABEL_VALUES.true;
}

function poolIdMatches(stack: CloudStackListItem, poolId: string | undefined): boolean {
  return poolId === undefined || stack.labels?.[PATHFINDER_E2E_LABELS.poolId] === poolId;
}

function stackDetailUrl(slug: string): string {
  return new URL(encodeURIComponent(slug), `${CLOUD_INSTANCES_API_URL}/`).toString();
}

async function hydrateStackDetails(
  stacks: CloudStackListItem[],
  headers: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<CloudStackListItem[]> {
  return Promise.all(
    stacks.map(async (stack) => {
      if (stack.labels !== undefined || !stack.slug) {
        return stack;
      }
      try {
        const response = await fetchImpl(stackDetailUrl(stack.slug), {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(CLOUD_STACK_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
          return stack;
        }
        const detail = (await response.json()) as CloudStackListItem;
        return { ...stack, ...detail };
      } catch {
        return stack;
      }
    })
  );
}

export async function createCloudStackPoolStack(options: CreateCloudStackPoolStackOptions): Promise<string> {
  const runner = options.runner ?? defaultCommandRunner;
  const slug = generatedCloudStackSlug(options.slugPrefix);
  const moduleDir = mkdtempSync(join(tmpdir(), 'pathfinder-e2e-pool-replace-'));
  chmodSync(moduleDir, 0o700);
  const modulePath = join(moduleDir, 'main.tf');
  const labels = replacementStackLabels(options.poolId, Math.floor(Date.now() / 1000));
  const secrets = [options.accessPolicyToken];

  try {
    writeFileSync(modulePath, replacementStackModule({ slug, labels }));
    const env = terraformEnv({
      accessPolicyToken: options.accessPolicyToken,
      region: options.region,
      pluginVersion: options.pluginVersion ?? 'latest',
    });
    const steps: Array<{ action: string; args: string[] }> = [
      { action: 'init', args: ['init', '-input=false', '-no-color'] },
      { action: 'apply', args: ['apply', '-input=false', '-auto-approve', '-no-color'] },
    ];
    for (const step of steps) {
      const result = await runner('terraform', step.args, { cwd: moduleDir, env });
      assertCommandSuccess(result, step.action, secrets);
    }
    if (options.verbose) {
      console.log(`   ☁️ Created replacement Cloud stack pool member ${slug}`);
    }
    return slug;
  } catch (err) {
    throw new Error(redact(errorMessage(err), secrets));
  } finally {
    rmSync(moduleDir, { recursive: true, force: true });
  }
}

export class CloudStackPool {
  private readonly leasedSlugs = new Set<string>();
  private lastDiagnostics: string | undefined;

  constructor(
    private readonly config: CloudStackPoolConfig,
    private readonly verbose: boolean,
    private readonly runner: CommandRunner = defaultCommandRunner,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async lease(): Promise<CloudStackPoolLease | undefined> {
    const candidates = await this.availableStacks();
    const rejectedAfterToken: string[] = [];

    for (const candidate of candidates) {
      this.leasedSlugs.add(candidate.stackSlug);
      let lease: CloudStackPoolLease | undefined;
      try {
        lease = await this.createLease(candidate);
      } catch (err) {
        this.leasedSlugs.delete(candidate.stackSlug);
        throw err;
      }

      const pluginProbe = await lease.pathfinderPluginProbe();
      if (pluginProbe.installed) {
        this.addRejectedDiagnostics(rejectedAfterToken);
        return lease;
      }

      rejectedAfterToken.push(`${candidate.stackSlug}: ${pluginProbe.message}`);
      rejectedAfterToken.push(...(await lease.teardownTokenOnly()));
    }

    this.addRejectedDiagnostics(rejectedAfterToken);
    return undefined;
  }

  diagnostics(): string | undefined {
    return this.lastDiagnostics;
  }

  private addRejectedDiagnostics(rejectedAfterToken: string[]): void {
    if (rejectedAfterToken.length > 0) {
      this.lastDiagnostics = `${this.lastDiagnostics ?? 'No pool diagnostics available.'} ${rejectedAfterToken.join('; ')}.`;
    }
  }

  private async createLease(candidate: LeasablePoolStack): Promise<CloudStackPoolLease> {
    const moduleDir = mkdtempSync(join(tmpdir(), 'pathfinder-e2e-pool-lease-'));
    chmodSync(moduleDir, 0o700);
    const modulePath = join(moduleDir, 'main.tf');
    const secrets = [this.config.accessPolicyToken];

    try {
      writeFileSync(modulePath, tokenModule(candidate.stackSlug));
      const env = terraformEnv({ accessPolicyToken: this.config.accessPolicyToken });
      await this.runTerraform(moduleDir, ['init', '-input=false', '-no-color'], 'init', env, secrets);
      await this.runTerraform(
        moduleDir,
        ['apply', '-input=false', '-auto-approve', '-no-color'],
        'apply',
        env,
        secrets
      );
      const output = await this.runTerraform(moduleDir, ['output', '-json', '-no-color'], 'output', env, secrets);
      const token = parseTokenOutput(output.stdout);
      return new CloudStackPoolLease(
        { kind: 'pool', targetUrl: candidate.targetUrl, token, stackSlug: candidate.stackSlug },
        candidate.region ?? this.config.region,
        moduleDir,
        this.config,
        this.verbose,
        this.runner,
        this.fetchImpl
      );
    } catch (err) {
      rmSync(moduleDir, { recursive: true, force: true });
      throw new Error(redact(errorMessage(err), secrets));
    }
  }

  private async availableStacks(): Promise<LeasablePoolStack[]> {
    const headers = {
      Authorization: `Bearer ${this.config.accessPolicyToken}`,
      Accept: 'application/json',
    };
    const response = await this.fetchImpl(CLOUD_INSTANCES_API_URL, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(CLOUD_STACK_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const poolLabel = this.config.poolId ?? 'any';
      throw new Error(`Could not list Cloud stack pool "${poolLabel}": HTTP ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as CloudStackListResponse;
    const items = await hydrateStackDetails(data.items ?? [], headers, this.fetchImpl);
    const poolStacks = items.filter(poolLabelMatches);
    const matchingPoolId = poolStacks.filter((stack) => poolIdMatches(stack, this.config.poolId));
    const available = matchingPoolId.filter(isAvailableState);
    const leaseable = available.filter((stack) => {
      const targetUrl = stackUrl(stack);
      return Boolean(
        stack.slug &&
        targetUrl &&
        !deleteProtectionEnabled(stack) &&
        !this.leasedSlugs.has(stack.slug) &&
        CLOUD_STACK_SLUG_PATTERN.test(stack.slug)
      );
    });
    const poolLabel = this.config.poolId ?? 'any';
    this.lastDiagnostics = `listed ${items.length} stack(s); ${poolStacks.length} had pathfinder-e2e-pool=true; ${matchingPoolId.length} matched pool id ${poolLabel}; ${available.length} were available; ${leaseable.length} were leaseable.`;
    if (this.verbose) {
      console.log(`   ☁️ Cloud stack pool: ${this.lastDiagnostics}`);
    }
    return leaseable.flatMap((stack) => {
      const targetUrl = stackUrl(stack);
      return targetUrl && stack.slug ? [{ targetUrl, stackSlug: stack.slug, region: stackRegion(stack) }] : [];
    });
  }

  private async runTerraform(
    cwd: string,
    args: string[],
    action: string,
    env: NodeJS.ProcessEnv,
    secrets: string[]
  ): Promise<CommandResult> {
    const result = await this.runner('terraform', args, { cwd, env });
    assertCommandSuccess(result, action, secrets);
    return result;
  }
}

export class CloudStackPoolLease implements CloudChainEnvironment {
  private moduleDir: string | null;
  private readonly secrets: string[];
  private teardownPromise: Promise<string[]> | null = null;
  private tokenTeardownPromise: Promise<string[]> | null = null;

  constructor(
    private readonly stack: ProvisionedCloudStack,
    private readonly replacementRegion: string | undefined,
    moduleDir: string,
    private readonly config: CloudStackPoolConfig,
    private readonly verbose: boolean,
    private readonly runner: CommandRunner = defaultCommandRunner,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.moduleDir = moduleDir;
    this.secrets = [config.accessPolicyToken, stack.token];
  }

  async provisionChain(): Promise<ProvisionedCloudStack> {
    return this.stack;
  }

  teardownChain(): Promise<string[]> {
    return (this.teardownPromise ??= this.runTeardown());
  }

  teardownTokenOnly(): Promise<string[]> {
    return (this.tokenTeardownPromise ??= this.runTokenTeardown());
  }

  async pathfinderPluginProbe(): Promise<{ installed: boolean; message: string }> {
    const url = new URL(`/api/plugins/${PLUGIN_ID}/settings`, this.stack.targetUrl).toString();
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.stack.token}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(CLOUD_STACK_FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        return { installed: true, message: 'Pathfinder plugin installed' };
      }
      if (response.status === 404) {
        return { installed: false, message: 'Pathfinder plugin missing' };
      }
      return {
        installed: false,
        message: `Pathfinder plugin probe failed: HTTP ${response.status} ${response.statusText}`,
      };
    } catch (err) {
      return { installed: false, message: `Pathfinder plugin probe failed: ${errorMessage(err)}` };
    }
  }

  private async runTeardown(): Promise<string[]> {
    const warnings = await this.teardownTokenOnly();

    if (!(await this.deleteStack(warnings))) {
      return warnings;
    }
    if (!this.replacementRegion) {
      warnings.push(
        `Cloud stack pool lease ${this.stack.stackSlug} was retired, but no region was available to create a replacement. Pass --cloud-stack-region to replenish immediately.`
      );
      return warnings;
    }

    try {
      const replacementSlug = await createCloudStackPoolStack({
        accessPolicyToken: this.config.accessPolicyToken,
        region: this.replacementRegion,
        poolId: this.config.poolId,
        slugPrefix: this.config.slugPrefix,
        pluginVersion: this.config.pluginVersion,
        verbose: this.verbose,
        runner: this.runner,
      });
      if (this.verbose) {
        console.log(`   ☁️ Replaced retired pool stack ${this.stack.stackSlug} with ${replacementSlug}`);
      }
    } catch (err) {
      warnings.push(`Failed to replace retired Cloud stack pool lease ${this.stack.stackSlug}: ${errorMessage(err)}`);
    }
    return warnings;
  }

  private async runTokenTeardown(): Promise<string[]> {
    const moduleDir = this.moduleDir;
    if (!moduleDir) {
      return [];
    }

    const warnings: string[] = [];
    try {
      const result = await this.runner(
        'terraform',
        ['destroy', '-input=false', '-auto-approve', '-lock-timeout=60s', '-no-color'],
        {
          cwd: moduleDir,
          env: terraformEnv({ accessPolicyToken: this.config.accessPolicyToken }),
        }
      );
      assertCommandSuccess(result, 'destroy', this.secrets);
    } catch (err) {
      warnings.push(
        `Failed to remove runner token for Cloud stack pool lease ${this.stack.stackSlug}: ${redact(
          errorMessage(err),
          this.secrets
        )}`
      );
    } finally {
      rmSync(moduleDir, { recursive: true, force: true });
      this.moduleDir = null;
    }
    return warnings;
  }

  private async deleteStack(warnings: string[]): Promise<boolean> {
    try {
      const response = await this.fetchImpl(stackDetailUrl(this.stack.stackSlug), {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.config.accessPolicyToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(CLOUD_STACK_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      if (this.verbose) {
        console.log(`   🧹 Retired Cloud stack pool lease ${this.stack.stackSlug}`);
      }
      return true;
    } catch (err) {
      warnings.push(
        `Failed to retire Cloud stack pool lease ${this.stack.stackSlug}: ${redact(errorMessage(err), this.secrets)}`
      );
      return false;
    }
  }
}
