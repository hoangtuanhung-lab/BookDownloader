import { test, expect, type Page } from "@playwright/test";
import { fixture as readerFixture, user } from "../phase-4/browser-fixture";
async function fixture(page: Page, permissions = ["read", "admin"]) {
  await readerFixture(page);
  let maintenance = false,
    rootId: string | null = null,
    revision = 1,
    fail = false;
  const calls: any[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      body = request.postData() ? request.postDataJSON() : null;
    if (path === "/api/me")
      return route.fulfill({
        json: { id: user, name: "Admin mẫu", permissions },
      });
    if (path === "/api/admin/users") return route.fulfill({ json: [] });
    if (path === "/api/admin/operations" || path === "/api/drive/root") {
      calls.push({ path, body });
      if (fail)
        return route.fulfill({
          status: 409,
          json: { error: "CONFLICT", message: "Tác vụ đang ghi; thử lại sau" },
        });
      if (body && path.endsWith("/operations")) {
        maintenance = body.enabled;
        revision++;
      }
      if (body && path.endsWith("/root")) {
        rootId = body.kind === "create" ? "created-root" : body.id;
        revision++;
      }
      return route.fulfill({
        json: {
          maintenance,
          rootId,
          revision,
          alerts: {
            expiredLeases: 0,
            stuckJobs: 0,
            failedJobs: 2,
            failedSync: 1,
            migrationReview: 3,
          },
        },
      });
    }
    return route.fallback();
  });
  return {
    calls,
    setFail() {
      fail = true;
    },
  };
}
test("admin enables maintenance before registering a root; refresh retains binding", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/admin");
  await page.getByRole("button", { name: "Vận hành", exact: true }).click();
  const region = page.getByRole("region", { name: "Vận hành thư viện" });
  await expect(
    region.getByRole("button", { name: "Lưu thư mục" }),
  ).toBeDisabled();
  await expect(
    region.getByText("Tác vụ lỗi: 2", { exact: true }),
  ).toBeVisible();
  await region
    .getByRole("button", { name: "Bật bảo trì", exact: true })
    .click();
  await region.getByLabel("ID thư mục", { exact: true }).fill("existing-root");
  await region.getByRole("button", { name: "Lưu thư mục" }).click();
  await expect(
    region.getByText("Thư mục lưu sách: existing-root"),
  ).toBeVisible();
  const req = f.calls.find((c) => c.path.endsWith("/root")).body;
  expect(req.revision).toBe(2);
  expect(req.requestId).toMatch(/^[a-f0-9-]{36}$/);
  await page.reload();
  await page.getByRole("button", { name: "Vận hành", exact: true }).click();
  await expect(
    region.getByText("Thư mục lưu sách: existing-root"),
  ).toBeVisible();
});
test("mobile create form uses parent and name; controls stay inside viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  await page.goto("/admin");
  await page.getByRole("button", { name: "Vận hành", exact: true }).click();
  const region = page.getByRole("region", { name: "Vận hành thư viện" });
  await region
    .getByRole("button", { name: "Bật bảo trì", exact: true })
    .click();
  await region.getByLabel("Thao tác", { exact: true }).selectOption("create");
  await region.getByLabel("ID thư mục cha").fill("parent-root");
  await region.getByLabel("Tên thư mục mới").fill("Thư viện");
  await region.getByRole("button", { name: "Lưu thư mục" }).click();
  await expect(
    region.getByText("Thư mục lưu sách: created-root"),
  ).toBeVisible();
  expect(f.calls.find((c) => c.path.endsWith("/root")).body.name).toBe(
    "Thư viện",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("conflict displays safe error and retains previous maintenance state", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/admin");
  await page.getByRole("button", { name: "Vận hành", exact: true }).click();
  await expect(page.getByText("Bảo trì:")).toBeVisible();
  f.setFail();
  await page.getByRole("button", { name: "Bật bảo trì", exact: true }).click();
  await expect(page.getByText("Tác vụ đang ghi; thử lại sau")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Bật bảo trì", exact: true }),
  ).toBeEnabled();
});
test("reader cannot enter operations or emit a root request", async ({
  page,
}) => {
  const f = await fixture(page, ["read"]);
  await page.goto("/admin");
  await expect(
    page.getByRole("button", { name: "Vận hành", exact: true }),
  ).toHaveCount(0);
  expect(f.calls).toHaveLength(0);
});
