import { assertSourcePage } from "./analysis";
import { createHash } from "node:crypto";
import { parseChapterHtml_, fname_, padDnum_, emptyRuns_ } from "./legacy.mjs";
export function parsedDownload(
  html: string,
  url: string,
  cfg: any,
  chapter: any,
  book: any,
) {
  assertSourcePage(html);
  const parsed = parseChapterHtml_(html, url, cfg, Number(chapter.order_key));
  const number = chapter.display_number || String(chapter.order_key),
    title = parsed.title;
  const head =
    /^(?:(?:quyển|quyen|tập|tap)\s*\d+\s*[-–:.]?\s*)?(?:chương|chuong|chapter|chap)\s*\d+/i.test(
      title,
    )
      ? title
      : book.label + " " + padDnum_(number) + ": " + title;
  const text = book.name + "\n\n" + head + "\n\n" + parsed.text;
  return { title, name: fname_(number, title), text, auto: parsed.auto };
}
export const contentHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function retryDecision(
  error: unknown,
  attempt: number,
  max: number,
  delay: number,
  random = Math.random,
) {
  const e = error as any,
    code = e?.code || e?.type || "NETWORK_ERROR";
  const status = typeof e?.httpStatus === "number" ? e.httpStatus : 0;
  const permanent =
    [
      "NO_CONTENT",
      "TOO_SHORT",
      "SOURCE_TOO_LARGE",
      "SOURCE_BLOCKED",
      "SOURCE_REDIRECT",
      "UNSAFE_URL",
      "INVALID_URL",
    ].includes(code) ||
    status === 401 ||
    status === 403 ||
    (status !== 0 && ![429, 500, 502, 503, 504].includes(status));
  return {
    retry: !permanent && attempt < max,
    code,
    message:
      typeof e?.httpStatus === "number"
        ? e.message
        : code === "SOURCE_BLOCKED"
          ? "Website yêu cầu CAPTCHA hoặc chặn truy cập"
          : code === "NO_CONTENT"
            ? "Không thấy nội dung chương"
            : code === "TOO_SHORT"
              ? "Nội dung chương quá ngắn"
              : "Không tải được chương; kiểm tra kết nối hoặc quyền",
    waitMs: Math.max(
      typeof e?.httpStatus === "number" ? e.retryAfterMs : 0,
      Math.min(60000, Math.max(1000, delay) * 2 ** (attempt - 1)) *
        (0.8 + random() * 0.4),
    ),
  };
}
export function emptyChapterIds(chapters: any[]) {
  const rows = chapters.map((c) => [
    "",
    Number(c.order_key),
    c.title,
    c.source_url,
    c.status,
    c.file_id,
    c.retry_count,
    c.error_code || "",
  ]);
  return emptyRuns_(rows).map((i: number) => chapters[i].id) as string[];
}
