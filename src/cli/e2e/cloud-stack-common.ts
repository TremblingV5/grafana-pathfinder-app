import { randomUUID } from 'crypto';

export const TERRAFORM_PROVIDER_VERSION = '~> 4.5';
export const PLUGIN_ID = 'grafana-pathfinder-app';
export const CLOUD_STACK_TOKEN_TTL_SECONDS = 3600;
export const DEFAULT_CLOUD_STACK_SLUG_PREFIX = 'pfe2e';
export const CLOUD_STACK_SLUG_PATTERN = /^[a-z][a-z0-9]{0,28}$/;
const CLOUD_STACK_LABEL_VALUE_PATTERN = /^[a-zA-Z0-9/\-._]+$/;

export const PATHFINDER_E2E_LABELS = {
  base: 'pathfinder-e2e',
  pool: 'pathfinder-e2e-pool',
  poolId: 'pathfinder-e2e-pool-id',
  state: 'pathfinder-e2e-state',
  kind: 'pathfinder-e2e-kind',
  createdAt: 'pathfinder-e2e-created-at',
  runId: 'pathfinder-e2e-run-id',
} as const;

export const PATHFINDER_E2E_LABEL_VALUES = {
  true: 'true',
  available: 'available',
  coldRun: 'cold-run',
  pool: 'pool',
} as const;

export interface CloudStackProvisioningConfig {
  accessPolicyTokenEnvVar: string;
  accessPolicyToken: string;
  region: string;
  slugPrefix: string;
  pluginVersion?: string;
}

export function generatedCloudStackSlug(prefix: string): string {
  const suffix = `${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 6)}`;
  return `${prefix}${suffix}`.slice(0, 29);
}

export function normalizeCloudStackSlugPrefix(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!/^[a-z][a-z0-9]*$/.test(normalized)) {
    throw new Error(
      '--cloud-stack-slug-prefix must contain at least one letter and only alphanumeric characters after normalization.'
    );
  }
  return normalized.slice(0, 12);
}

export function requireNonEmptyOption(value: string | undefined, missingMessage: string): string {
  if (value === undefined) {
    throw new Error(missingMessage);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${missingMessage} The provided value must not be empty.`);
  }
  return trimmed;
}

export function optionalNonEmptyOption(value: string | undefined, optionName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${optionName} must not be empty.`);
  }
  return trimmed;
}

export function validateCloudStackLabelValue(value: string | undefined, optionName: string): string | undefined {
  const trimmed = optionalNonEmptyOption(value, optionName);
  if (trimmed === undefined) {
    return undefined;
  }
  if (!CLOUD_STACK_LABEL_VALUE_PATTERN.test(trimmed)) {
    throw new Error(`${optionName} must match ${CLOUD_STACK_LABEL_VALUE_PATTERN.source}.`);
  }
  return trimmed;
}
