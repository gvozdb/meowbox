export type DeployRuntime = 'php' | 'node' | 'files';

const SUPPORTED_PRESETS = new Set(['MODX_REVO', 'MODX_3', 'CUSTOM']);

export function resolveDeployRuntime(
  preset: unknown,
  appPort: unknown,
): DeployRuntime {
  if (!SUPPORTED_PRESETS.has(String(preset))) {
    throw new Error(`Unsupported application preset "${String(preset)}"`);
  }

  if (preset === 'MODX_REVO' || preset === 'MODX_3') {
    if (appPort !== null && appPort !== undefined) {
      throw new Error('MODX application cannot have a Node.js app port');
    }
    return 'php';
  }

  if (appPort === null || appPort === undefined) {
    return 'files';
  }
  if (!Number.isInteger(appPort) || Number(appPort) < 1 || Number(appPort) > 65_535) {
    throw new Error('Invalid Node.js app port');
  }
  return 'node';
}
