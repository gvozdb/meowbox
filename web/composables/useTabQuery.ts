import type { LocationQueryValue } from 'vue-router';

/**
 * Синхронизирует активную вкладку с query-параметром адресной строки.
 * При F5 вкладка восстанавливается из URL, остальные query-параметры сохраняются.
 *
 * @param validIds — список допустимых id вкладок (для валидации `?tab=...`)
 * @param defaultId — id вкладки по умолчанию (если в URL ничего нет или значение невалидно)
 * @param queryKey — имя query-параметра (по умолчанию `tab`)
 * @returns ref с активной вкладкой; запись в него обновляет URL через router.replace
 */
export function useTabQuery(
  validIds: readonly string[] | (() => readonly string[]),
  defaultId: string,
  queryKey = 'tab',
) {
  const route = useRoute();
  const router = useRouter();

  const getValid = (): readonly string[] =>
    typeof validIds === 'function' ? validIds() : validIds;

  const readFromQuery = (): string => {
    const raw = route.query[queryKey];
    const value = Array.isArray(raw) ? (raw[0] as LocationQueryValue) : raw;
    if (typeof value === 'string' && getValid().includes(value)) return value;
    return defaultId;
  };

  const activeTab = ref(readFromQuery());

  // Реакция на внешние изменения URL (back/forward, ручная правка, ссылка).
  watch(
    () => route.query[queryKey],
    () => {
      const next = readFromQuery();
      if (next !== activeTab.value) activeTab.value = next;
    },
  );

  // Реакция на пользовательский клик по вкладке — пишем в URL.
  watch(activeTab, (val) => {
    const current = route.query[queryKey];
    const currentStr = Array.isArray(current) ? current[0] : current;
    // Дефолт не светим в URL — чище ссылка.
    const target = val === defaultId ? undefined : val;
    if ((currentStr ?? undefined) === target) return;

    const nextQuery = { ...route.query };
    if (target === undefined) delete nextQuery[queryKey];
    else nextQuery[queryKey] = target;

    router.replace({ query: nextQuery, hash: route.hash });
  });

  return activeTab;
}
