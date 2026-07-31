import {
  renderPhpFpmPool,
  type PhpPoolRenderParams,
  type RenderedPhpPool,
} from './pool-template';

const MAX_PREFLIGHT_POOLS = 256;

export interface PhpPoolPreflightPlan {
  readonly pools: RenderedPhpPool[];
  readonly phpVersions: string[];
}

/**
 * Builds the exact pool artifacts without writing them. Batch-level identity
 * checks catch collisions that are invisible when every domain is rendered
 * independently.
 */
export function buildPhpPoolPreflightPlan(
  params: readonly PhpPoolRenderParams[],
): PhpPoolPreflightPlan {
  if (!Array.isArray(params)) {
    throw new Error('PHP pool preflight payload must be an array');
  }
  if (params.length > MAX_PREFLIGHT_POOLS) {
    throw new Error(`PHP pool preflight exceeds ${MAX_PREFLIGHT_POOLS} domains`);
  }

  const pools = params.map((pool) => renderPhpFpmPool(pool));
  const domainIds = new Set<string>();
  const runtimeKeys = new Set<string>();
  const poolFiles = new Set<string>();
  const socketPaths = new Set<string>();

  for (const [index, pool] of pools.entries()) {
    const domainId = params[index].domainId;
    const socketPath = pool.runtime.socketPath;
    if (!socketPath) {
      throw new Error(`PHP pool "${pool.runtime.runtimeKey}" has no socket`);
    }
    if (domainIds.has(domainId)) {
      throw new Error(`Duplicate SiteDomain "${domainId}" in PHP pool preflight`);
    }
    if (runtimeKeys.has(pool.runtime.runtimeKey)) {
      throw new Error(`Duplicate runtimeKey "${pool.runtime.runtimeKey}" in PHP pool preflight`);
    }
    if (poolFiles.has(pool.poolFile)) {
      throw new Error(`Duplicate PHP-FPM pool file "${pool.poolFile}" in preflight`);
    }
    if (socketPaths.has(socketPath)) {
      throw new Error(`Duplicate PHP-FPM socket "${socketPath}" in preflight`);
    }
    domainIds.add(domainId);
    runtimeKeys.add(pool.runtime.runtimeKey);
    poolFiles.add(pool.poolFile);
    socketPaths.add(socketPath);
  }

  return {
    pools,
    phpVersions: [...new Set(pools.map((pool) => pool.phpVersion))].sort(),
  };
}
