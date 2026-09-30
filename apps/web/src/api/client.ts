import { authHeaders, useSession } from '../stores/session.js';

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const BASE = '/api';

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('content-type') && init.body && !(init.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
  }
  for (const [k, v] of Object.entries(authHeaders())) headers.set(k, v);

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const body = await parse(res);

  if (!res.ok) {
    const err = (body as { error?: ApiErrorBody } | null)?.error;
    if (res.status === 401 && err?.code === 'AUTH_REQUIRED') {
      useSession.getState().clear();
    }
    throw new ApiError(
      err?.code ?? 'UNKNOWN',
      res.status,
      err?.message ?? `请求失败（${res.status}）`,
      err?.details,
    );
  }
  return body as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
export const put = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) });
export const patch = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

export function upload<T>(path: string, files: File[], extra: Record<string, string> = {}): Promise<T> {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return api<T>(path, { method: 'POST', body: form });
}

/** 图片 URL 需要携带鉴权（<img> 无法带 header，所以用查询参数）。
 *  路径本身可能已带内容版本号（?v=…），此时用 & 拼接，不能再用 ?。 */
export function authedImageUrl(path: string): string {
  const token = useSession.getState().token;
  if (!token) return `${BASE}${path}`;
  const sep = path.includes('?') ? '&' : '?';
  return `${BASE}${path}${sep}token=${encodeURIComponent(token)}`;
}
