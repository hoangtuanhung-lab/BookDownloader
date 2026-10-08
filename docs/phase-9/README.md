# Phase 9 — Vận hành local và chuẩn bị phát hành

Ngày 09/10/2026, `2.0.0-phase.9`. Có code vận hành và diễn tập bằng PostgreSQL local, nội dung tự viết và Drive/OAuth giả. Chưa chuyển thư viện thật, deploy dịch vụ hay bật scheduler/billing. [Báo cáo](REPORT.md) và [runbook chuyển vận hành/rollback](RUNBOOK.md).

## Người dùng và quản trị

- Google login đưa độc giả đến `/read`; tìm tên/tác giả/thể loại, đọc chương, mục lục, cuộn/lật trang, font/ngày đêm và tiến độ riêng. Auth thật chờ cấu hình sau đóng code; fixture không phải đường đăng nhập bỏ qua xác thực trong sản phẩm.
- Admin cấp quyền Đọc/Tải/Quản lý/Quản trị độc lập. Bootstrap owner bằng công cụ server; người đăng nhập đầu tiên không tự có admin. Xem [auth](../phase-2/README.md).
- Tải: phân tích URL tự động/thủ công, hàng chờ, bảng 8 cột, start/pause/resume/retry/cancel. Worker hữu hạn, độc lập browser. [Hướng dẫn tải](../phase-7/README.md).
- Quản lý: sửa metadata/Lưu tất cả, nhập TXT/cặp marker/thư mục, thêm chương và ảnh bìa trong mục sửa truyện. Outbox đồng bộ `info.txt` đúng `##Tên truyện`, `##Tác giả`, `##Thể loại`, `##link gốc`. [Hướng dẫn quản lý](../phase-5/README.md).
- `/admin` → **Vận hành**: bảo trì, tạo/đăng ký root và counters tác vụ hết lease/chờ lâu/lỗi, đồng bộ lỗi, sách chưa review. Bật bảo trì trước cấu hình root; thư viện có sách không được chuyển root bằng nút này. Credentials Drive chỉ ở server.

Bảo trì chặn ghi metadata/tiến độ/cài đặt và nhận tác vụ mới; sách đã xuất bản vẫn đọc được nếu backend/Drive hoạt động. Đăng ký tài khoản và ghi tiến độ có thể bị từ chối trong khoảng này; thử lại sau. Bật bảo trì khi writer còn chạy sẽ bị từ chối: chờ lượt hữu hạn kết thúc, kiểm worker cũ rồi thử lại. Tạo root gián đoạn giữ receipt pending/uncertain để đối chiếu riêng, không tự lặp create khi chưa rõ kết quả.

Cookie website chỉ ở `SOURCE_COOKIES_JSON` của worker, exact host; không đưa vào VITE, log công khai hoặc nhập credential từ Script Properties. Lỗi 403/429 cần kiểm owner/scopes/quota/backoff ở server; không bypass quyền.

## Chạy và kiểm tra local

Theo [setup nền](../phase-1/README.md), Node 24.19.0/npm 11.9.0/PostgreSQL 17; `.env` chỉ cấu hình local, không commit khóa. Google login thật chờ staging, kiểm thử dùng session giả.

```bash
npm ci
npm run db:up
npm run db:migrate
npm run check
npm run dev
# Terminal khác
npm run dev:web
```

Đặt `BOOTSTRAP_ADMIN_USER_ID` trong `.env` là UUID owner đã bootstrap:

```bash
npm run operations:status
npm run operations:maintenance -- on
npm run release:preflight
npm run operations:maintenance -- off
npm run test:operations:db
npm run test:operations:browser
npm run test:migration:restore
npm run test:migration:load
npm run worker:check
npm run build
# Chỉ sau commit, worktree sạch, thư mục output mới
npm run release:prepare -- .local-library/release-candidate
```

Các CLI SQL/migration/backup/preflight từ chối DB từ xa. Preflight kiểm checksum tất cả schema, maintenance, root binding và mọi alert bằng 0; exit 1 nếu chưa sẵn sàng, cloud gates vẫn false. Worker check cần ledger đến `202610090023_operations_receipts.sql`, không claim job hay gọi Drive.

Release manifest ghi version/contract/commit và SHA-256 lock/schema/web/API/worker. CI main tạo candidate; manual release kiểm provenance/hash trước dùng deploy credentials. Browser rebuild từ đúng commit với public production config và ghi manifest riêng; API giữ binary candidate. DB migration/worker/scheduler là bước riêng có review.

Browser tests cần Chromium (`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium` trong môi trường này). Private exports/dump/file map/report mới ở `.local-library/`, gitignored. Báo cáo Phase 8 đã công bố giữ nguyên; chỉ cờ `PHASE8_RECORD_REPORT=1` mới ghi đè báo cáo đó. Giữ baseline Apps Script V1.59.2 và 29 file gốc.
