import { createIdempotencyKey } from './idempotency-key';

export const PANEL_ACCESS_CUTOVER_STATES = [
  'PREPARED',
  'STAGED',
  'ACTIVATED',
  'FINALIZED',
  'ROLLED_BACK',
  'NEEDS_ATTENTION',
] as const;

export type PanelAccessCutoverState = (typeof PANEL_ACCESS_CUTOVER_STATES)[number];

export interface PanelAccessCutoverView {
  id: string;
  serverId: string;
  state: PanelAccessCutoverState;
  deadlineAt: string;
  operationId: string | null;
  candidateOrigin: string | null;
  browserProbeRequired: boolean;
  reasonCode: string | null;
  activatedAt: string | null;
  finalizedAt: string | null;
  rolledBackAt: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exactHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.origin !== value ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) throw new Error('Master вернул небезопасный candidate origin');
  return url.origin;
}

export function validatePanelAccessCutoverView(
  raw: unknown,
  expectedServerId: string,
): PanelAccessCutoverView {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Master вернул неверный Panel Access cutover');
  }
  const value = raw as Record<string, unknown>;
  if (
    typeof value.id !== 'string' || !UUID.test(value.id) ||
    value.serverId !== expectedServerId ||
    !PANEL_ACCESS_CUTOVER_STATES.includes(value.state as PanelAccessCutoverState) ||
    typeof value.deadlineAt !== 'string' || !Number.isFinite(Date.parse(value.deadlineAt)) ||
    (value.operationId !== null && (typeof value.operationId !== 'string' || !UUID.test(value.operationId))) ||
    (value.candidateOrigin !== null && typeof value.candidateOrigin !== 'string') ||
    typeof value.browserProbeRequired !== 'boolean' ||
    (value.reasonCode !== null && typeof value.reasonCode !== 'string') ||
    (value.activatedAt !== null && typeof value.activatedAt !== 'string') ||
    (value.finalizedAt !== null && typeof value.finalizedAt !== 'string') ||
    (value.rolledBackAt !== null && typeof value.rolledBackAt !== 'string')
  ) throw new Error('Master вернул неверный Panel Access cutover');
  if (value.candidateOrigin !== null) exactHttpsOrigin(value.candidateOrigin);
  if (value.state === 'STAGED' && (!value.candidateOrigin || value.browserProbeRequired !== true)) {
    throw new Error('Master вернул неполный Panel Access candidate');
  }
  return value as unknown as PanelAccessCutoverView;
}

export function panelAccessCutoverIdempotencyKey(stage: 'start' | 'confirm' | 'rollback'): string {
  return createIdempotencyKey(`panel-access-${stage}`);
}

export async function probePanelAccessCandidate(
  candidateOrigin: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const origin = exactHttpsOrigin(candidateOrigin);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${origin}/api/federation/v1/health`,
      {
        method: 'HEAD',
        mode: 'no-cors',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      },
    );
    if (response.type !== 'opaque' && !response.ok) {
      throw new Error(`Candidate browser probe failed (${response.status})`);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('Новый target URL недоступен из этого браузера');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
