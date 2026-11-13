import { useAuth } from '../store/auth.js';

export const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

/** fetch wrapper: JSON in/out, bearer token, readable errors */
export async function api(path, { method = 'GET', body, signal } = {}) {
  const token = useAuth.getState().token;
  const res = await fetch(API_URL + '/api' + path, {
    method,
    signal,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && token) useAuth.getState().logout();
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
