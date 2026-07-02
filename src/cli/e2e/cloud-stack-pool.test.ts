import { existsSync, readFileSync } from 'fs';

import {
  CloudStackPool,
  coldConfigFromPoolConfig,
  createCloudStackPoolConfig,
  createCloudStackPoolStack,
  type CloudStackPoolConfig,
} from './cloud-stack-pool';
import type { CommandRunner } from './cloud-stack-terraform';

const CONFIG: CloudStackPoolConfig = {
  accessPolicyTokenEnvVar: 'GRAFANA_CLOUD_ACCESS_POLICY_TOKEN',
  accessPolicyToken: 'secret-token',
  region: 'prod-us-east-0',
  slugPrefix: 'pfe2e',
  pluginVersion: '1.2.3',
  poolId: 'alpha',
};

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: jest.fn(async () => body),
  } as unknown as Response;
}

function emptyResponse(status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
  } as unknown as Response;
}

function tokenOutput(token = 'glsa_runner'): string {
  return JSON.stringify({ service_account_token: { value: token } });
}

function successfulRunner(calls: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }>): CommandRunner {
  return async (_command, args, options) => {
    calls.push({ args, cwd: options.cwd, env: options.env });
    if (args[0] === 'output') {
      return { exitCode: 0, stdout: tokenOutput(), stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

describe('createCloudStackPoolConfig', () => {
  it('returns undefined when no stack options are present', () => {
    expect(createCloudStackPoolConfig({ env: {} })).toBeUndefined();
  });

  it('loads the access policy token and normalizes options', () => {
    expect(
      createCloudStackPoolConfig({
        accessPolicyTokenEnvVar: 'TOKEN_ENV',
        region: 'prod-us-east-0',
        slugPrefix: 'Pathfinder E2E!',
        pluginVersion: '1.2.3',
        poolId: 'pool.alpha-1',
        env: { TOKEN_ENV: 'token' },
      })
    ).toEqual({
      accessPolicyTokenEnvVar: 'TOKEN_ENV',
      accessPolicyToken: 'token',
      region: 'prod-us-east-0',
      slugPrefix: 'pathfindere2',
      pluginVersion: '1.2.3',
      poolId: 'pool.alpha-1',
    });
  });

  it('rejects invalid or partial pool config', () => {
    expect(() => createCloudStackPoolConfig({ poolId: 'alpha', env: {} })).toThrow(/cloud-stack-access-policy-token/);
    expect(() => createCloudStackPoolConfig({ accessPolicyTokenEnvVar: 'TOKEN_ENV', env: {} })).toThrow(/TOKEN_ENV/);
    expect(() => createCloudStackPoolConfig({ accessPolicyTokenEnvVar: '1_BAD', env: { '1_BAD': 'x' } })).toThrow(
      /Invalid/
    );
    expect(() =>
      createCloudStackPoolConfig({
        accessPolicyTokenEnvVar: 'TOKEN_ENV',
        poolId: 'bad value',
        env: { TOKEN_ENV: 'x' },
      })
    ).toThrow(/cloud-stack-pool-id/);
  });
});

describe('coldConfigFromPoolConfig', () => {
  it('returns undefined when no cold-provisioning region is configured', () => {
    expect(coldConfigFromPoolConfig({ ...CONFIG, region: undefined })).toBeUndefined();
  });

  it('derives cold stack config when a region is available', () => {
    expect(coldConfigFromPoolConfig(CONFIG)).toEqual({
      accessPolicyTokenEnvVar: 'GRAFANA_CLOUD_ACCESS_POLICY_TOKEN',
      accessPolicyToken: 'secret-token',
      region: 'prod-us-east-0',
      slugPrefix: 'pfe2e',
      pluginVersion: '1.2.3',
    });
  });
});

describe('CloudStackPool', () => {
  it('hydrates list entries, leases an available pool stack, retires it, and creates a replacement', async () => {
    const runnerCalls: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
    const fetchImpl = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://grafana.com/api/instances') {
        return jsonResponse({
          items: [
            { slug: 'poola' },
            {
              slug: 'leased',
              labels: {
                'pathfinder-e2e-pool': 'true',
                'pathfinder-e2e-pool-id': 'alpha',
                'pathfinder-e2e-state': 'leased',
              },
            },
            { slug: 'other', labels: { 'pathfinder-e2e-pool': 'true', 'pathfinder-e2e-pool-id': 'beta' } },
          ],
        });
      }
      if (url === 'https://grafana.com/api/instances/poola') {
        return jsonResponse({
          slug: 'poola',
          regionSlug: 'prod-us-east-0',
          labels: { 'pathfinder-e2e-pool': 'true', 'pathfinder-e2e-pool-id': 'alpha' },
        });
      }
      if (url === 'https://poola.grafana.net/api/plugins/grafana-pathfinder-app/settings') {
        return emptyResponse();
      }
      if (url === 'https://grafana.com/api/instances/poola') {
        return emptyResponse();
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    const pool = new CloudStackPool(CONFIG, false, successfulRunner(runnerCalls), fetchImpl);

    const lease = await pool.lease();

    await expect(lease?.provisionChain()).resolves.toEqual({
      kind: 'pool',
      targetUrl: 'https://poola.grafana.net/',
      token: 'glsa_runner',
      stackSlug: 'poola',
    });
    expect(pool.diagnostics()).toBe(
      'listed 3 stack(s); 3 had pathfinder-e2e-pool=true; 2 matched pool id alpha; 1 were available; 1 were leaseable.'
    );

    await expect(lease!.teardownChain()).resolves.toEqual([]);

    expect(runnerCalls.map((call) => call.args[0])).toEqual(['init', 'apply', 'output', 'destroy', 'init', 'apply']);
    expect(runnerCalls.every((call) => call.env.TF_VAR_cloud_access_policy_token === 'secret-token')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://grafana.com/api/instances/poola',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('skips pool stacks that are missing Pathfinder and tries the next candidate', async () => {
    const runnerCalls: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
    const fetchImpl = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://grafana.com/api/instances') {
        return jsonResponse({
          items: [
            { slug: 'missing', labels: { 'pathfinder-e2e-pool': 'true' } },
            { slug: 'ready', labels: { 'pathfinder-e2e-pool': 'true' } },
          ],
        });
      }
      if (url === 'https://missing.grafana.net/api/plugins/grafana-pathfinder-app/settings') {
        return emptyResponse(404, 'Not Found');
      }
      if (url === 'https://ready.grafana.net/api/plugins/grafana-pathfinder-app/settings') {
        return emptyResponse();
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    const pool = new CloudStackPool({ ...CONFIG, poolId: undefined }, false, successfulRunner(runnerCalls), fetchImpl);

    const lease = await pool.lease();

    await expect(lease?.provisionChain()).resolves.toEqual(
      expect.objectContaining({ kind: 'pool', stackSlug: 'ready' })
    );
    expect(pool.diagnostics()).toContain('missing: Pathfinder plugin missing');
    expect(runnerCalls.map((call) => call.args[0])).toEqual([
      'init',
      'apply',
      'output',
      'destroy',
      'init',
      'apply',
      'output',
    ]);
  });

  it('redacts the access policy token in Terraform lease errors', async () => {
    const runner: CommandRunner = async (_command, args) => {
      if (args[0] === 'apply') {
        return { exitCode: 1, stdout: '', stderr: 'bad secret-token' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const fetchImpl = jest.fn(async (input: string | URL | Request) => {
      if (String(input) === 'https://grafana.com/api/instances') {
        return jsonResponse({
          items: [{ slug: 'poola', labels: { 'pathfinder-e2e-pool': 'true', 'pathfinder-e2e-pool-id': 'alpha' } }],
        });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    }) as unknown as typeof fetch;

    await expect(new CloudStackPool(CONFIG, false, runner, fetchImpl).lease()).rejects.toThrow('bad [redacted]');
  });

  it('returns a warning when replacement creation fails after retiring a lease', async () => {
    const fetchImpl = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://grafana.com/api/instances') {
        return jsonResponse({
          items: [{ slug: 'poola', labels: { 'pathfinder-e2e-pool': 'true', 'pathfinder-e2e-pool-id': 'alpha' } }],
        });
      }
      if (url === 'https://poola.grafana.net/api/plugins/grafana-pathfinder-app/settings') {
        return emptyResponse();
      }
      if (url === 'https://grafana.com/api/instances/poola') {
        return emptyResponse();
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    let applyCount = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (args[0] === 'output') {
        return { exitCode: 0, stdout: tokenOutput(), stderr: '' };
      }
      if (args[0] === 'apply') {
        applyCount += 1;
        if (applyCount === 2) {
          return { exitCode: 1, stdout: '', stderr: 'replacement failed secret-token' };
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const lease = await new CloudStackPool(CONFIG, false, runner, fetchImpl).lease();

    await expect(lease!.teardownChain()).resolves.toEqual([
      'Failed to replace retired Cloud stack pool lease poola: terraform apply failed: replacement failed [redacted]',
    ]);
  });
});

describe('createCloudStackPoolStack', () => {
  it('creates a replacement stack with pool labels and the Pathfinder plugin resource', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
    const calls: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
    let generatedHcl = '';
    const runner: CommandRunner = async (_command, args, options) => {
      calls.push({ args, cwd: options.cwd, env: options.env });
      generatedHcl = readFileSync(`${options.cwd}/main.tf`, 'utf-8');
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const slug = await createCloudStackPoolStack({ ...CONFIG, region: 'prod-us-east-0', verbose: false, runner });

    expect(slug).toMatch(/^pfe2e/);
    expect(generatedHcl).toContain('resource "grafana_cloud_stack" "pool"');
    expect(generatedHcl).toContain('resource "grafana_cloud_plugin_installation" "pathfinder"');
    expect(generatedHcl).toContain('"pathfinder-e2e-pool" = "true"');
    expect(generatedHcl).toContain('"pathfinder-e2e-pool-id" = "alpha"');
    expect(generatedHcl).toContain('region_slug = var.cloud_stack_region');
    expect(generatedHcl).toContain('version = var.pathfinder_plugin_version');
    expect(generatedHcl).not.toContain('secret-token');
    expect(generatedHcl).not.toContain('prod-us-east-0');
    expect(calls.map((call) => call.args[0])).toEqual(['init', 'apply']);
    expect(calls.every((call) => call.env.TF_VAR_cloud_stack_region === 'prod-us-east-0')).toBe(true);
    expect(calls.every((call) => call.env.TF_VAR_pathfinder_plugin_version === '1.2.3')).toBe(true);
    expect(existsSync(calls[0]!.cwd)).toBe(false);
  });
});
