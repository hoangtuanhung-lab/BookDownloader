import { test, expect, type Page } from "@playwright/test";
import {
  fixture as readerFixture,
  user,
  book,
  book2,
  chapterId,
} from "../phase-4/browser-fixture";
async function fixture(
  page: Page,
  permissions = ["download", "manage", "admin"],
) {
  await readerFixture(page);
  const calls: any[] = [];
  let books = [
    {
      id: book,
      name: "Truyện nguồn",
      sourceType: "WEB",
      status: "ANALYZED",
      version: 1,
      total: 100,
      done: 0,
      pending: 100,
      errors: 0,
      skipped: 0,
      inFlight: false,
    },
    {
      id: book2,
      name: "Truyện file",
      sourceType: "FILE",
      status: "IDLE",
      version: 1,
      total: 2,
      done: 0,
      pending: 2,
      errors: 1,
      skipped: 0,
      inFlight: false,
    },
  ];
  let config = {
    BATCH_SIZE: 5,
    DELAY_MS: 800,
    MAX_RETRY: 3,
    MAX_CONCURRENT: 2,
    FILE_CONCURRENT: 2,
    AUTO_RESUME: true,
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname.slice(4),
      method = req.method(),
      body = req.postData() ? req.postDataJSON() : null;
    calls.push({ path, method, body, search: url.search });
    if (path === "/me")
      return route.fulfill({
        json: { id: user, name: "Synthetic downloader", permissions },
      });
    if (path === "/analysis") return route.fulfill({ json: { jobs: [] } });
    if (path === "/download") {
      const filter = url.searchParams.get("filter"),
        rows =
          filter === "all"
            ? books
            : books.filter((b) => b.sourceType === filter);
      return route.fulfill({ json: { books: rows, total: rows.length } });
    }
    if (path === "/download/actions") {
      if (body.action === "start-all")
        books = books.map((b) =>
          b.status === "ANALYZED" ? { ...b, status: "IDLE" } : b,
        );
      else
        books = books.map((b) =>
          b.id === body.id
            ? {
                ...b,
                status:
                  body.action === "pause" || body.action === "cancel"
                    ? "PAUSED"
                    : body.action === "start"
                      ? "READY"
                      : b.status,
              }
            : b,
        );
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith("/errors"))
      return route.fulfill({
        json: [
          {
            id: chapterId(1),
            order: 1,
            displayNumber: "1-2",
            title: "Chương lỗi",
            status: "ERROR",
            error: "SOURCE_HTTP: HTTP 403",
            retries: 1,
            skipped: false,
          },
        ],
      });
    if (path === "/download/chapters")
      return route.fulfill({ json: { ok: true } });
    if (path === "/settings/download") {
      if (method === "PUT") config = body;
      return route.fulfill({ json: config });
    }
    return route.fallback();
  });
  return {
    calls,
    progress: () => {
      books = books.map((b) =>
        b.id === book
          ? {
              ...b,
              status: "DOWNLOADING",
              done: 50,
              pending: 50,
              inFlight: true,
            }
          : b,
      );
    },
  };
}
test("monitor starts, pauses and resumes persistent tasks; reload shows same queue", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/download");
  const monitor = page.getByRole("region", { name: "Giám sát tải nền" });
  await expect(
    monitor.getByText("Truyện nguồn", { exact: true }),
  ).toBeVisible();
  await monitor
    .getByRole("button", { name: "Chuyển xuống tải", exact: true })
    .click();
  await expect(monitor.getByText("Sẵn sàng", { exact: true })).toBeVisible();
  const row = monitor.getByRole("row").filter({ hasText: "Truyện nguồn" });
  await row.getByRole("button", { name: "Tạm dừng", exact: true }).click();
  await expect(row.getByText("Tạm dừng", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Tải / Tiếp tục" }).click();
  await page.reload();
  await expect(page.getByText("Sẵn sàng", { exact: true })).toBeVisible();
  assertAction(f.calls, "pause");
  assertAction(f.calls, "start");
});
function assertAction(calls: any[], action: string) {
  expect(
    calls.some(
      (c) => c.path === "/download/actions" && c.body.action === action,
    ),
  ).toBeTruthy();
}
test("monitor filters source, reorders queue and refreshes counters without fetching chapters", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/download");
  const monitor = page.getByRole("region", { name: "Giám sát tải nền" });
  await monitor.getByLabel("Nhóm tác vụ").selectOption("FILE");
  await expect(monitor.getByText("Truyện file", { exact: true })).toBeVisible();
  await expect(monitor.getByText("Truyện nguồn", { exact: true })).toHaveCount(
    0,
  );
  await monitor.getByRole("button", { name: "Lên Truyện file" }).click();
  assertAction(f.calls, "up");
  await monitor.getByLabel("Nhóm tác vụ").selectOption("WEB");
  f.progress();
  await monitor.getByRole("button", { name: "Làm mới tác vụ" }).click();
  await expect(monitor.getByText(/50\/100/)).toBeVisible();
  expect(
    f.calls.filter((c) => c.path.includes("/chapters") && c.method === "GET"),
  ).toHaveLength(0);
});
test("download-only can retry/pause/cancel chapter; deletion requires manage", async ({
  page,
}) => {
  const f = await fixture(page, ["download"]);
  await page.goto("/download");
  await page
    .getByRole("row")
    .filter({ hasText: "Truyện file" })
    .getByRole("button", { name: "Xem chương lỗi" })
    .click();
  const errors = page.getByRole("region", { name: "Chương lỗi tác vụ" });
  await expect(errors.getByText(/HTTP 403/)).toBeVisible();
  await expect(
    errors.getByRole("button", { name: "Xóa chương", exact: true }),
  ).toHaveCount(0);
  await errors.getByRole("button", { name: "Thử lại chương" }).click();
  await expect
    .poll(() =>
      f.calls.some(
        (c) => c.path === "/download/chapters" && c.body.action === "retry",
      ),
    )
    .toBeTruthy();
  await expect(page.getByText("Cấu hình tải nền", { exact: true })).toHaveCount(
    0,
  );
});
test("admin edits batch, independent caps and AUTO_RESUME; cancel task requires confirmation", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/download");
  await page.getByText("Cấu hình tải nền", { exact: true }).click();
  await page
    .getByRole("button", { name: "Đọc cấu hình tải", exact: true })
    .click();
  await page.getByLabel("BATCH_SIZE", { exact: true }).fill("3");
  await page.getByLabel("FILE_CONCURRENT", { exact: true }).fill("1");
  await page.getByLabel("Tự tiếp tục sau mỗi đợt").uncheck();
  await page
    .getByRole("button", { name: "Lưu cấu hình tải", exact: true })
    .click();
  await expect
    .poll(() =>
      f.calls.some(
        (c) =>
          c.path === "/settings/download" &&
          c.method === "PUT" &&
          c.body.BATCH_SIZE === 3 &&
          c.body.FILE_CONCURRENT === 1 &&
          !c.body.AUTO_RESUME,
      ),
    )
    .toBeTruthy();
  page.once("dialog", (d) => d.dismiss());
  await page
    .getByRole("row")
    .filter({ hasText: "Truyện file" })
    .getByRole("button", { name: "Hủy tác vụ", exact: true })
    .click();
  expect(f.calls.some((c) => c.body?.action === "cancel")).toBeFalsy();
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("row")
    .filter({ hasText: "Truyện file" })
    .getByRole("button", { name: "Hủy tác vụ", exact: true })
    .click();
  await expect
    .poll(() => f.calls.some((c) => c.body?.action === "cancel"))
    .toBeTruthy();
});
test("mobile monitor stays inside viewport and worker progress appears after tab reopening", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  await page.goto("/download");
  await expect(page.getByRole("table", { name: "Tiến độ tải" })).toBeVisible();
  await page.goto("/manage");
  f.progress();
  await page.goto("/download");
  await expect(page.getByText(/50\/100/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: ".local-browser-results/phase-7/mobile.png",
    fullPage: true,
  });
});
