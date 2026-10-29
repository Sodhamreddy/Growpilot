import { AsyncLocalStorage } from "node:async_hooks";
const execution = new AsyncLocalStorage<AbortSignal>();
export function withExecutionSignal<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  return execution.run(signal, run);
}
export function executionSignal(signal: AbortSignal = new AbortController().signal): AbortSignal {
  const parent = execution.getStore();
  return parent ? AbortSignal.any([parent, signal]) : signal;
}
