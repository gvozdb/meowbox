/** Selected data-plane facade. On main, requests remain local. */
export function useRemoteApi() {
  return useApi('selected-target');
}
