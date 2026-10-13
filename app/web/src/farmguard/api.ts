import { api } from '../api/client';

export function farmguardCall<T>(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  return api.post<T>('/api/farmguard/call', { action, payload }, 30_000);
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error)
    return String(error.message);
  return '操作未完成，请稍后重试。';
}
