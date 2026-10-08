# Phase 1 — Nền web/API/worker

Web mới: **2.0.0-phase.1**. Apps Script giữ nguyên **1.59.2**. Phase này có nền chạy local; đăng nhập Google, xử lý sách, Drive và worker nhận jobs chưa triển khai. Xem [báo cáo](REPORT.md) và [plan](../../PLAN_WEB_APP.md).

## Chạy từ checkout sạch

Cần Git, Node **24.19.0**, npm **11.9.0**, Docker Engine + Compose v2. Clone đầy đủ lịch sử để golden runner đọc baseline `aae3c570`.

```bash
git clone https://github.com/hoangtuanhung-lab/BookDownloader.git
cd BookDownloader
# Nếu dùng nvm:
nvm install
nvm use
npm install -g npm@11.9.0
npm ci
cp .env.example .env
npm run db:up
npm run db:migrate
npm run check
npm run test:db
```

Chạy hai terminal:

```bash
npm run dev
```

```bash
npm run dev:web
```

Trên máy của bạn, mở địa chỉ Vite in ra (mặc định cổng 5173). Web chuyển `/api` tới API local cổng 8888. Nút **Kiểm tra kết nối** gọi database thật; HTTP 503 khi thiếu cấu hình/migration hoặc DB ngừng. Không chỉ kiểm cổng mở.

```bash
npm run build
npm run test:bundle
npm run worker:check
```

Bản Phase 1 kiểm DB rồi thoát: chưa nhận job, chưa tải truyện. `.env` được nạp cho dev API, worker và runner DB; biến đã export được ưu tiên. Runner migration/tests chỉ chấp nhận DB local (`localhost`, `127.0.0.1`, `db`), không dùng để chạy lên production. Migrations có checksum, lock và transaction; chạy lại bỏ qua file đã áp dụng, sửa file đã áp dụng sẽ bị từ chối. Thêm migration mới khi đổi schema.

SQL/RLS tests tự tạo dữ liệu synthetic trong transaction và rollback toàn bộ. Không seed admin thật hay quyền cho tài khoản đăng nhập đầu tiên.

## Kiểm thử giao diện

```bash
npx playwright install --with-deps chromium
npm run test:browser
```

Trong Codex cloud hiện tại có Chromium hệ thống, dùng:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:browser
```

Nếu thư mục home chỉ đọc, dùng `npm ci --cache /tmp/book-npm-cache`. Docker build có thể dùng `DOCKER_CONFIG=/tmp/book-docker`; Compose không cần sửa home. Không tắt TLS/package checksum để xử lý lỗi cài đặt. Đã kiểm các lệnh local với Node/npm ở trên; xem REPORT cho phạm vi.

> Với checkout Phase 5–6 hiện tại, dùng `worker:check` để kiểm DB mà không cần credentials. `npm run worker` đã là executor hữu hạn nhận import/analysis/outbox; xem [hướng dẫn Phase 5](../phase-5/README.md). Các mô tả nhiệm vụ Phase 1 bên dưới là snapshot lịch sử.

## Docker worker

Từ thư mục gốc:

```bash
docker build -f apps/worker/Dockerfile -t book-worker:phase1 .
docker run --rm --network host --env-file .env book-worker:phase1 node dist/worker.mjs --check
```

`--network host` dùng cho PostgreSQL local trên Linux. Trên Docker Desktop, đặt `DATABASE_URL` dùng `host.docker.internal` và dùng cấu hình kết nối staging cho worker khi deployment thật; hiện local adapter chỉ chấp nhận host local đã nêu, nên ưu tiên chạy `npm run worker` trên Desktop. Không dùng password local cho cloud.

Trong môi trường có HTTPS proxy và CA riêng, build hỗ trợ CA bằng BuildKit secret (không lưu CA/proxy vào runtime image):

```bash
BOOK_PROXY_IP=$(getent ahostsv4 proxy | awk 'NR==1 {print $1}')
DOCKER_CONFIG=/tmp/book-docker docker build --network host --add-host "proxy:$BOOK_PROXY_IP" \
  --build-arg HTTP_PROXY --build-arg HTTPS_PROXY \
  --build-arg NO_PROXY=localhost,127.0.0.1 \
  --secret id=npm-ca,src="$NODE_EXTRA_CA_CERTS" \
  -f apps/worker/Dockerfile -t book-worker:phase1 .
```

Lệnh trên dành cho Codex có proxy host `proxy`; ánh xạ IP từ DNS của máy hiện tại, không bypass proxy. Chỉ dùng lệnh CA khi môi trường cung cấp `NODE_EXTRA_CA_CERTS`. Worker chạy user `node`, không tương tác, lỗi readiness trả exit 1. Chưa deploy Cloud Run/Cloud Scheduler hoặc bật billing.

## Staging Netlify + Supabase

Chưa có project/site/credentials staging trong phiên này. Các bước để hoàn tất gate staging:

1. Dùng một Supabase project riêng cho **staging**, trên gói miễn phí. Áp dụng theo thứ tự hai file trong `supabase/migrations` bằng SQL Editor hoặc quy trình migrations Supabase. **Không chạy `tools/dev/local-auth.sql` trên Supabase.**
2. Kết nối repo với Netlify Git integration; build/publish/functions/runtime đã có trong `netlify.toml`. Bật deploy previews cho PR tin cậy hoặc branch deploy staging.
3. Trong Netlify context **deploy-preview/branch-deploy**, cấu hình `SUPABASE_URL` và `SUPABASE_SERVICE_ROLE_KEY` của staging cho functions. Context production phải dùng project production riêng khi tới bước triển khai. Không chia sẻ khóa production cho previews/PR fork; Netlify secrets phải giới hạn context, không chỉ dựa vào `APP_ENV`.
4. Kiểm tra `/api/health` trả 200 khi DB sẵn sàng, 503 khi thiếu cấu hình; `/read` tải lại trực tiếp vẫn nhận SPA. Các API sách chưa triển khai trả 501. Kiểm headers/CSP trên response Netlify thật.
5. Chạy lại SQL/RLS trên môi trường Supabase staging với identities test khi Phase 2 có tài khoản Auth; runner local hiện mô phỏng `auth.uid()` bằng claim Postgres, chưa xác minh JWT/PostgREST của Supabase thật.

Chỉ khóa publishable/anon của Supabase được đặt trong `VITE_*`. **Không đặt service role, DB password, Drive refresh token hoặc cookie nguồn vào `VITE_*`.** CSP hiện dùng font local và cho phép kết nối HTTPS tới Supabase; Google OAuth redirect sẽ bổ sung/kiểm thử Phase 2, fonts reader Phase 6. Chưa cấu hình OAuth thật.

CI trên push/PR chạy lockfile install, typecheck, legacy/domain/contracts, migrations/RLS PostgreSQL, build, browser, kiểm bundle và Docker worker. CI không dùng cloud secrets. Netlify Git integration xử lý preview sau khi liên kết site; chưa có run GitHub Actions/preview được xác nhận trong phiên này.

Migration production không chạy từ PR hoặc trong Netlify build: người quản trị áp dụng migration đã review theo thứ tự qua Supabase trước deployment phụ thuộc schema, ghi phiên bản migration và kiểm readiness. Chưa tự động hóa migration production ở Phase 1.

## Cấu trúc và giới hạn tái sử dụng

| Vùng | Vai trò hiện tại |
|---|---|
| `apps/web` | React shell từ menu/palette/logo cũ; modal/toast/help, responsive, placeholder phase |
| `netlify/functions/api.ts` | API health thật; các endpoint nghiệp vụ chưa triển khai |
| `apps/worker` | Readiness hữu hạn, Docker non-root; chưa claim jobs |
| `packages/contracts` | Zod metadata/reader/permissions/health; DTO reader loại metadata nội bộ |
| `packages/domain` | Thuật toán pure được port, formatter info, domain boundary, 5 ports typed |
| `packages/infrastructure` | Kết nối DB local, Supabase health RPC, log allowlist |
| `supabase/migrations` | 20 bảng, constraints/indexes, RLS, quyền theo cột, RPC health chỉ service role |
| `tools/dev` | Startup, build, migrations local, SQL/RLS runner, kiểm bundle |

`legacy.mjs` là bản port JavaScript ES module của các hàm pure, không eval/VM và không gọi dịch vụ Apps Script. Giữ tên hàm để đối chiếu; tầng ports/contracts/web/API dùng TypeScript strict. Parser chương nhận HTML trực tiếp, fetch/discover nhiều trang nối HttpFetcher ở Phase 4. CSV dùng `csv-parse`, không dùng stand-in trong baseline runner cho production.

**62** ca golden kiểm thuật toán port, **2** ca kiểm formatter `info.txt`. Chưa port discover/network (4 ca, Phase 4), ghi info idempotent vào Drive (1 ca, Phase 3), removed log có clock (2 ca, Phase 5), reader cache authorization (1 ca, Phase 6). Hai ca domain/cookie substring cũ được thay bằng tests DNS boundary an toàn theo ADR-006. Toàn bộ 74 ca legacy vẫn chạy nguyên trạng để giữ bằng chứng baseline. Không sửa expected snapshot cho phù hợp port.

`info.txt` giữ đủ bốn tiêu đề; không thêm ảnh bìa vào file này. Các tính năng Apps Script khác vẫn hoạt động bằng source cũ, chưa được tuyên bố đã chuyển sang web. Không đưa legacy JS vào DOM React. `.claspignore` tiếp tục chỉ cho phép các file Apps Script ở thư mục gốc.
