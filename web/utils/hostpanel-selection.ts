export interface HostpanelSelectionItem {
  id: string;
  status: string;
  plan: {
    blockedReason?: string | null;
    defaultSelected?: boolean;
  };
}

export function getSelectableHostpanelItemIds(
  items: readonly HostpanelSelectionItem[],
): string[] {
  return items
    .filter((item) => !item.plan.blockedReason && item.status !== 'SKIPPED')
    .map((item) => item.id);
}

export function getDefaultSelectedHostpanelItemIds(
  items: readonly HostpanelSelectionItem[],
): string[] {
  return items
    .filter((item) => (
      !item.plan.blockedReason
      && item.status !== 'SKIPPED'
      && item.plan.defaultSelected !== false
    ))
    .map((item) => item.id);
}

export function getCurrentSelectionIds(
  currentItemIds: readonly string[],
  selectedItemIds: Iterable<string>,
): string[] {
  const selected = new Set(selectedItemIds);
  return [...new Set(currentItemIds)].filter((id) => selected.has(id));
}

export function createCurrentSelection(
  currentItemIds: readonly string[],
  selectedItemIds: Iterable<string>,
): Set<string> {
  return new Set(getCurrentSelectionIds(currentItemIds, selectedItemIds));
}

export function toggleCurrentSelection(
  currentItemIds: readonly string[],
  selectedItemIds: Iterable<string>,
  itemId: string,
): Set<string> {
  const currentIds = new Set(currentItemIds);
  const next = createCurrentSelection(currentItemIds, selectedItemIds);
  if (!currentIds.has(itemId)) return next;
  if (next.has(itemId)) next.delete(itemId);
  else next.add(itemId);
  return next;
}
