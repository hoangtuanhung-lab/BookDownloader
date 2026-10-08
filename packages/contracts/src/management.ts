import { z } from "zod";
export const MetadataEdit = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(120),
    author: z.string().trim().max(100),
    genres: z.array(z.string().trim().min(1).max(100)).max(6),
    visibility: z.enum(["hidden", "published"]),
    coverAsset: z.uuid().nullable().optional(),
  })
  .strict();
export type MetadataEdit = z.infer<typeof MetadataEdit>;
export const UploadStart = z
  .object({
    purpose: z.enum(["import", "toc", "cover", "chapter"]),
    name: z.string().min(1).max(180),
    size: z
      .number()
      .int()
      .min(1)
      .max(64 * 1024 * 1024),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.size >
      (v.purpose === "cover"
        ? 5000000
        : v.purpose === "chapter"
          ? 2000000
          : 64 * 1024 * 1024)
    )
      c.addIssue({ code: "custom", message: "File quá lớn" });
    if (
      v.purpose === "cover"
        ? !/\.(png|jpe?g|webp)$/i.test(v.name)
        : !/\.(txt|md|markdown|csv)$/i.test(v.name)
    )
      c.addIssue({ code: "custom", message: "Định dạng file không hợp lệ" });
  });
export const UploadChunk = z
  .object({
    index: z.number().int().min(0).max(255),
    data: z
      .string()
      .min(4)
      .max(349528)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      ),
  })
  .strict();
export const ImportRequest = z
  .object({
    name: z.string().trim().max(120),
    author: z.string().max(100),
    genres: z.array(z.string().min(1).max(100)).max(6),
    upload: z.uuid().optional(),
    toc: z.uuid().optional(),
    folder: z.string().max(2000).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      !!v.upload === !!v.folder ||
      (!v.folder && !v.name) ||
      (v.toc && !v.upload)
    )
      c.addIssue({ code: "custom", message: "Cần chọn file hoặc thư mục" });
  });
export const ChapterAdd = z
  .object({
    version: z.number().int().positive(),
    order: z.number().int().min(1).max(99999),
    title: z.string().max(120),
    part: z.string().max(120),
    volume: z.string().max(120),
    newPart: z.boolean().default(false),
    newVolume: z.boolean().default(false),
    kind: z.enum(["link", "paste", "file"]),
    url: z.string().max(2000).optional(),
    text: z.string().max(300000).optional(),
    upload: z.uuid().optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.kind === "link"
        ? !v.url
        : v.kind === "paste"
          ? !v.text?.trim()
          : !v.upload
    )
      c.addIssue({ code: "custom", message: "Thiếu nội dung chương" });
  });
export const AnalysisRequest = z
  .object({
    urls: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .pipe(z.url({ protocol: /^https?$/ })),
      )
      .min(1)
      .max(50),
    mode: z.enum(["auto", "manual"]),
    total: z.number().int().min(1).max(20000).optional(),
    name: z.string().trim().max(120).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.mode === "manual" && (!v.total || !v.name))
      c.addIssue({ code: "custom", message: "Cần tên truyện và tổng chương" });
  });
export const AnalysisAction = z
  .object({ action: z.enum(["retry", "drop"]), id: z.uuid() })
  .strict();
export const SettingsEdit = z
  .object({
    SITE_RULES: z
      .string()
      .max(2000)
      .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f]*$/),
    JUNK_WORDS: z.string().max(10000),
    DELAY_MS: z.number().int().min(0).max(10000),
  })
  .strict();
export interface ManagedBook {
  id: string;
  name: string;
  author: string;
  genres: string[];
  visibility: "hidden" | "published";
  version: number;
  sourceType: "WEB" | "FILE" | "FOLDER";
  sourceUrl: string;
  folderId: string | null;
  status: string;
  total: number;
  done: number;
  hasCover: boolean;
  sync: string;
  progress?: { ratio: number; chapterId: string; index: number } | null;
}
