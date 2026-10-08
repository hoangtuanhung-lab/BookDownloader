import { z } from "zod";
const Position = z.object({
  c: z.number().finite(),
  y: z.number().nonnegative(),
  p: z.number().min(0).max(1),
  t: z.number().finite(),
});
/** Deliberately requires an operator-confirmed identity; origin storage alone proves no identity. */
export function convertLegacyProgress(properties: Record<string, string>) {
  const progress: {
      book: string;
      order: number;
      ratio: number;
      scrollPosition: number;
    }[] = [],
    issues: { key: string; code: string }[] = [];
  for (const [key, value] of Object.entries(properties)) {
    if (!/^(RP_|rdPos_)[\w-]{1,100}$/.test(key)) continue;
    try {
      const p = Position.parse(JSON.parse(value));
      progress.push({
        book: key.replace(/^(RP_|rdPos_)/, ""),
        order: p.c,
        ratio: p.p,
        scrollPosition: p.y,
      });
    } catch {
      issues.push({ key, code: "INVALID_PROGRESS" });
    }
  }
  if (new Set(progress.map((p) => p.book)).size !== progress.length)
    issues.push({
      key: "progress",
      code: "MULTIPLE_ORIGINS_REQUIRE_TIMESTAMP_REVIEW",
    });
  return { progress, issues, ownerBindingRequired: true };
}
