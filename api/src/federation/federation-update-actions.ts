import type { RemoteActionCapability } from '@meowbox/shared';

export const FEDERATED_TARGET_UPDATE_ACTIONS = [
  'http.post.federation-v1-target-update',
  'http.get.federation-v1-target-update-status',
  'http.get.federation-v1-target-update-manifest',
] as const;

export function hasFederatedTargetUpdateCapabilities(
  capabilities: Readonly<Record<string, RemoteActionCapability>>,
): boolean {
  return FEDERATED_TARGET_UPDATE_ACTIONS.every((actionId) => {
    const capability = capabilities[actionId];
    return capability?.enabled === true && capability.roles.includes('ADMIN');
  });
}
