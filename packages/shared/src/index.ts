import { z } from 'zod';
import { EXTRA_RESOURCES, RESOURCES } from './registry';

export const ACTIONS = ['view', 'create', 'update', 'delete', 'approve', 'export', 'print', 'manage'] as const;
export type Action = (typeof ACTIONS)[number];
export type DataScope = 'own' | 'department' | 'branch' | 'all';

export * from './registry';
export * from './calc';
export * from './reports';

/** Every permission key: <resource>.<action> for registry + permission-only resources. */
export const ALL_PERMISSIONS = [...new Set([...RESOURCES.map((r) => r.key), ...EXTRA_RESOURCES])].flatMap((r) =>
  ACTIONS.map((a) => `${r}.${a}`),
);

export const loginSchema = z.object({
  login: z.string().min(1), // email or username
  password: z.string().min(1),
  otp: z.string().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const passwordSchema = z
  .string()
  .min(8)
  .regex(/[A-Z]/, 'uppercase letter required')
  .regex(/[a-z]/, 'lowercase letter required')
  .regex(/\d/, 'digit required');

export const createUserSchema = z.object({
  email: z.string().email(),
  username: z.string().min(3).optional(),
  name: z.string().min(1),
  password: passwordSchema,
  branchId: z.string().optional(),
  departmentId: z.string().optional(),
  roleIds: z.array(z.string()).default([]),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().refine((n) => [10, 25, 50, 100].includes(n)).default(25),
  search: z.string().optional(),
  sort: z.string().optional(), // "field:asc|desc"
});
export type ListQuery = z.infer<typeof listQuerySchema>;
