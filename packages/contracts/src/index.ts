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
