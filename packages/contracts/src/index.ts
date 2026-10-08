import { z } from 'zod';
export const Permission = z.enum(['read', 'download', 'manage', 'admin']);
export type Permission = z.infer<typeof Permission>;
export const Visibility = z.enum(['hidden', 'published']);
export const BookMetadata = z.object({
  id: z.uuid(), name: z.string().trim().min(1).max(120), author: z.string().max(100),
  genres: z.array(z.string().min(1).max(100)).max(6),
  sourceUrl: z.union([z.literal(''), z.url({protocol: /^https?$/})]),
  sourceType: z.enum(['WEB', 'FILE', 'FOLDER']), visibility: Visibility,
  version: z.number().int().positive(),
}).strict().superRefine((b, ctx) => {
  if (b.sourceType === 'WEB' && !b.sourceUrl) ctx.addIssue({code:'custom', path:['sourceUrl'], message:'Truyện WEB cần link gốc'});
});
export type BookMetadata = z.infer<typeof BookMetadata>;
// Reader DTO deliberately excludes source URLs, Drive IDs and worker errors.
export const ReaderBook = BookMetadata.pick({id:true,name:true,author:true,genres:true}).extend({coverUrl:z.string().optional()}).strict();
export const HealthResponse = z.object({status:z.enum(['ok','unavailable']), database:z.enum(['ok','unavailable']), correlationId:z.uuid()}).strict();
export const JobKind = z.enum(['ANALYZE','WEB_DOWNLOAD','FILE_IMPORT','DRIVE_SYNC']);
export type JobKind = z.infer<typeof JobKind>;
export class AppError extends Error {
  constructor(public readonly code:string, public readonly status:number, message:string) { super(message); }
}
export const Account = z.object({id:z.uuid(),name:z.string(),permissions:z.array(Permission)}).strict();
export type Account = z.infer<typeof Account>;
export const AdminUser = Account.extend({email:z.string().nullable(),status:z.enum(['active','blocked'])}).strict();
export type AdminUser = z.infer<typeof AdminUser>;
export const AccountUpdate = z.object({permissions:z.array(Permission).max(4),status:z.enum(['active','blocked'])}).strict();
export const ReaderPreferences = z.object({font:z.enum(['Literata','Merriweather','Roboto','EB Garamond','Tinos']),fontSize:z.number().int().min(12).max(48),theme:z.enum(['day','night']),blueFilter:z.number().min(0).max(1),mode:z.enum(['chapter','continuous'])}).strict();
export const ProgressUpdate = z.object({chapterId:z.uuid(),ratio:z.number().min(0).max(1),scrollPosition:z.number().min(0).max(1e9),expectedRevision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict();
export const ReadingProgress = ProgressUpdate.omit({expectedRevision:true}).extend({revision:z.number().int().positive(),updatedAt:z.string()}).strict();
export function hasPermission(account:Account,permission:Permission):boolean {return account.permissions.includes('admin')||account.permissions.includes(permission);}
