export type CloudChainEnvironmentKind = 'shared' | 'cold' | 'pool';

export interface ProvisionedCloudTarget {
  kind: CloudChainEnvironmentKind;
  targetUrl: string;
  token: string;
  stackSlug?: string;
}

export interface ProvisionedCloudStack extends ProvisionedCloudTarget {
  kind: 'cold' | 'pool';
  stackSlug: string;
}

export interface CloudChainTeardownTarget {
  teardownChain(): Promise<string[]>;
}

export interface CloudChainEnvironment extends CloudChainTeardownTarget {
  provisionChain(): Promise<ProvisionedCloudTarget>;
}
