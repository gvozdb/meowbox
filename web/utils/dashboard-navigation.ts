import type { DashboardProblemAction } from '@meowbox/shared';

function routeEntityId(value: string | null): string | null {
  if (!value || value.length > 128 || /[\u0000-\u001f/\\]/.test(value)) return null;
  return encodeURIComponent(value);
}

export function dashboardActionRoute(action: DashboardProblemAction): string | null {
  const entityId = routeEntityId(action.entityId);

  switch (action.target) {
    case 'MONITORING':
      return '/monitoring';
    case 'SITES':
      return '/sites';
    case 'SITE':
      return entityId ? `/sites/${entityId}` : null;
    case 'SERVICES':
      return '/services';
    case 'BACKUPS':
      return entityId ? `/sites/${entityId}?tab=backups` : '/backups';
    case 'SSL':
      return entityId ? `/sites/${entityId}?tab=ssl` : '/ssl';
    case 'DNS':
      return '/dns/providers';
    case 'UPDATES':
      return '/updates';
    case 'ACTIVITY':
      return '/activity';
    default:
      return null;
  }
}
