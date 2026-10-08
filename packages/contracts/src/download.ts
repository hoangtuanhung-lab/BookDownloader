import { z } from "zod";
export const DownloadAction = z
  .object({
    id: z.uuid().optional(),
    action: z.enum([
      "start",
      "start-all",
      "pause",
      "cancel",
      "retry",
      "verify",
      "up",
      "down",
    ]),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.action !== "start-all" && !v.id)
      c.addIssue({ code: "custom", message: "Cần mã truyện" });
  });
export const DownloadSettings = z
  .object({
    BATCH_SIZE: z.number().int().min(1).max(100),
    DELAY_MS: z.number().int().min(0).max(10000),
    MAX_RETRY: z.number().int().min(1).max(10),
    MAX_CONCURRENT: z.number().int().min(1).max(10),
    FILE_CONCURRENT: z.number().int().min(1).max(10),
    AUTO_RESUME: z.boolean(),
  })
  .strict();
export const DownloadChapterAction = z
  .object({
    id: z.uuid(),
    chapter: z.uuid(),
    version: z.number().int().positive(),
    action: z.enum(["retry", "pause", "cancel", "delete"]),
  })
  .strict();
