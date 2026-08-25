/** Control-plane facade. Master-owned paths are also enforced inside useApi. */
export function useMasterApi() {
  return useApi('master');
}
