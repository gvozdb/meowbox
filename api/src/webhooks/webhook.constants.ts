export const FEDERATED_WEBHOOK_DELIVERY_ACTION_ID =
  'http.post.federation-v1-webhooks-deliveries-delivery-id';
export const FEDERATED_WEBHOOK_SERVICE_SUBJECT = 'webhook-delivery-gateway';
export const FEDERATED_WEBHOOK_SERVICE_PURPOSE = FEDERATED_WEBHOOK_DELIVERY_ACTION_ID;

export const WEBHOOK_QUEUE_LIMIT_DEFAULT = 1_000;
export const WEBHOOK_MAX_ATTEMPTS = 6;
export const WEBHOOK_RETRY_DELAYS_MS = [
  5_000,
  30_000,
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
] as const;
export const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;
export const WEBHOOK_WORKER_CONCURRENCY_DEFAULT = 4;
export const WEBHOOK_LEASE_MS = 30_000;
export const WEBHOOK_DLQ_RETENTION_MS_DEFAULT = 7 * 24 * 60 * 60_000;
