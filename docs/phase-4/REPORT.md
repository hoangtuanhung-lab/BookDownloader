# Kết quả Phase 4 — 08/10/2026

**Thư viện và trình đọc đã triển khai local. Gate dịch vụ cloud/thiết bị thật còn mở.** Web `2.0.0-phase.4`; mã nguồn Apps Script V1.59.2 và expected goldens giữ nguyên.

## Thay đổi

- Library API/SQL và React grid/table, tìm không dấu, bốn kiểu sort, pagination 24, cover riêng có token hoặc bìa chữ, card progress theo user. Màn đọc chỉ có sách xuất bản; DTO không lộ URL nguồn/file/folder ID.
- Mục lục phân trang 200, giữ Phần/Quyển/nhóm trống/Hồi/số ghép/lời tựa/thứ tự âm. Navigation, error/empty/deleted/retry và render text an toàn.
- Reader cuộn/lật trang, font hệ số, theme/blue, keyboard/touch/edge tap, thanh điều khiển và trợ giúp. Font được self-host có subset tiếng Việt và license; ratio giữ qua resize/font/mode và font loading.
- Cluster 5, prefetch, hai cụm/4 MB browser và 2 MB nội dung/response server; opaque cache tags, metadata/quyền được kiểm trước dùng client cache, publication được kiểm lại trước trả cluster. Request abort/version chống dữ liệu sách cũ.
- Durable progress/preferences theo namespace user, debounce/flush/retry và revision conflict dialog. Sửa initial Auth lifecycle để reload cùng user không xóa pending; callback đọc/ghi bound vào user, logout/switch/revoke vẫn xóa dữ liệu. Chọn server không ghi vị trí cũ trở lại.
- Migration 007 service-only reader RPC + preferences view. Local server trả đúng binary cover. CSP cho phép blob image; CI thêm reader SQL/browser. Bộ auth Phase 2 cập nhật fixture API library mới và expectation read endpoint 200, giữ nguyên assertions quyền/bearer/session.

## Kiểm chứng đã thực thi

| Bộ kiểm tra | Kết quả |
|---|---|
| Legacy info/golden/source hashes | **98/98** đạt |
| Unit domain/contracts/API/auth/storage/migration/reader | **144/144** đạt; thêm 12 so với Phase 3 |
| Foundation SQL/RLS | **29/29** đạt |
| Auth SQL/API | **17/17** đạt |
| Concurrent admin mutations | **1/1** đạt |
| Storage SQL/API/cache/info concurrency | **14/14** đạt |
| Reader SQL/API trên PostgreSQL local | **12/12** đạt, database riêng được xóa |
| Guest UI Chromium | **5/5** đạt |
| Auth/admin/session Chromium | **12/12** đạt |
| Reader desktop/mobile Chromium | **15/15** đạt |
| Typecheck, web/server build và bundle secret scan | Đạt |
| Repeat migration / Docker build + worker readiness | Đạt; worker vẫn skeleton chưa nhận business jobs |
| npm audit cả production/dev dependencies | 0 vulnerabilities tại lần kiểm |

Tổng **347/347 kiểm tra tự động đạt**, không skip. Typecheck/build/bundle/audit/Docker/migration smoke không cộng vào count. Browser chạy Chromium hệ thống, SDK Auth thật trên phiên synthetic và API fixtures; SQL/API dùng PostgreSQL local và Drive adapter với transport mô phỏng. Không coi đây là bằng chứng Google/Supabase/Netlify cloud thật đã nghiệm thu.

Reader E2E bao phủ tìm/grid/table/pagination/sort, cây nhóm/Hồi/lời tựa, text XSS, chapter keys, page keys/tap/swipe, font/resize/scroll conversion, night/blue, help/Escape, card progress, hai browser contexts khôi phục, offline retry/reload + conflict chọn server, lỗi/rỗng/xóa/retry, old response, logout/account switch, prefetch + permission metadata checks, ảnh blob có Bearer. Bản desktop/mobile đã được chụp để rà giao diện local.

SQL chứng minh published-only + pagination 24, tìm không dấu tên/tác giả, deterministic author sort, bound query, nhóm/range/âm/preface/cache tag, cluster 5 và cụm cuối/lỗi thiếu mapping, đọc không có worker, progress/preferences tách hai user, revision conflict, revocation/hidden từ chối cached cluster và browser role không spoof actor. Unit kiểm memory/cluster cap, version mismatch, namespace, pending offline, coalescing/revision/conflict/stopped callbacks và server cluster budget/publication/permission.

## Giới hạn và bước tiếp

- Chưa chạy Google OAuth/Drive thật, Supabase/PostgREST hoặc Netlify/CSP production; giữ các gate cloud để sau khi đóng code. Touch dùng events synthetic trên viewport mobile; chưa nghiệm thu cảm ứng/thanh địa chỉ/heap trên điện thoại vật lý.
- Sách nhập thử là dữ liệu tự viết trong test; UI nhập/CRUD/bìa ở Phase 5. Database chính và thư viện production không được seed hoặc thay đổi bằng bộ reader test. Không thêm fake login cho sản phẩm.
- Mục lục trang 200 và cache byte caps đã kiểm local; thư viện thật 20.000 chương, latency Drive và quota/free-tier cần đo sau. Heap/DOM có overhead ngoài byte payload.
- Worker tải/outbox/lease ở Phase 7; UI reader không gọi worker. Không provision staging hoặc bật billing, chưa xác nhận remote Actions chạy.

Hướng dẫn: [README](README.md). Phase tiếp theo: [Phase 5 — quản lý và nhập sách](../../PLAN_WEB_APP.md).
