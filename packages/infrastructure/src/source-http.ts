import { lookup } from "node:dns/promises";
import { isIP, BlockList } from "node:net";
import http from "node:http";
import https from "node:https";
import { AppError } from "../../contracts/src/index";
import { matchesDomain } from "../../domain/src/index";
import type { HttpFetcher } from "../../domain/src/ports";
type Resolver = (
  hostname: string,
  options: { all: true },
) => Promise<{ address: string; family: number }[]>;
const blocked = new BlockList();
for (const [ip, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(ip, bits);
export function publicAddress(address: string) {
  if (isIP(address) === 4) return !blocked.check(address, "ipv4");
  if (isIP(address) !== 6) return false;
  const s = address.toLowerCase();
  return (
    /^[23][0-9a-f]{3}:/.test(s) &&
    !/^2001:(?:0:|db8:|10:|20:)/.test(s) &&
    !/^2002:/.test(s) &&
    !/^3fff:/.test(s)
  );
}
export async function validateSource(raw: string, resolve: Resolver = lookup) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError("INVALID_URL", 400, "URL không hợp lệ");
  }
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    (u.port && !["80", "443"].includes(u.port)) ||
    raw.length > 2000
  )
    throw new AppError(
      "INVALID_URL",
      400,
      "Chỉ nhận HTTP(S) công khai trên cổng chuẩn",
    );
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || /\.(localhost|local|internal)$/.test(host))
    throw new AppError("UNSAFE_URL", 400, "Không cho phép địa chỉ nội bộ");
  let addresses: { address: string; family: number }[];
  try {
    addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await Promise.race([
          resolve(host, { all: true }),
          new Promise<never>((_ok, reject) => {
            const signal = AbortSignal.timeout(5000);
            signal.addEventListener(
              "abort",
              () => reject(new Error("DNS timeout")),
              { once: true },
            );
          }),
        ]);
  } catch {
    throw new AppError("SOURCE_DNS", 422, "Không tìm thấy website");
  }
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new AppError(
      "UNSAFE_URL",
      400,
      "Website trỏ vào địa chỉ không công khai",
    );
  u.hash = "";
  return { url: u, addresses };
}
/** URL preflight checks every URL; reuse DNS answers only within one finite run.
 * Actual network connections always use SourceHttp's fresh/pinned validation. */
export function sourceValidationSession() {
  const cache = new Map<string, { address: string; family: number }[]>();
  const resolver = (async (host: string) => {
    if (!cache.has(host))
      cache.set(host, (await lookup(host, { all: true })) as any);
    return cache.get(host)!;
  }) as Resolver;
  return (url: string) => validateSource(url, resolver);
}
/** DNS checked once and pinned in connection lookup. Every redirect is rechecked.
 * No environment proxy, ambient cookies or unchecked fetch fallback. TLS stays on. */
export class SourceResponseError extends AppError {
  constructor(
    public readonly httpStatus: number,
    public readonly retryAfterMs: number = 0,
  ) {
    super(
      "SOURCE_HTTP",
      422,
      "Website trả HTTP " +
        httpStatus +
        (httpStatus === 401 || httpStatus === 403
          ? "; cần kiểm tra quyền truy cập hoặc cookie phía máy chủ"
          : ""),
    );
  }
}
export function retryAfter(value: string | undefined, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  return Math.min(
    3600000,
    Math.max(
      0,
      Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now,
    ) || 0,
  );
}
export class SourceHttp implements HttpFetcher {
  constructor(
    private cookies: Record<string, string> = {},
    private resolve: Resolver = lookup,
  ) {}
  async get(raw: string, signal: AbortSignal) {
    let current = raw;
    const combined = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    for (let redirects = 0; redirects <= 5; redirects++) {
      const { url, addresses } = await validateSource(current, this.resolve);
      combined.throwIfAborted();
      const chosen = addresses[0];
      const cookie = Object.entries(this.cookies).find(([domain]) =>
        matchesDomain(url.hostname, domain),
      )?.[1];
      const result = await new Promise<{
        status: number;
        location?: string;
        retryAfter?: string;
        body: string;
      }>((resolve, reject) => {
        const request = (url.protocol === "https:" ? https : http).get(
          url,
          {
            signal: combined,
            agent: false,
            headers: {
              "User-Agent": "BookDownloader/2.0",
              Accept: "text/html",
              ...(cookie ? { Cookie: cookie } : {}),
            },
            lookup: ((_host: any, options: any, callback: any) =>
              options.all
                ? callback(null, [chosen])
                : callback(null, chosen.address, chosen.family)) as any,
          },
          (response) => {
            const parts: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 2000000) {
                response.destroy(
                  new AppError(
                    "SOURCE_TOO_LARGE",
                    413,
                    "Trang nguồn vượt 2 MB",
                  ),
                );
                return;
              }
              parts.push(chunk);
            });
            response.on("error", reject);
            response.on("end", () =>
              resolve({
                status: response.statusCode || 500,
                location: response.headers.location,
                retryAfter: response.headers["retry-after"] as
                  | string
                  | undefined,
                body: Buffer.concat(parts).toString("utf8"),
              }),
            );
          },
        );
        request.on("error", reject);
      });
      if (
        [301, 302, 303, 307, 308].includes(result.status) &&
        result.location
      ) {
        current = new URL(result.location, url).href;
        continue;
      }
      if (result.status !== 200)
        throw new SourceResponseError(
          result.status,
          retryAfter(result.retryAfter),
        );
      return { body: result.body, finalUrl: url.href };
    }
    throw new AppError(
      "SOURCE_REDIRECT",
      422,
      "Website chuyển hướng quá nhiều",
    );
  }
}
