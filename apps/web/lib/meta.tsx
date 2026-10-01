'use client';
import type { ActionDef, ResourceDef } from '@erp/shared';
import type { FieldMeta } from '@erp/ui';
import { useQuery } from '@tanstack/react-query';
import { createContext, ReactNode, useContext } from 'react';
import { api } from './api';

export interface ResourceMeta extends Omit<ResourceDef, 'children'> {
  fields: FieldMeta[];
  children: Record<string, FieldMeta[]>;
  customFields: { name: string; label: string; type: string; required: boolean; options: string[] | null }[];
  can: Record<'create' | 'update' | 'delete' | 'approve' | 'export' | 'print' | 'manage', boolean>;
}
export interface Meta {
  user: { id: string; name: string; locale: string; employeeId: string | null; permissions: Record<string, string>; roleIds: string[] };
  company: { name: string; branding: Record<string, string> | null; currency: string; timezone: string };
  files: { maxMb: number; types: string[] };
  modules: { key: string; label: string; icon: string }[];
  resources: ResourceMeta[];
}
export type { ActionDef };

const Ctx = createContext<Meta | null>(null);

export function useMetaQuery(enabled: boolean) {
  return useQuery({ queryKey: ['meta'], queryFn: () => api<Meta>('meta'), enabled, staleTime: 5 * 60_000 });
}

export function MetaProvider({ meta, children }: { meta: Meta; children: ReactNode }) {
  return <Ctx.Provider value={meta}>{children}</Ctx.Provider>;
}

export function useMeta() {
  const m = useContext(Ctx);
  if (!m) throw new Error('useMeta outside MetaProvider');
  return m;
}

export function useResource(key: string) {
  return useMeta().resources.find((r) => r.key === key);
}

export const can = (m: Meta, perm: string) => perm in m.user.permissions;
