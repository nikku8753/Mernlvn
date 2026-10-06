import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/session';
import { DashboardView } from '@/components/dashboard-view';
export default async function Dashboard() {
  const user = await currentUser();
  if (!user) redirect('/login');
  return <DashboardView initialUser={user} />;
}
