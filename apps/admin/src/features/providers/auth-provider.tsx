'use client';

import { createContext, useContext, useMemo } from 'react';

interface AdminAuthValue {
  user: { id: string } | null;
}

const SESSION_USER = Object.freeze({ id: 'admin-session' });
const AdminAuthContext = createContext<AdminAuthValue | null>(null);

export function AuthProvider({
  children,
  sessionPresent,
}: {
  children: React.ReactNode;
  sessionPresent: boolean;
}) {
  const value = useMemo<AdminAuthValue>(
    () => ({ user: sessionPresent ? SESSION_USER : null }),
    [sessionPresent],
  );

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAuth(): AdminAuthValue {
  const value = useContext(AdminAuthContext);
  if (!value) throw new Error('useAuth must be used within Admin AuthProvider');
  return value;
}
