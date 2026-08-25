interface SensitiveOperationResponse<T> {
  kind: string;
  value: T;
}

export function useSensitiveOperationResult() {
  const api = useRemoteApi();
  const { waitForOperation } = useOperation();

  async function waitForSensitiveResult<T>(
    accepted: AcceptedOperation,
    expectedKind: string,
    timeoutMs: number,
  ): Promise<T> {
    await waitForOperation(accepted.operationId, { timeoutMs });
    const response = await api.post<SensitiveOperationResponse<T>>(
      `/operations/${accepted.operationId}/sensitive-result`,
      {},
      {
        headers: {
          'Idempotency-Key': `operation-sensitive-${accepted.operationId}`,
        },
      },
    );
    if (response.kind !== expectedKind || !response.value) {
      throw new Error('Operation returned an unexpected sensitive result');
    }
    return response.value;
  }

  return { waitForSensitiveResult };
}
