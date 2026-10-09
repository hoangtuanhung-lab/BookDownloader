# Phase 10 — Kiểm thử staging sau đóng code

Plan ban đầu gồm Phase 0–9. Phase 10 bổ sung bước kiểm dịch vụ thật đã hoãn theo yêu cầu local-first, dùng bản đóng code Phase 9. Đây là staging với project/database/thư mục Drive riêng; production và nghiệm thu chuyển thư viện vẫn thuộc gate Phase 9.

**Trạng thái 09/10/2026:** chủ dự án đã cung cấp site `https://bookdownloader.netlify.app` và project `https://ofgqwopjncdvrpeynuhf.supabase.co`, báo đã cấu hình Google provider. Truy vấn schema ban đầu trả NULL; chủ dự án đã báo chạy xong bootstrap SQL. Deploy Netlify bị secret scan coi URL công khai là secret; đã thêm ngoại lệ chỉ SUPABASE_URL, chờ redeploy xác minh. Chưa xác minh đăng nhập hoặc deploy/API end-to-end; proxy workspace đang chặn domain và đề xuất allowlist mới chỉ được lưu trong draft. Không dùng lỗi proxy để kết luận website bị lỗi. Drive/server credentials chưa được kiểm chứng. Kết quả 495/495 của Phase 9 là bằng chứng local, không phải kết quả Phase 10. Tài liệu chuẩn bị không tự đổi version; hotfix `2.0.0-phase.9.1` sửa phản hồi RPC rỗng khi lưu quyền, xem [báo cáo](ADMIN_SAVE_FIX.md).

## 10A — Tạo staging và cấu hình

1. Tạo Supabase project riêng trên gói miễn phí; lưu Project URL công khai `https://PROJECT_REF.supabase.co`. Database password và API keys nhập trực tiếp dashboard/Environment Settings, không gửi chat. Chọn region phù hợp; ghi hạn mức của tài khoản, không hứa miễn phí toàn bộ worker.
2. Tạo site Netlify staging cho repo BookDownloader, dùng URL cố định. Cấu hình build/publish/functions theo `netlify.toml`. Với site staging riêng, đặt `APP_ENV=staging` rõ ràng cho functions vì context production của file hiện mặc định production. Không cấu hình production site/keys ở site này. Có thể dùng branch staging cố định trên site đã có, giới hạn secrets đúng context. Không cấp staging secrets cho fork PR/preview không tin cậy.
3. Gửi hai URL công khai Supabase và Netlify để tiếp tục kiểm kết nối/redirect. Không gửi token, password, cookie hay service-role key qua chat. Chưa dùng workflow `release.yml`: workflow đó dành cho production và đang đóng mặc định.
4. Chỉ sau khi có credentials mới thực hiện deployment staging; ghi full SHA, run/deploy ID, môi trường và kết quả. Ưu tiên free tier; billing/nâng gói là quyết định riêng sau đo tải.

| Binding | Nơi dùng | Bảo mật |
|---|---|---|
| VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY | Netlify build | URL và anon/publishable key công khai |
| SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY | API functions, bootstrap CLI | Service-role chỉ server |
| APP_ENV=staging / APP_ORIGINS | API functions | Origin chính xác URL Netlify staging |
| BOOTSTRAP_ADMIN_USER_ID | CLI owner | UUID tài khoản Google đã xác minh, không frontend |
| DRIVE_CLIENT_ID / DRIVE_CLIENT_SECRET / DRIVE_REFRESH_TOKEN | API/worker | Drive OAuth chủ thư viện, riêng với Google login độc giả |
| DRIVE_ROOT_ID / DRIVE_OWNER_SUBJECT | API/worker | Root staging mới và định danh owner đã kiểm |
| DATABASE_URL | Worker/migration owner | DB staging; TLS/pooling theo provider |
| NETLIFY_AUTH_TOKEN / NETLIFY_SITE_ID | CLI deploy staging nếu cần | Token ở Environment Settings, site ID phải đúng staging |

Đối với biến của workspace Codex, nhập trong Environment Settings; đối với build/functions/worker, nhập tại dashboard hoặc secret manager tương ứng. Workspace có biến không đồng nghĩa Netlify/worker đã nhận cấu hình. Không bật production acceptance checkbox để deploy staging.

### Netlify báo secret scan với SUPABASE_URL

`SUPABASE_URL` là URL project công khai, cùng giá trị frontend dùng qua `VITE_SUPABASE_URL`; không phải service-role key. `netlify.toml` đặt `SECRETS_SCAN_OMIT_KEYS = "SUPABASE_URL"` để bỏ false positive cho đúng biến URL này. Quét service-role key/Drive credentials/tokens/cookies vẫn bật; không đặt `SECRETS_SCAN_ENABLED=false` hoặc bỏ quét toàn bộ thư mục. Trong Netlify dashboard, URL cũng có thể đánh dấu là biến không chứa secret. Redeploy commit mới có cấu hình này; thành công cần kiểm log Netlify thật.

## Chạy schema lần đầu bằng SQL Editor

Khi `public.profiles`, `public.books`, `public.schema_migrations` đều NULL, dùng [staging-bootstrap.sql](staging-bootstrap.sql). Đây là bản gộp đủ 23 migrations nguyên gốc, kèm filename/SHA-256 ledger, dành riêng cho schema ứng dụng chưa cài.

1. Mở file trên GitHub, chọn **Raw**, sao chép **toàn bộ** nội dung.
2. Trong đúng project Supabase `ofgqwopjncdvrpeynuhf`, vào **SQL Editor → New query**, chọn role `postgres`.
3. Dán nguyên file và bấm **Run**. File tạo schema/RLS/functions và ledger trong một transaction; nếu có lỗi, dừng và gửi thông báo lỗi (không kèm khóa), không chạy các đoạn còn lại riêng lẻ.
4. Kết quả cuối cần `migration_count = 23`, `profiles = profiles`, `books = books`, `maintenance_table = private.runtime_control`.
5. Không chạy lại bootstrap sau khi thành công. Nếu báo schema đã tồn tại, kiểm ledger trước; không drop bảng để ép chạy.
6. Netlify → Deploys → Trigger deploy → Deploy site, sau khi các environment variables đã lưu. Thử `/api/health` và Google login → `/read`; tài khoản mới vẫn chỉ quyền đọc, bootstrap admin riêng sau đăng nhập thành công.

File không tạo Auth schema/users/sessions giả, không chứa khóa và không ghi Drive. Migration 003 giữ/backfill hồ sơ quyền đọc cho Auth users đã có. 4/4 kiểm tra PostgreSQL local đạt: đủ original checksum/ledger không browser-readable, giữ Auth user/read-only, chặn rerun và rollback app+ledger khi lỗi cuối batch. Đây chưa phải kết quả chạy trên Supabase thật. SQL đóng băng theo 23 migration đang có; dùng migrations mới theo quy trình upgrade riêng, không thêm tay vào file để bypass ledger.

## 10B — Schema và Google login

- Review và áp dụng **tất cả 23 migration** trong `supabase/migrations/` theo tên tăng dần, chỉ file chưa áp dụng. Không làm theo số lượng migration lịch sử trong tài liệu Phase 1/2 (hai/năm file).
- Ghi filename/SHA-256 vào ledger `public.schema_migrations` theo contract của `tools/dev/migrate.ts`, transaction SQL và ledger cùng lần commit; không sửa checksum file đã áp dụng. Quy trình cloud cần review riêng; `npm run db:migrate`, các SQL test runners/backup/preflight local cố ý từ chối DB từ xa.
- Không chạy `tools/dev/local-auth*.sql` lên Supabase, không tạo users/sessions giả trên cloud. Kiểm schema compatibility và quyền RPC/service_role/anon/authenticated trên Supabase thật trước worker.
- Theo [Google OAuth](../phase-2/README.md#thiết-lập-google-oauth-thật--staging-miễn-phí): Google callback `https://PROJECT_REF.supabase.co/auth/v1/callback`; Supabase Site URL là Netlify staging, redirect chính xác `https://STAGING_HOST/auth/callback`. Google secret ở provider dashboard, không VITE. Thêm test users nếu consent đang Testing.
- Deploy/rebuild staging với public config rồi thử `/api/health`, `/api/version`, `/read` reload và đăng nhập Google → `/read`. Ghi version/contract/full SHA thực tế; Git-integrated build và candidate/manual deploy có thể có khác biệt, cần xác minh response thật.
- Dùng UUID chủ đã xác minh Google để `bootstrap:admin` theo hướng dẫn Phase 2. Kiểm độc giả thứ hai chỉ có read; quyền thu hồi/blocked/logout/session hết hạn và RLS thật trước cache.

## 10C — Drive và worker

Hotfix web `2.0.0-phase.9.2` bổ sung [worker nền Netlify](NETLIFY_WORKER.md) và nút Phân tích cho URL chờ; phù hợp thử staging không chạy worker trên máy tính. Chỉ bật sau khi có đầy đủ bindings server và kiểm gói/hạn mức thực tế. Cloud Run worker dưới đây vẫn là phương án ban đầu.

- Theo [Drive](../phase-3/README.md), cấu hình OAuth owner/scopes/refresh bằng secrets server. Dùng root staging mới, dữ liệu tự viết; không dùng thư viện production để thử ghi.
- Admin → Vận hành → bật bảo trì → đăng ký/tạo root; xác minh folder writable/root binding/receipt. Kiểm `info.txt` đủ bốn mục và cập nhật không nhân bản, ảnh bìa, TXT/marker/folder import và FILE pending resume.
- Worker image từ SHA đã đóng: `docker build --build-arg RELEASE_REVISION=<SHA> -f apps/worker/Dockerfile -t <image:SHA> .`. Kiểm `--version`/`--check`, rồi finite pass với DB/Drive staging. Check schema không thay kiểm Google access.
- Đầu tiên chạy hữu hạn, chưa bật scheduler/billing. Kiểm WEB auto/manual, pause/retry/cancel, outbox, expired lease/fencing và maintenance zero IO. Kiểm Drive deny/429/backoff bằng cách có kiểm soát trên fixture staging.

## 10D — Nghiệm thu và bàn giao

| Kiểm tra thật | Bằng chứng cần ghi | Trạng thái hiện tại |
|---|---|---|
| Supabase schema/RLS/RPC | checksum ledger, roles/denied requests | Chưa chạy |
| Netlify health/version/SPA/CSP | deploy ID/full SHA và responses | Chưa chạy |
| Google login/session/roles | hai tài khoản test, đọc ngay và deny đúng | Chưa chạy |
| Drive/root/info/cover/import | owner/scopes, hashes, số lượng file | Chưa chạy |
| Worker/download/maintenance | image digest, finite pass/jobs/outbox/zero IO | Chưa chạy |
| Backup/restore/rollback staging | DB + bytes, ACL/progress/hash, restore riêng | Chưa chạy |
| Quota/chi phí/mobile thực tế | thông số account và lượt đo | Chưa đo |

Dùng [runbook Phase 9](../phase-9/RUNBOOK.md) cho backup/rollback, smoke và chuyển vận hành. Restore local không phục hồi Drive remote. Production chỉ thực hiện sau owner nghiệm thu, backup thư viện thật, delta/reconcile cuối và không có writer cũ/mới ghi chồng. Giữ gate Phase 9 mở cho đến khi các điều kiện này đạt.
