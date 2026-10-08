import { test, expect, type Page } from "@playwright/test";
import {
  fixture as readerFixture,
  user,
  book,
  book2,
  chapterId,
} from "../phase-4/browser-fixture";
async function fixture(page: Page) {
  await readerFixture(page);
  let books: any[] = [
      {
        id: book,
        name: "Đường về",
        author: "Tác giả",
        genres: ["Kiếm hiệp"],
        visibility: "hidden",
        version: 1,
        sourceType: "FILE",
        sourceUrl: "",
        folderId: "folder-synthetic",
        status: "DONE",
        total: 2,
        done: 2,
        hasCover: false,
        sync: "synced",
      },
      {
        id: book2,
        name: "Sách hai",
        author: "",
        genres: [],
        visibility: "hidden",
        version: 1,
        sourceType: "WEB",
        sourceUrl: "https://source.test/book/",
        folderId: null,
        status: "ANALYZED",
        total: 2,
        done: 0,
        hasCover: false,
        sync: "pending",
      },
    ],
    jobs: any[] = [],
    analysis: any[] = [];
  const requests: any[] = [],
    uploads = new Map<string, any>();
  let serial = 0,
    saveGate: Promise<void> | undefined,
    rejectAnalysis = false;
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname.slice(4),
      method = req.method(),
      body = req.postData() ? req.postDataJSON() : null;
    requests.push({ path, method, body });
    if (path === "/me")
      return route.fulfill({
        json: {
          id: user,
          name: "Manager fixture",
          permissions: ["read", "manage", "download", "admin"],
        },
      });
    if (path === "/manage/books" && method === "GET")
      return route.fulfill({
        json: {
          books: books.filter((b) =>
            b.name
              .toLowerCase()
              .includes((url.searchParams.get("q") || "").toLowerCase()),
          ),
          total: books.length,
        },
      });
    if (path === "/manage/books" && method === "PUT") {
      if (saveGate) await saveGate;
      const result = body.items.map((item: any) => {
        const b = books.find((b) => b.id === item.id);
        if (item.name === "Trùng")
          return { id: item.id, ok: false, error: "Tên truyện bị trùng" };
        Object.assign(b, item, { version: b.version + 1 });
        return { id: item.id, ok: true, version: b.version };
      });
      return route.fulfill({ json: result });
    }
    if (path === "/manage/genres")
      return route.fulfill({
        json:
          method === "GET" ? [{ id: book, name: "Kiếm hiệp" }] : { ok: true },
      });
    if (path === "/manage/jobs") return route.fulfill({ json: jobs });
    if (path === "/manage/uploads" && method === "POST") {
      const id =
        "a2000000-0000-4000-8000-" + String(++serial).padStart(12, "0");
      uploads.set(id, { ...body, chunks: [] });
      return route.fulfill({ json: { id }, status: 201 });
    }
    const up = /^\/manage\/uploads\/([^/]+)(.*)$/.exec(path);
    if (up) {
      if (method === "PUT") uploads.get(up[1]).chunks.push(body);
      return route.fulfill({
        json: up[2] === "/cover" ? { id: book2 } : { ok: true, id: up[1] },
      });
    }
    if (path.startsWith("/manage/assets/"))
      return route.fulfill({
        contentType: "image/webp",
        body: Buffer.from("synthetic-normalized-cover"),
      });
    if (path === "/manage/imports") {
      jobs.push({ id: book, status: "queued", kind: "FILE_IMPORT" });
      return route.fulfill({ json: { jobId: book }, status: 202 });
    }
    const ch = /^\/manage\/books\/([^/]+)\/chapters$/.exec(path);
    if (ch) {
      const b = books.find((b) => b.id === ch[1]);
      return route.fulfill({
        json:
          method === "GET"
            ? {
                book: b,
                groups: [],
                chapters: [
                  {
                    id: chapterId(1),
                    order: 1,
                    displayNumber: "1-2",
                    title: "Một",
                    url: "",
                    status: "DONE",
                    part: "Phần một",
                    volume: "Quyển một",
                  },
                ],
              }
            : { jobId: book },
        status: method === "GET" ? 200 : 202,
      });
    }
    const del = /^\/manage\/books\/([^/]+)$/.exec(path);
    if (del && method === "DELETE") {
      books = books.filter((b) => b.id !== del[1]);
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/analysis") {
      if (method === "GET") return route.fulfill({ json: { jobs: analysis } });
      if (rejectAnalysis)
        return route.fulfill({
          status: 400,
          json: { error: "INVALID_INPUT", message: "Máy chủ từ chối URL" },
        });
      for (const raw of body.urls)
        analysis.push({ id: book, url: raw, status: "queued", book: null });
      return route.fulfill({ json: analysis, status: 202 });
    }
    if (path === "/analysis/actions") {
      analysis = analysis.filter(
        (j) => body.action !== "drop" || j.id !== body.id,
      );
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/settings/analysis")
      return route.fulfill({
        json: { SITE_RULES: "", JUNK_WORDS: "", DELAY_MS: 500 },
      });
    return route.fallback();
  });
  return {
    requests,
    uploads,
    holdSave: (gate: Promise<void>) => {
      saveGate = gate;
    },
    reject: () => {
      rejectAnalysis = true;
    },
  };
}
test("management defaults grid, drafts survive editor close, save-all retains failed item", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/manage");
  await page.getByRole("button", { name: "Sửa Đường về", exact: true }).click();
  await page.getByLabel("Tên truyện", { exact: true }).fill("Đã sửa");
  await page.getByRole("button", { name: "Đóng — giữ bản nháp" }).click();
  await expect(page.locator(".managed-book.pending")).toHaveCount(1);
  await page.getByRole("button", { name: "Sửa Sách hai", exact: true }).click();
  await page.getByLabel("Tên truyện", { exact: true }).fill("Trùng");
  await page.getByRole("button", { name: "Đóng — giữ bản nháp" }).click();
  await page
    .getByRole("button", { name: "Lưu tất cả (2)", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Tên truyện bị trùng");
  await expect(page.locator(".managed-book.pending")).toHaveCount(1);
  expect(f.requests.find((r) => r.method === "PUT")?.body.items.length).toBe(2);
});
test("edit made during save survives response with rebased version", async ({
  page,
}) => {
  const f = await fixture(page);
  let release!: () => void;
  f.holdSave(new Promise<void>((r) => (release = r)));
  await page.goto("/manage");
  await page.getByRole("button", { name: "Sửa Đường về" }).click();
  await page.getByLabel("Tên truyện", { exact: true }).fill("Lần một");
  await page.getByRole("button", { name: "Đóng — giữ bản nháp" }).click();
  await page
    .getByRole("button", { name: "Lưu tất cả (1)", exact: true })
    .click();
  await page.getByRole("button", { name: "Sửa Đường về" }).click();
  await page.getByLabel("Tên truyện", { exact: true }).fill("Lần hai");
  release();
  await page.getByRole("button", { name: "Đóng — giữ bản nháp" }).click();
  await expect(
    page.getByRole("button", { name: "Lưu tất cả (1)", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Lần hai" })).toBeVisible();
});
test("draft warns on sidebar navigation and keeps pending if staying", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/manage");
  await page.getByRole("button", { name: "Sửa Đường về" }).click();
  await page.getByLabel("Tác giả", { exact: true }).fill("Đổi");
  await page.getByRole("button", { name: "Đóng — giữ bản nháp" }).click();
  await page.getByRole("link", { name: "Tải sách" }).click();
  await expect(
    page.getByRole("dialog", { name: "Bản nháp chưa lưu" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Ở lại" }).click();
  await expect(page).toHaveURL(/\/manage$/);
  await page.getByRole("link", { name: "Tải sách" }).click();
  await page.getByRole("button", { name: "Bỏ bản nháp và rời trang" }).click();
  await expect(page).toHaveURL(/\/download$/);
});
test("cover preview staged until save; cancel has no commit", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/manage");
  await page.getByRole("button", { name: "Sửa Đường về" }).click();
  await page.getByLabel("Chọn ảnh bìa").setInputFiles({
    name: "cover.png",
    mimeType: "image/png",
    buffer: Buffer.from("synthetic-upload"),
  });
  await expect(
    page.getByRole("img", { name: "Xem trước bìa sách" }),
  ).toHaveAttribute("src", /^blob:/);
  expect(
    f.requests.filter((r) => r.path === "/manage/books" && r.method === "PUT"),
  ).toHaveLength(0);
  await page.getByRole("button", { name: "Đóng — giữ bản nháp" }).click();
  await page.getByRole("button", { name: "Sửa Đường về" }).click();
  await expect(
    page.getByRole("img", { name: "Xem trước bìa sách" }),
  ).toHaveAttribute("src", /^blob:/);
  await page.getByRole("button", { name: "Đóng — giữ bản nháp" }).click();
  await page.getByRole("button", { name: "Hủy bản nháp" }).click();
  await expect(page.locator(".managed-book.pending")).toHaveCount(0);
  expect(f.uploads.size).toBe(1);
});
test("multi-chunk import upload carries exact data, queues and reports status", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/manage");
  await page.getByRole("button", { name: "Thêm truyện", exact: true }).click();
  await page.getByLabel("Tên truyện", { exact: true }).fill("Nhập mẫu");
  const bytes = Buffer.alloc(300000, 65);
  await page.getByLabel("File truyện", { exact: true }).setInputFiles({
    name: "story.txt",
    mimeType: "text/plain",
    buffer: bytes,
  });
  await page.getByRole("button", { name: "Nhập truyện", exact: true }).click();
  await expect
    .poll(() => f.requests.some((r) => r.path === "/manage/imports"))
    .toBe(true);
  const uploaded = [...f.uploads.values()][0];
  expect(uploaded.chunks.length).toBe(2);
  expect(
    Buffer.concat(
      uploaded.chunks.map((c: any) => Buffer.from(c.data, "base64")),
    ),
  ).toEqual(bytes);
  await expect(page.getByText("queued", { exact: true })).toBeVisible();
});
test("short paste form excludes FILE link and keeps grouped chapter label", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/manage");
  await page.getByRole("button", { name: "Sửa Đường về" }).click();
  await page.getByRole("button", { name: "Thêm chương", exact: true }).click();
  await expect(
    page.getByLabel("Kiểu", { exact: true }).locator("option"),
  ).toHaveCount(2);
  await page.getByLabel("Thứ tự chương").fill("3");
  await page.getByLabel("Nội dung", { exact: true }).fill("Ngắn");
  await page.getByRole("button", { name: "Gửi chương" }).click();
  await expect
    .poll(
      () =>
        f.requests.find(
          (r) => r.path.includes("/chapters") && r.method === "POST",
        )?.body.text,
    )
    .toBe("Ngắn");
});
test("delete confirms trash choice and removes selected book", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/manage");
  await page
    .locator(".managed-book")
    .first()
    .getByRole("button", { name: "Xóa", exact: true })
    .click();
  await page.getByLabel("Đưa thư mục Drive vào thùng rác").check();
  await page.getByRole("button", { name: "Xác nhận xóa", exact: true }).click();
  await expect(page.locator(".managed-book")).toHaveCount(1);
  expect(f.requests.find((r) => r.method === "DELETE")?.body.trash).toBe(true);
});
test("analysis optimistic rows show immediately, eight columns, allow another submission", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/download");
  await page
    .getByLabel("URL truyện (mỗi dòng hoặc ngăn bằng ;)")
    .fill("https://source.test/one/;https://source.test/two/");
  await page.getByRole("button", { name: "Thêm URL và phân tích" }).click();
  await expect(
    page.getByRole("table", { name: "Bảng phân tích truyện" }).locator("th"),
  ).toHaveCount(8);
  await expect(
    page
      .getByRole("table", { name: "Bảng phân tích truyện" })
      .locator("tbody tr"),
  ).toHaveCount(2);
  await page
    .getByLabel("URL truyện (mỗi dòng hoặc ngăn bằng ;)")
    .fill("https://source.test/three/");
  await page.getByRole("button", { name: "Thêm URL và phân tích" }).click();
  await expect(
    page
      .getByRole("table", { name: "Bảng phân tích truyện" })
      .locator("tbody tr"),
  ).toHaveCount(3);
  expect(
    f.requests.filter((r) => r.path === "/analysis" && r.method === "POST"),
  ).toHaveLength(2);
});
test("analysis server reject restores URL and invalid format stays in input", async ({
  page,
}) => {
  const f = await fixture(page);
  f.reject();
  await page.goto("/download");
  const input = page.getByLabel("URL truyện (mỗi dòng hoặc ngăn bằng ;)");
  await input.fill("bad url");
  await page.getByRole("button", { name: "Thêm URL và phân tích" }).click();
  await expect(input).toHaveValue("bad url");
  await input.fill("https://source.test/rejected/");
  await page.getByRole("button", { name: "Thêm URL và phân tích" }).click();
  await expect(input).toHaveValue("https://source.test/rejected/");
  await expect(
    page
      .getByRole("table", { name: "Bảng phân tích truyện" })
      .locator("tbody tr"),
  ).toHaveCount(0);
});
test("manual input validates total and sends manual configuration", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/download");
  await page.getByLabel("Chế độ phân tích").selectOption("manual");
  await page.getByLabel("Tên truyện", { exact: true }).fill("Mẫu thủ công");
  await page.getByLabel("Tổng chương").fill("20000");
  await page
    .getByLabel("Link chương mẫu")
    .fill("https://source.test/book/chuong-1");
  await page.getByRole("button", { name: "Thêm URL và phân tích" }).click();
  await expect
    .poll(
      () =>
        f.requests.find((r) => r.path === "/analysis" && r.method === "POST")
          ?.body.total,
    )
    .toBe(20000);
});

test("chapter close warns about unsubmitted text and Escape leaves metadata draft intact", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/manage");
  await page.getByRole("button", { name: "Sửa Đường về" }).click();
  await page.getByRole("button", { name: "Thêm chương", exact: true }).click();
  await page.getByLabel("Nội dung", { exact: true }).fill("Chưa gửi");
  await page.getByRole("button", { name: "Đóng — giữ bản nháp" }).click();
  await expect(
    page.getByRole("dialog", { name: "Nội dung chương chưa gửi" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Tiếp tục nhập" }).click();
  await expect(page.getByLabel("Nội dung", { exact: true })).toHaveValue(
    "Chưa gửi",
  );
  await page.getByRole("button", { name: "Đóng — giữ bản nháp" }).click();
  await page.getByRole("button", { name: "Bỏ nội dung", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Sửa truyện" }),
  ).not.toBeVisible();
});
test("mobile management and analysis fit viewport with horizontal table scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await page.goto("/manage");
  await expect(page.locator(".managed-book")).toHaveCount(2);
  await page.screenshot({
    path: ".local-browser-results/phase-5-6-screenshots/manage-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("link", { name: "Tải sách" }).click();
  await page
    .getByLabel("URL truyện (mỗi dòng hoặc ngăn bằng ;)")
    .fill("https://source.test/book/");
  await page.getByRole("button", { name: "Thêm URL và phân tích" }).click();
  await expect(
    page
      .getByRole("table", { name: "Bảng phân tích truyện" })
      .locator("tbody tr"),
  ).toHaveCount(1);
  await page.screenshot({
    path: ".local-browser-results/phase-5-6-screenshots/download-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("browser Back warns before discarding metadata drafts", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/read");
  await page.getByRole("link", { name: "Quản lý sách" }).click();
  await page.getByRole("button", { name: "Sửa Đường về" }).click();
  await page.getByLabel("Tác giả", { exact: true }).fill("Nháp riêng");
  await page.getByRole("button", { name: "Đóng — giữ bản nháp" }).click();
  await page.goBack();
  await expect(
    page.getByRole("dialog", { name: "Bản nháp chưa lưu" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/manage$/);
  await page.getByRole("button", { name: "Ở lại" }).click();
  await expect(page.locator(".managed-book.pending")).toHaveCount(1);
});
