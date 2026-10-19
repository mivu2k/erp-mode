import { Prisma } from '@prisma/client';
import { DEFAULT_REFS, RESOURCE_MAP, RESOURCES, ResourceDef } from '@erp/shared';
import { z, ZodTypeAny } from 'zod';

export type FieldType = 'string' | 'text' | 'int' | 'float' | 'money' | 'decimal' | 'date' | 'datetime' | 'bool' | 'json' | 'enum' | 'file' | 'files';

/** Columns that hold an Attachment id: rendered as an upload/preview picker. */
const FILE_FIELDS = new Set(['photo', 'photoId', 'receiptId', 'attachmentId', 'signature']);
/** JSON columns holding a list of Attachment ids (gallery, first = main image). */
const FILES_FIELDS = new Set(['images', 'photos']);

export interface FieldMeta {
  name: string;
  type: FieldType;
  required: boolean;
  options?: string[];
  ref?: string;
  readonly?: boolean;
  restricted?: boolean;
}

export interface ResourceMeta {
  def: ResourceDef;
  delegate: string;
  fields: FieldMeta[];
  /** All scalar column names (including system ones). */
  columns: Set<string>;
  children: Record<string, { model: string; delegate: string; fields: FieldMeta[] }>;
}

/** Columns the engine owns; never accepted from clients. */
const SYSTEM = new Set(['id', 'companyId', 'createdAt', 'updatedAt', 'deletedAt', 'createdById', 'custom']);
/** Line columns maintained by stock/gatepass postings, never typed by users. */
const CHILD_READONLY = new Set(['receivedQty', 'returnedQty', 'soldQty', 'issuedQty', 'approved']);

const models = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
const enums = new Map(Prisma.dmmf.datamodel.enums.map((e) => [e.name, e.values.map((v) => v.name)]));
const lcFirst = (s: string) => s[0].toLowerCase() + s.slice(1);

function fieldType(f: Prisma.DMMF.Field): FieldType {
  const native = f.nativeType?.[0];
  switch (f.type) {
    case 'String': return native === 'Text' ? 'text' : 'string';
    case 'Int': return 'int';
    case 'Float': return 'float';
    case 'Decimal': return f.nativeType?.[1]?.[1] === '2' ? 'money' : 'decimal';
    case 'DateTime': return native === 'Date' ? 'date' : 'datetime';
    case 'Boolean': return 'bool';
    case 'Json': return 'json';
    default: return f.kind === 'enum' ? 'enum' : 'string';
  }
}

function scalarFields(model: string, def?: ResourceDef, exclude: string[] = []): FieldMeta[] {
  const m = models.get(model);
  if (!m) throw new Error(`Registry references unknown Prisma model ${model}`);
  const hidden = new Set([...(def?.hidden ?? []), ...exclude]);
  return m.fields
    .filter((f) => f.kind !== 'object' && !SYSTEM.has(f.name) && !hidden.has(f.name) && !f.isUpdatedAt)
    .map((f) => {
      const choices = def?.enums?.[f.name];
      return {
        name: f.name,
        type: choices && f.type === 'String' ? ('enum' as const) : FILE_FIELDS.has(f.name) && f.type === 'String' ? ('file' as const) : FILES_FIELDS.has(f.name) && f.type === 'Json' ? ('files' as const) : fieldType(f),
        required: f.isRequired && !f.hasDefaultValue && f.name !== def?.number?.field,
        options: f.kind === 'enum' ? enums.get(f.type) : choices,
        ref: def ? def.refs?.[f.name] ?? (def.key !== DEFAULT_REFS[f.name] ? DEFAULT_REFS[f.name] : undefined) : DEFAULT_REFS[f.name],
        readonly: def?.readonly?.includes(f.name) || (!def && CHILD_READONLY.has(f.name)) || undefined,
        restricted: def?.restricted?.includes(f.name) || undefined,
      };
    });
}

function build(def: ResourceDef): ResourceMeta {
  const m = models.get(def.model)!;
  const children: ResourceMeta['children'] = {};
  for (const [rel, childModel] of Object.entries(def.children ?? {})) {
    const back = models.get(childModel)!.fields.find((f) => f.kind === 'object' && f.type === def.model);
    children[rel] = { model: childModel, delegate: lcFirst(childModel), fields: scalarFields(childModel, undefined, [...(back?.relationFromFields ?? [])]) };
  }
  return {
    def,
    delegate: lcFirst(def.model),
    fields: scalarFields(def.model, def),
    columns: new Set(m.fields.filter((f) => f.kind !== 'object').map((f) => f.name)),
    children,
  };
}

export const META: Record<string, ResourceMeta> = Object.fromEntries(RESOURCES.map((d) => [d.key, build(d)]));

export function meta(key: string): ResourceMeta | undefined {
  return RESOURCE_MAP[key] ? META[key] : undefined;
}

// ─── Validation built from the schema ────────────────────────

const blankToNull = (v: unknown) => (v === '' ? null : v);
const decimal = z.union([z.number().finite(), z.string().regex(/^-?\d+(\.\d+)?$/)]).transform(String);

function zodFor(f: FieldMeta): ZodTypeAny {
  switch (f.type) {
    case 'string':
    case 'file': return z.string().max(191);
    case 'text': return z.string().max(65_535);
    case 'int': return z.coerce.number().int();
    case 'float': return z.coerce.number();
    case 'money':
    case 'decimal': return decimal;
    case 'date':
    case 'datetime': return z.coerce.date();
    case 'bool': return z.boolean();
    // A list field with options (multi-choice) only takes those options.
    case 'json': return f.options?.length ? z.array(z.enum(f.options as [string, ...string[]])) : z.unknown();
    case 'files': return z.array(z.string().max(191)).max(20);
    case 'enum': return z.enum(f.options as [string, ...string[]]);
  }
}

export function objectSchema(fields: FieldMeta[], partial: boolean) {
  const shape: Record<string, ZodTypeAny> = {};
  for (const f of fields) {
    if (f.readonly) continue;
    const base = zodFor(f);
    shape[f.name] = f.required && !partial ? z.preprocess(blankToNull, base) : z.preprocess(blankToNull, base.nullable().optional());
  }
  return z.object(shape).strip();
}

export interface CustomFieldDef { name: string; type: string; required: boolean; options: unknown }

export function customSchema(defs: CustomFieldDef[], partial: boolean) {
  const shape: Record<string, ZodTypeAny> = {};
  for (const d of defs) {
    const opts = Array.isArray(d.options) ? (d.options as string[]) : [];
    const base: ZodTypeAny =
      d.type === 'number' ? z.coerce.number() : d.type === 'date' ? z.string().date() : d.type === 'bool' ? z.boolean()
        : d.type === 'enum' && opts.length ? z.enum(opts as [string, ...string[]]) : z.string().max(1000);
    shape[d.name] = d.required && !partial ? base : base.nullable().optional();
  }
  return z.object(shape).strip();
}
