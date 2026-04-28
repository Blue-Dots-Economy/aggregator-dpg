import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';

export function ShellLayout() {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 min-w-0 overflow-x-hidden">
        <div className="max-w-[1480px] mx-auto px-8 py-7">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
