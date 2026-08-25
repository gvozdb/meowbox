export function assertNoSecretFields(value: unknown, path = 'result'): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretFields(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    // Signed manifest maps use action IDs as keys; names such as
    // `reset-password` describe behavior and are not credential fields.
    const actionCatalogueKey = path.endsWith('.manifest.actions') &&
      /^[a-z][a-z0-9.-]{1,255}$/.test(key);
    if (
      /(password|secret|token|credential|private.?key|envvars)/i.test(key) &&
      !actionCatalogueKey
    ) {
      throw new Error(`${path} contains forbidden secret field: ${path}.${key}`);
    }
    assertNoSecretFields(nested, `${path}.${key}`);
  }
}
