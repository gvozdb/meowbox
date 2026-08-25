import type { RemoteCapabilityRequirement } from '~/utils/remote-capability';
import { evaluateRemoteCapability } from '~/utils/remote-capability';

export function useRemoteCapability() {
  const serverStore = useServerStore();
  const authStore = useAuthStore();

  const evaluate = (requirement?: RemoteCapabilityRequirement) =>
    evaluateRemoteCapability({
      isLocal: serverStore.isLocal,
      context: serverStore.remoteContext,
      role: authStore.user?.role ?? null,
      requirement,
    });

  const can = (actionId: string, requirement: Omit<RemoteCapabilityRequirement, 'actionId'> = {}) =>
    evaluate({ ...requirement, actionId }).available;

  const reason = (actionId: string, requirement: Omit<RemoteCapabilityRequirement, 'actionId'> = {}) =>
    evaluate({ ...requirement, actionId });

  return { evaluate, can, reason };
}
