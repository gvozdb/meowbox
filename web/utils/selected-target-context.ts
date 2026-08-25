export interface SelectedTargetSnapshot {
  serverId: string;
  transportServerId: string;
  registryGeneration: number;
  contextEpoch: number;
}

export class SelectedTargetContextChangedError extends Error {
  readonly code = 'REMOTE_CONTEXT_CHANGED';

  constructor() {
    super('Selected server changed before the request completed');
    this.name = 'SelectedTargetContextChangedError';
  }
}

export function sameSelectedTargetContext(
  left: SelectedTargetSnapshot,
  right: SelectedTargetSnapshot | null,
): boolean {
  return right !== null &&
    left.serverId === right.serverId &&
    left.transportServerId === right.transportServerId &&
    left.registryGeneration === right.registryGeneration &&
    left.contextEpoch === right.contextEpoch;
}

export function assertSelectedTargetContext(
  expected: SelectedTargetSnapshot,
  current: SelectedTargetSnapshot | null,
): void {
  if (!sameSelectedTargetContext(expected, current)) {
    throw new SelectedTargetContextChangedError();
  }
}
