import { redirect } from 'next/navigation';
import { AuthForm } from '@/components/auth-form';
import { currentUser } from '@/lib/session';
export default async function Login() {
  if (await currentUser()) redirect('/dashboard');
  return <AuthForm mode="login" />;
}
