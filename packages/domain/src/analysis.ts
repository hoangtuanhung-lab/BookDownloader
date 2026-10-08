import { AppError } from "../../contracts/src/index";
import {
  normUrl_,
  siteRule_,
  nextPage_,
  hasPager_,
  chNum_,
  volInfo_,
  mixShift_,
  fillSequentialGap_,
  txt_,
  bookName_,
  authorName_,
  genreNames_,
} from "./legacy.mjs";
import type { HttpFetcher } from "./ports";
import { setTimeout as pause } from "node:timers/promises";
export interface DiscoveredChapter {
  num: number;
  title: string;
  url: string;
  part: string;
  vol: string;
  dnum: string;
}
export interface AnalysisCheckpoint {
  current: string | null;
  first: string;
  pages: string[];
  candidates: { url: string; title: string }[];
}
interface AnalysisOptions {
  resume?: AnalysisCheckpoint;
  checkpoint: (state: AnalysisCheckpoint) => Promise<void>;
  shouldYield: () => boolean;
}
export interface AnalysisResult {
  name: string;
  author: string;
  genres: string[];
  sourceUrl: string;
  notes: string[];
  chapters: DiscoveredChapter[];
}
type Config = { SITE_RULES: string; JUNK_WORDS: string; DELAY_MS: number };
export function analyze(
  url: string,
  http: HttpFetcher,
  cfg: Config,
  signal: AbortSignal,
): Promise<AnalysisResult>;
export function analyze(
  url: string,
  http: HttpFetcher,
  cfg: Config,
  signal: AbortSignal,
  options: AnalysisOptions,
): Promise<AnalysisResult | { pending: true }>;
export async function analyze(
  url: string,
  http: HttpFetcher,
  cfg: Config,
  signal: AbortSignal,
  options?: AnalysisOptions,
): Promise<AnalysisResult | { pending: true }> {
  const bookUrl = normUrl_(url),
    origin = new URL(bookUrl).origin,
    prefix = new URL(bookUrl).pathname.replace(/\/$/, ""),
    candidates = options?.resume?.candidates || [],
    seen = new Set(candidates.map((c) => c.url)),
    pages = new Set<string>(options?.resume?.pages || []);
  let current: string | null = options?.resume
      ? options.resume.current
      : bookUrl,
    first = options?.resume?.first || "",
    notes: string[] = [];
  const tok = siteRule_(bookUrl, cfg).link;
  while (current) {
    signal.throwIfAborted();
    if (pages.size >= 300)
      throw new AppError("ANALYSIS_LIMIT", 422, "Mục lục vượt 300 trang");
    if (pages.size && cfg.DELAY_MS > 0)
      await pause(cfg.DELAY_MS, undefined, { signal });
    pages.add(current);
    const response = await http.get(current, signal);
    if (new URL(response.finalUrl).origin !== origin)
      throw new AppError(
        "PARSER_ERROR",
        422,
        "Trang nguồn chuyển sang website khác",
      );
    const html = response.body;
    if (!first) first = html;
    assertSourcePage(html);
    for (const m of html.matchAll(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    )) {
      let u: URL;
      try {
        u = new URL(m[1].replace(/&amp;/g, "&"), response.finalUrl);
      } catch {
        continue;
      }
      u.hash = "";
      u.search = "";
      const path = u.pathname.replace(/\/$/, "");
      if (
        u.origin !== origin ||
        !(path === prefix || path.startsWith(prefix + "/")) ||
        seen.has(u.href)
      )
        continue;
      const rest = path.slice(prefix.length);
      if (
        tok
          ? !rest.toLowerCase().includes(tok.toLowerCase())
          : !/(?:^|[\/\-_])(?:chuong|chapter|chap)[-_]?[^\/]*/i.test(rest)
      )
        continue;
      seen.add(u.href);
      candidates.push({ url: u.origin + path, title: txt_(m[2]) });
      if (candidates.length > 20000)
        throw new AppError("ANALYSIS_LIMIT", 422, "Mục lục vượt 20000 chương");
    }
    const next = nextPage_(html, response.finalUrl);
    if (!next && pages.size === 1 && hasPager_(html))
      throw new AppError(
        "PARSER_ERROR",
        422,
        "Có phân trang nhưng không xác định được trang kế tiếp",
      );
    if (next && new URL(next).origin !== origin)
      throw new AppError("PARSER_ERROR", 422, "Phân trang sang website khác");
    current = next && !pages.has(next) ? next : null;
    if (options) {
      await options.checkpoint({
        current,
        first,
        pages: [...pages],
        candidates,
      });
      if (current && options.shouldYield()) return { pending: true };
    }
  }
  const numbered = candidates
    .map((c) => ({ c, num: chNum_(c, tok), vi: volInfo_(c) }))
    .filter((x) => x.num !== null);
  const mixed = numbered.some((x) => x.vi) && numbered.some((x) => !x.vi),
    shift = mixed ? mixShift_(numbered) : 0,
    used = new Set<string>();
  let duplicates = 0;
  const chapters = numbered
    .flatMap((x) => {
      const key = (mixed && x.vi ? "V" : "") + x.num;
      if (used.has(key)) {
        duplicates++;
        return [];
      }
      used.add(key);
      return [
        {
          ...x.c,
          n: x.num! + (x.vi ? shift : 0),
          vol: x.vi?.vol || "",
          dnum: String(x.vi?.dnum ?? ""),
        },
      ];
    })
    .sort((a, b) => a.n - b.n);
  if (!chapters.length)
    throw new AppError(
      "PARSER_ERROR",
      422,
      "Không tìm thấy chương; kiểm tra SITE_RULES hoặc dùng Thủ công",
    );
  if (duplicates) notes.push("Bỏ " + duplicates + " link trùng số chương");
  if (numbered.length < candidates.length)
    notes.push(
      "Bỏ " + (candidates.length - numbered.length) + " link không có số",
    );
  if (mixed) notes.push("Mục lục trộn Quyển/Chương và chương liền số");
  // Never manufacture thousands of URLs from a single observation. Baseline template
  // validation is retained; automatic fill additionally requires two distinct samples.
  const full =
    chapters.some((c) => c.vol) || chapters.length < 2
      ? chapters
      : fillSequentialGap_(chapters, notes);
  return {
    name: bookName_(first, new URL(bookUrl).hostname),
    author: authorName_(first),
    genres: genreNames_(first)
      .split(/[,;\/]/)
      .map((s: string) => s.trim())
      .filter(Boolean)
      .slice(0, 6),
    sourceUrl: bookUrl,
    notes,
    chapters: full.map(
      (c: any): DiscoveredChapter => ({
        num: c.n,
        title: c.title,
        url: c.url,
        part: "",
        vol: c.vol || "",
        dnum: String(c.dnum ?? ""),
      }),
    ),
  };
}
export function manualChapters(
  sample: string,
  total: number,
): DiscoveredChapter[] {
  if (!Number.isInteger(total) || total < 1 || total > 20000)
    throw new AppError("INVALID_INPUT", 400, "Tổng chương từ 1 đến 20000");
  const u = new URL(sample),
    match = /(chuong|chapter|chap)[-_]?0*(\d+)/i.exec(u.pathname);
  if (!match)
    throw new AppError("INVALID_INPUT", 400, "Link mẫu cần chứa số chương");
  const at = match.index + match[0].length - match[2].length;
  return Array.from({ length: total }, (_, i) => {
    const target = new URL(u);
    target.pathname =
      u.pathname.slice(0, at) +
      (i + 1) +
      u.pathname.slice(at + match[2].length);
    target.hash = "";
    return {
      num: i + 1,
      title: "",
      url: target.href,
      part: "",
      vol: "",
      dnum: "",
    };
  });
}

export function assertSourcePage(html: string) {
  if (/cf-chl-|captcha|Just a moment\.\.\./i.test(html))
    throw new AppError(
      "SOURCE_BLOCKED",
      422,
      "Website yêu cầu CAPTCHA hoặc chặn truy cập",
    );
}
