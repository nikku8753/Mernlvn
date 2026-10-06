export type User = { id: string; username: string; email: string; avatar: string | null; createdAt: string };
export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...options, credentials: 'include', cache: 'no-store', headers: { 'Content-Type': 'application/json', ...options.headers } });
  } catch { throw new ApiError('Unable to reach CodeSync. Please try again.', 0); }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(body?.error || (response.status === 429 ? 'Too many attempts. Please try again later.' : 'Unable to complete your request.'), response.status);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export function validateUsername(value: string) {
  return value.trim().length < 2 || value.trim().length > 32 ? 'Username must be between 2 and 32 characters.' : '';
}

export function validateCredentials(email: string, password: string) {
  if (email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Enter a valid email address.';
  if (password.length < 10 || password.length > 72 || new TextEncoder().encode(password).length > 72) return 'Password must be at least 10 characters and at most 72 UTF-8 bytes.';
  return '';
}
