import type {
  FederationManifestEndpointSet,
  SignedFederationManifest,
} from '@meowbox/shared';
import type { PanelAccessSettings } from './panel-access.service';

export const PANEL_ACCESS_CUTOVER_ACTION =
  'http.post.panel-access-federation-cutovers' as const;
export const PANEL_ACCESS_AGENT_ACTION =
  'agent.panel_access.cutover_stage' as const;

export const PANEL_ACCESS_TARGET_CUTOVER_STATES = [
  'PREPARED',
  'STAGING',
  'STAGED',
  'FINALIZING',
  'FINALIZED',
  'ROLLING_BACK',
  'ROLLED_BACK',
  'NEEDS_ATTENTION',
] as const;

export type PanelAccessTargetCutoverState =
  (typeof PANEL_ACCESS_TARGET_CUTOVER_STATES)[number];

export interface PanelAccessCutoverRequest {
  cutoverId: string;
  domain: string;
  email: string;
  httpsRedirect: boolean;
  denyIpAccess: boolean;
  deadlineAt: string;
}

export interface PanelAccessCandidateEndpoint {
  endpoints: FederationManifestEndpointSet;
  spkiSha256: string;
  manifest: SignedFederationManifest;
}

export interface PanelAccessTargetCutoverJournal {
  schemaVersion: 1;
  cutoverId: string;
  state: PanelAccessTargetCutoverState;
  operationId: string;
  deadlineAt: string;
  previousSettings: PanelAccessSettings;
  previousEndpoint: FederationManifestEndpointSet;
  candidateSettings: PanelAccessSettings | null;
  candidate: PanelAccessCandidateEndpoint | null;
  sanitizedErrorCode: string | null;
  updatedAt: string;
}

export interface PanelAccessAgentStageResult {
  cutoverId: string;
  state: 'STAGED';
  candidateOrigin: string;
  spkiSha256: string;
  candidateSettings: PanelAccessSettings;
}
