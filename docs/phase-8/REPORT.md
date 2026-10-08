# Báo cáo Phase 8 local — 08/10/2026

Baseline web: `0d79ee987b3001b8ebe2ca2f92ee30080a894f3c` (Phase 7). Web mới `2.0.0-phase.8`. Đã triển khai và kiểm chứng công cụ migration/đối soát **local**. **Phase 8 chưa đạt gate đầy đủ**: còn các khoảng trống parity ở code và nghiệm thu thư viện/dịch vụ thật. Theo quyết định chủ dự án, không gọi Google/website thật, không provision Netlify/Supabase/worker cloud hoặc bật billing.

## Đã triển khai

Read-only export tách LOG/Script Properties/UserProperties private, browser progress export chủ động, đổi progress theo owner binding; importer PostgreSQL local rỗng có transaction/checksum/ledger/ID map, private mặc định, giữ URL/tác giả/genre/date/order/group/display/status gốc trong dữ liệu/report. DONE không file cần xác nhận skipped. Snapshot thay đổi bị chặn; rerun không overwrite thay đổi mới hoặc resurrect sách/chương mất.

Paused jobs mới không nhận lease cũ. Review gate chặn API start/retry/verify, worker và outbox của sách nhập trước đối soát; server review đòi owner/checksum/hash, không tự publish/resume. Mappings file nhập là pending; kiểm hash backup không được xem là kiểm quyền Drive live. Lỗi review API trả 409 với thông báo tiếng Việt an toàn.

Verify bytes/hash từng chapter file, inventory ancestry và backup path/symlink; restore thật bằng pg_dump/pg_restore PostgreSQL trong database disposable, so sánh tám bảng và permissions. Dump synthetic 0600/ignored; backup metadata không thay backup file. [Kết quả restore](backup-result.json).

Load theo ba workload Phase 0 với ngưỡng cố định trước chạy. Migration 019 phân trang chương trước joins/JSON, giữ index theo offset và quyền đọc, tránh dựng DTO cho toàn bộ sách. Mỗi workload xóa reader cache trước cold read để tránh dùng cache từ fixture trước. [Số đo thô](load-result.json):

| Workload | Import | Page p95 | Cold / warm |
|---|---:|---:|---:|
| 14 sách / 126 chương, đủ nguồn/status/skipped | 0,139 s | 14,1 ms | 6,08 / 1,12 ms |
| 100 sách / 20.000 chương | 14,69 s | 20,7 ms | 4,44 / 0,66 ms |
| 1 sách / 20.000 chương | 37,51 s | 8,8 ms | 3,57 / 0,84 ms |

Peak RSS process Node khoảng 360,4 MiB (<512 MiB); worker fixture 20 chương qua hai lượt khoảng 0,285 s, warm không đọc file lại. Drive/HTTP in-memory, DELAY_MS=0 chỉ ở bài đo queue. Đây **không** phải throughput website/Google, tổng RAM database, quota hoặc dự toán cloud; các số chi phí/quota giữ null.

## Kiểm chứng đợt này

| Bộ kiểm tra | Đạt |
|---|---:|
| Legacy info/baseline/hash | 98/98 |
| Unit Phase 1–8 | 178/178 |
| Foundation SQL/RLS | 29/29 |
| Auth SQL/API | 17/17 |
| Auth concurrency | 1/1 |
| Storage SQL/API | 14/14 |
| Reader SQL/API | 12/12 |
| Management/analysis SQL/API/executor | 22/22 |
| Download SQL/API/executor | 22/22 |
| Migration SQL/review/RLS, restore, load | 15/15 |
| Guest / auth / reader / management / monitor browser | 50/50 |
| **Tổng ca riêng biệt** | **458/458** |

Migration suite chạy restore (14 ca) và load (một ca bổ sung), không cộng lượt chạy lại. Browser dùng fixture; SQL dùng PostgreSQL local và mock IO. `npm run check` kiểm type/build và tests; toàn bộ SQL/API/browser hồi quy chạy trong đợt này. Migrations 018–019 mới, không sửa migrations 001–017; repeat ledger và worker schema check đạt. 29 file GAS, V1.59.2 và golden/info tests giữ nguyên. CI thêm migration/load local; không deploy hoặc migrate database production khi push. Bundle kiểm không lộ server-secret/cookie sentinel, audit dependencies production 0 lỗ hổng, Docker frozen build/worker `--check` và sharp WebP encode/decode đạt.

## Gate còn mở

[PARITY](PARITY.md) có đủ 42 nhóm và 34 API với routes thực tế, bộ bằng chứng và phần còn thiếu. Mapping không chứng nhận mọi ca nghiệm thu đã đủ:

- UI/API tạo/đăng ký root chưa có, hiện root cấp/configure riêng qua server environment; cần triển khai hoặc chủ dự án chốt thay đổi workflow trước đóng code.
- FILE pending giữ dừng tới khi chuyển/đối chiếu `_import.json`; ANA_QUEUE/LOG/removed logs được giữ trong private archive, chưa replay tự động sang jobs/rows mới. CONFIG giữ report để review, chưa tự áp vào settings; ngày chương giữ report. Chưa có delta migration hoặc chuyển snapshot thay đổi; không xóa source state để bỏ qua conflict.
- Importer chỉ chạy local rỗng. Chưa có migration staging/production thật, owner Google/Drive verification, live RLS/OAuth/refresh/quota/cost, backup folder thật, accessibility screen reader/contrast audit và thử rollback thư viện thật.

Giữ các checkbox gate đầy đủ mở trong [plan](../../PLAN_WEB_APP.md). Đóng các gaps code trước bước kiểm cloud; Phase 9 deployment/operations chưa thực hiện. Không bật hai worker cũ/mới cùng ghi folder trong migration thật. Hướng dẫn và giới hạn: [README](README.md).
