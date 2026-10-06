import 'server-only';
import { cookies } from 'next/headers';
import { API_URL, type User } from './api';

export async function currentUser(): Promise<User | null> {
  const session = (await cookies()).get('codesync_session');
  if (!session) return null;
  const response = await fetch(`${API_URL}/api/auth/me`, {
    headers: { Cookie: `codesync_session=${encodeURIComponent(session.value)}` }, cache: 'no-store', signal: AbortSignal.timeout(8000),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error('Unable to verify your session. Please try again.');
  return response.json();
}
