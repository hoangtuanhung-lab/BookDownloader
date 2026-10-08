import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsedDownload,
  retryDecision,
  emptyChapterIds,
} from "../../packages/domain/src/download";
import {
  SourceResponseError,
  retryAfter,
} from "../../packages/infrastructure/src/source-http";
import {
  DownloadAction,
  DownloadSettings,
} from "../../packages/contracts/src/download";
const body =
  "Nội dung chương có đủ chiều dài để kiểm tra việc tải, làm sạch và lưu đúng cấu trúc. ".repeat(
    3,
  );
test("WEB parser preserves compound numbers, source title and book/body header", () => {
  const r = parsedDownload(
    `<h1>Quyển 1 - Chương 1-2: Mở đầu</h1><div id="chapter-content">${body}</div>`,
    "https://source.test/book/chuong-1",
    {},
    { order_key: 1001.002, display_number: "1-2" },
    { name: "Tên truyện", label: "Chương" },
  );
  assert.match(r.name, /001-002/);
  assert.match(r.text, /Tên truyện\n\nQuyển 1 - Chương 1-2: Mở đầu\n\n/);
  assert(r.text.includes("Nội dung"));
});
test("HTTP 401/403 are terminal; 429/5xx honor bounded attempt budget and Retry-After", () => {
  for (const code of [401, 403, 404])
    assert.equal(
      retryDecision(new SourceResponseError(code), 1, 3, 800).retry,
      false,
    );
  for (const code of [429, 500, 502, 503, 504]) {
    assert.equal(
      retryDecision(new SourceResponseError(code, 120000), 1, 3, 800, () => 0)
        .waitMs,
      120000,
    );
    assert.equal(
      retryDecision(new SourceResponseError(code), 3, 3, 800).retry,
      false,
    );
  }
  assert.equal(
    retryDecision(Error("secret network data"), 1, 3, 800).message.includes(
      "secret",
    ),
    false,
  );
});
test("Retry-After seconds/date/invalid values remain bounded", () => {
  assert.equal(retryAfter("120"), 120000);
  assert.equal(retryAfter(new Date(13000).toUTCString(), 1000), 12000);
  assert.equal(retryAfter("999999"), 3600000);
  assert.equal(retryAfter("invalid"), 0);
});
test("emptyRuns baseline removes up to three bounded errors; preserves long or trailing errors", () => {
  const row = (n: number, status: string) => ({
    id: String(n),
    order_key: n,
    status,
    title: "",
    error_code: status === "ERROR" ? "TOO_SHORT: lỗi" : "",
    source_url: "",
    retry_count: 1,
  });
  assert.deepEqual(
    emptyChapterIds([
      row(1, "DONE"),
      row(2, "ERROR"),
      row(3, "ERROR"),
      row(4, "DONE"),
    ]),
    ["2", "3"],
  );
  assert.deepEqual(
    emptyChapterIds([
      row(1, "DONE"),
      ...Array.from({ length: 4 }, (_, i) => row(i + 2, "ERROR")),
      row(6, "DONE"),
    ]),
    [],
  );
  assert.deepEqual(emptyChapterIds([row(1, "DONE"), row(2, "ERROR")]), []);
});
test("challenge pages remain explicit errors and never become removable empty chapters", () => {
  assert.throws(
    () =>
      parsedDownload(
        '<h1>Just a moment...</h1><div id="chapter-content">captcha</div>',
        "https://source.test/chapter",
        {},
        { order_key: 1 },
        { name: "Truyện", label: "Chương" },
      ),
    (e: any) => e.code === "SOURCE_BLOCKED",
  );
  assert.equal(
    retryDecision({ code: "SOURCE_BLOCKED" }, 1, 3, 800).retry,
    false,
  );
  assert.deepEqual(
    emptyChapterIds([
      {
        id: "1",
        order_key: 1,
        status: "ERROR",
        error_code: "SOURCE_BLOCKED: CAPTCHA",
      },
      { id: "2", order_key: 2, status: "DONE" },
    ]),
    [],
  );
});
test("download schemas reject spoofing, unbounded settings and missing book", () => {
  assert(!DownloadAction.safeParse({ action: "start" }).success);
  assert(DownloadAction.safeParse({ action: "start-all" }).success);
  const config = {
    BATCH_SIZE: 5,
    DELAY_MS: 800,
    MAX_RETRY: 3,
    MAX_CONCURRENT: 2,
    FILE_CONCURRENT: 2,
    AUTO_RESUME: false,
  };
  assert(DownloadSettings.safeParse(config).success);
  assert(
    !DownloadSettings.safeParse({ ...config, FILE_CONCURRENT: 11 }).success,
  );
  assert(
    !DownloadSettings.safeParse({ ...config, SITE_COOKIES: "secret" }).success,
  );
});
