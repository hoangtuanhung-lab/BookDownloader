# Kết quả Phase 1 — 08/10/2026

**Nền local đã triển khai. Gate staging còn mở.** Không thay đổi 29 file source Apps Script hoặc bộ kiểm thử info.txt baseline. Apps Script vẫn V1.59.2; web mới 2.0.0-phase.1.

## Phạm vi đã làm

- npm workspaces web/worker/domain/contracts/infrastructure, Node 24.19.0 và npm 11.9.0, exact dependencies và lockfile; .env.example không có cloud secrets.
- React shell tái sử dụng menu, palette và logo PNG nhúng từ CSS cũ; dialog/toast/help/responsive. Các màn ghi rõ phase chưa triển khai, không có đăng nhập hay thao tác sách giả.
- Domain ES module pure, Parser nhận HTML thay fetch toàn cục, CSV parser production, bốn tiêu đề info.txt; năm interfaces typed BookRepository/DriveStorage/HttpFetcher/JobRepository/Clock. Interfaces chưa có adapters nghiệp vụ đầy đủ.
- 20 bảng Postgres, FK/uniques/checks/indexes, numeric giữ thứ tự âm/phân số, display_number text; RLS deny-by-default, policy read/publication/blocked và progress/preferences riêng user. Quyền select theo cột loại URL nguồn/Drive IDs khỏi reader. Internal jobs/secrets/outbox/audit/migration không có browser grants.
- API health gọi PostgreSQL local hoặc RPC Supabase thật theo cấu hình; lỗi trả 503, correlation UUID và log allowlist, không đưa raw error/URL/token vào response. API nghiệp vụ chưa triển khai trả 501.
- Worker readiness hữu hạn, Docker non-root, chưa claim jobs. Netlify cấu hình API routing trước SPA, CSP và headers; migration production không chạy từ PR/build.
- CI đã lưu trong `.github/workflows/phase-1.yml`: npm ci/typecheck/tests/SQL/build/browser/bundle/Docker. GitHub Actions và Netlify previews chưa được xác nhận chạy trên remote.

## Kiểm chứng đã chạy

| Kiểm tra | Kết quả |
|---|---|
| Checkout sạch trong `/tmp/book-phase1-clean` | npm ci/check/build đạt; database mới áp dụng migrations, 29 SQL/RLS và 5 browser đạt; worker/bundle đạt, Git sạch |
| `npm ci` với npm 11.9.0 | Cài từ lockfile thành công |
| `npm run typecheck` | Đạt TypeScript strict ở các tầng mới |
| `npm run test:legacy` | **98/98** đạt, gồm SHA-256 source baseline và 74 golden cũ |
| `npm test` | **73/73** đạt: 62 golden port, 2 formatter info, coverage guard, 2 DNS-boundary, 6 contracts/API |
| `npm run test:db` trên PostgreSQL 17.6 | **29/29** đạt; 20 bảng RLS, reader/anonymous/download/manage/admin/blocked, cross-user denial và constraints |
| Migrations trên database Docker Compose mới | Cả hai file áp dụng thành công; chạy lại idempotent |
| Playwright với `/usr/bin/chromium` | **5/5** đạt: navigation/back, dialog/Escape/focus, API DB health/toast, mobile/collapse, unknown route/failure |
| `npm run build` | Web và API/worker bundles build thành công |
| Build web với service-key sentinel + `test:bundle` | Không thấy server config/sentinel/pg-pool trong assets browser |
| `APP_ENV=local ... node dist/worker.mjs` | Kiểm DB thành công rồi thoát, không nhận job |
| Docker build/run, user `node` | Build thành công với proxy DNS/CA mount; DB sẵn sàng exit 0, thiếu config exit 1 (negative check đúng kỳ vọng) |
| `npm audit` | 0 vulnerabilities tại lần kiểm; đã nâng Vite/CSV lên bản vá trước nghiệm thu |

Tổng **205** kiểm tra tự động đạt (98 + 73 + 29 + 5), không skip. SQL seed là dữ liệu synthetic, rollback sau suite. Không có sách/thư viện thật bị sửa.

## Giới hạn và phần còn mở

- Chưa có `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, Netlify site/credential trong runtime hoặc metadata cấu hình; chỉ kiểm tên/presence, không đọc/in giá trị secrets. Chưa provision dịch vụ, chưa deploy staging, chưa bật billing.
- PostgreSQL local có schema `auth` mô phỏng Supabase claim để kiểm chính sách thật bằng `SET ROLE`; chưa kiểm JWT, PostgREST hoặc Google OAuth thật. Phase 2 phải kiểm lại trên Supabase staging.
- UI hiện chỉ shell. Business adapters, worker claims/leases và Drive OAuth nằm ở các phase tương ứng; chỉ schema/interfaces có sẵn.
- Baseline library profile thật vẫn chưa có export owner (Phase 0); không dùng dữ liệu synthetic để kết luận tải thực tế hoặc miễn phí ở production.
- Trình tải browser của Playwright bị egress proxy từ chối CDN; dùng Chromium có sẵn và đã chạy đủ suite, không tắt kiểm tra TLS.

Hướng dẫn local/staging, Docker/proxy và migrations ở [README Phase 1](README.md). Staging thiếu cấu hình được ghi `[!]` trong plan, không đánh dấu toàn bộ Phase 1 đã đạt gate.

## Cấu hình cloud được lưu

Đã lưu draft `install_script` (npm ci + check) và `start_skill` (đọc plan, khởi động PostgreSQL/API/web, kiểm health và browser). Đây là hướng dẫn tái sử dụng, chưa publish snapshot hoặc xác minh ở phiên cloud mới. Người dùng xem/lưu trong environment settings và publish để áp dụng cho môi trường sau.

Docker ban đầu lỗi home read-only và DNS `proxy` không có trong build container. Đã dùng DOCKER_CONFIG ở /tmp, ánh xạ DNS proxy từ máy chủ và CA qua BuildKit secret; build/run thực tế thành công, không tắt TLS. Không lưu giá trị proxy/CA hoặc cloud credential vào repo.

Kiểm chứng checkout sạch phát hiện role Postgres thuộc cả cluster, không riêng database. Đã sửa local-auth bootstrap chỉ tạo role chưa có, rồi chạy lại trên database mới thành công. Lỗi này đã xử lý; không áp dụng bootstrap local cho Supabase.
