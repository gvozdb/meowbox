import { AsyncLocalStorage } from 'node:async_hooks';

export interface AgentJobExecutionContext {
  jobId: string;
  operationId: string;
  cancelSafe: boolean;
}

const storage = new AsyncLocalStorage<AgentJobExecutionContext>();

export function runInAgentJobContext<T>(
  context: AgentJobExecutionContext,
  callback: () => Promise<T>,
): Promise<T> {
  return storage.run(context, callback);
}

export function currentAgentJobContext(): AgentJobExecutionContext | undefined {
  return storage.getStore();
}
