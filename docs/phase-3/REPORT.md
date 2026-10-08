# Kết quả Phase 3 — 08/10/2026

**Phần local đã triển khai và kiểm chứng; gate cloud còn mở theo quyết định chủ dự án.** Web version `2.0.0-phase.3`. Giữ nguyên 29 file `.gs/.html` ở root và `tests/book-info.test.js` so với baseline V1.59.2; không sửa expected golden để làm port đạt.

## Thay đổi

- Google Drive API v3 adapter với owner OAuth refresh, root/ancestry validation, async pagination, escape tên, request/byte/time budget, quota/timeout retry và metric. Không retry write mơ hồ; lần sau tìm file theo tên để phục hồi.
- Port thư mục thể loại/truyện/Phần/Quyển, tên và header TXT, `info.txt`, `_import.json` và log chương xóa dùng injected clock. Info cập nhật cùng ID, không trùng; phiên bản cũ hoặc cùng version khác nội dung bị từ chối. `syncBookInfo` khóa row PostgreSQL xuyên IO, kiểm version và chỉ lưu ID/synced sau Drive thành công.
- API chapter/cover kiểm server-derived actor/read, publication, chapter và mapping synced trước cache hoặc Drive. Sau remote IO kiểm lại mapping/quyền. Ảnh proxy chỉ nhận signature/mime PNG/JPEG/WebP; browser không được truyền file ID và không nhận internal IDs.
- Migration 006 thêm cache private ở PostgreSQL và RPC service-only. Key gồm versions và hash JUNK_WORDS; giới hạn 60.000 byte/entry, 8.000.000 byte tổng, TTL 5 phút, eviction có khóa. Cache bị vô hiệu khi đổi content/book/resource version hoặc bộ lọc.
- Export Sheets/Properties chỉ đọc và redact theo allowlist; inventory Drive GET-only chuẩn bị cho đợt kiểm cloud; CLI dry-run offline có totals/row errors, deterministic UUID map và cấu trúc nhóm, giữ số âm/phân số và số hiệu text. Không tự import hoặc chạy job.
- Dữ liệu mẫu tự viết, test transport Drive và SQL database riêng có cleanup; CI thêm storage checks và scan Drive secrets trong browser bundle. Plan và hướng dẫn ghi rõ local trước, cloud sau đóng code.

## Kiểm chứng đã chạy

| Kiểm tra | Kết quả |
|---|---|
| Legacy info/golden/source hashes | **98/98** đạt |
| Domain/contracts/API/auth/storage/migration unit | **132/132** đạt; thêm 38 so với Phase 2 |
| SQL/RLS/constraints foundation | **29/29** đạt |
| Auth SQL + API trên PostgreSQL local | **17/17** đạt |
| Auth concurrent admin mutations | **1/1** đạt |
| Storage API/SQL, cache cap/permissions/version, info write/concurrency | **14/14** đạt; database riêng đã xóa |
| Guest/UI browser | **5/5** đạt trên Chromium hệ thống |
| OAuth/admin/session browser | **12/12** đạt với SDK thật và responses synthetic |
| Typecheck/build | Đạt; Phase 2/3 tests và tools migration được đưa vào typecheck |
| Browser bundle với server/Drive secret sentinel | Đạt, không có server config hoặc sentinel |
| CLI dry-run mẫu | 1 book, 1 chapter, 2 groups, 5 resources; 0 lỗi/0 cảnh báo; ready true; **remoteWrites 0** |
| Migration repeat | Đạt, checksum ledger không drift |
| Docker frozen install/build/worker readiness | Đạt; exit 0; worker vẫn chưa nhận business jobs |
| npm audit production dependencies | 0 vulnerabilities tại lần kiểm |

Tổng **308/308 kiểm tra tự động đạt**, không skip. Counts không bao gồm typecheck/build, Docker, CLI smoke hoặc audit. Bộ storage SQL dùng PostgreSQL thật local, Auth verifier và Drive transport synthetic; không coi đó là bằng chứng OAuth/Drive/PostgREST thật đã hoạt động.

Unit coverage gồm tạo/cập nhật/no-op info, FILE link trống, tên/header chương ghép, thư mục nhóm, import JSON/log, pagination, ngoài root, thiếu/trash, 403 không retry, quota/timeout recover, budget, write fail, lost-create recovery, cache authorization trước hit, revoke/hide trong IO, strict FOLDER header và ảnh sai mime. Dry-run kiểm trùng ID/tên/URL/folder/order/file, orphan/status, missing/outside-book, inventory thiếu và redaction; exporter chạy với read-only mocks, không cung cấp API ghi.

SQL kiểm cache tồn tại qua connection khác, hidden/revoked/skipped/missing mapping không đọc cache, cross-book rejection, content/JUNK_WORDS invalidation, giới hạn byte/eviction, browser không đọc private cache/call actor RPC, Drive lỗi không ghi synced, stale version và hai info writes bị khóa/serialize thật bằng PostgreSQL.

## Phần chưa nghiệm thu

- Chưa kết nối Google Drive/Sheets/Google OAuth, Supabase hoặc Netlify thật; chưa tạo thư mục staging cloud, chưa chạy inventory thư viện thật. Chủ dự án yêu cầu làm sau khi đóng code. Cần kiểm owner identity/scopes/refresh/editor/quota và request headers với Drive thật.
- UI thư viện/đọc chương là Phase 4; UI quản lý/ảnh bìa/thêm truyện Phase 5–6; worker/outbox/lease/recovery Phase 7. Các helper ghi yêu cầu caller giữ database lock/lease; chỉ info writer đã có transaction tích hợp.
- Dry-run chưa ghi DB hoặc chuyển thư viện. Helper export chưa có UI tải JSON cho thư viện lớn. Queue/user progress/log messages được giữ ngoài export tự động, cần migration riêng ở Phase 8.
- Khi file thay đổi/xóa ngoài app trên Drive, cache có thể giữ nội dung tối đa 5 phút. Quyền/publication/mapping của app được kiểm ở mỗi request; hoạt động quản lý sau này phải bump version/invalidate mapping.
- Chưa xác nhận remote Actions chạy hoặc deploy. Startup/tools vẫn theo môi trường local Phase 1 và tài liệu repo; không thay binding/secret hoặc publish cloud environment trong đợt này.

Hướng dẫn và sơ đồ cập nhật: [README](README.md). Kế hoạch tiếp theo: [Phase 4](../../PLAN_WEB_APP.md).
