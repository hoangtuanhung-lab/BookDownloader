# Báo cáo Phase 7 local — 08/10/2026

Baseline: `852997fb322b7beb9c1e05bbe12845dc685c3251` (Phase 5–6). Web mới `2.0.0-phase.7`. **Gate local đạt; dịch vụ thật/website thật/load và scheduler cloud còn mở**, theo yêu cầu làm local trước. Không provision/deploy, không yêu cầu hoặc dùng credentials thật.

## Kết quả

F08–F16/F20/F28/F36–F38 theo phạm vi Phase 7: điều phối FILE/WEB riêng, IDLE/READY/priority, download WEB, retry/backoff/Retry-After/cookie boundaries, checkpoint/resume/lease fencing, pause/cancel/delete in-flight, verify/FOLDER exception, removed log/info sync, monitor/pagination/config. Tái sử dụng `parseChapterHtml_`, `emptyRuns_`, filename/header/group/import helpers và Drive adapter Phase 3–6. Cấu hình root/cookie vẫn server-only; giao diện chưa kết nối Google cloud.

Thay khóa global Phase 5–6 bằng writer lock theo sách; claim/commit SQL ngắn, tách remote IO ra khỏi transaction cả trong prepare import/add/analysis/outbox. Có finite CLI và loop local được bật chủ động. Migrations 014–017 thêm mới, không sửa ledger cũ. 29 file Apps Script `.gs/.html`, Code.gs V1.59.2 và golden/info tests nguyên trạng.

| Bộ kiểm tra chạy trong đợt này | Đạt |
|---|---:|
| Legacy info/baseline/hash | 98/98 |
| Unit Phase 1–7 (`npm test`) | 168/168 |
| Foundation SQL/RLS | 29/29 |
| Auth SQL/API | 17/17 |
| Auth concurrency | 1/1 |
| Storage SQL/API | 14/14 |
| Reader SQL/API | 12/12 |
| Management/analysis SQL/API/executor | 22/22 |
| Download SQL/API/executor mới | 22/22 |
| Guest browser | 5/5 |
| Auth browser | 12/12 |
| Reader browser | 15/15 |
| Management/analysis browser | 13/13 |
| Monitor browser mới | 5/5 |
| **Tổng** | **433/433** |

Không cộng lượt chạy lặp, số assertion hoặc kết quả lịch sử vào tổng. Các test mới gồm 6 unit, 22 SQL/API/executor và 5 browser. `npm run check`, build browser/server, bundle server-secret/cookie sentinel, Docker frozen install/build/worker `--check`, migration repeat và worker schema check đạt. Xem [commands/phạm vi](README.md); CI bổ sung test download.

## Bằng chứng và sửa lỗi phát hiện

- PostgreSQL thật local/database disposable, nội dung tự viết, Drive/HTTP fixture. Không coi mocks là Google API/website thật. Hai worker tranh khóa sách: cùng sách bị chặn, sách khác tải được. Lease hết hạn bị fence và nhận lại với generation mới.
- Crash sau file trước DB: có work/hash checkpoint, retry không fetch lại HTTP và chỉ một file. Pause trong HTTP, cancel trong upload, xóa sách/chương và đổi metadata giữa lượt đều không commit dữ liệu cũ hoặc dựng lại đối tượng đã xóa.
- FILE/WEB cap 1 riêng: FILE vẫn chạy khi WEB đầy; reorder chọn đúng sách IDLE. AUTO_RESUME=false dừng đúng batch; retry 429 giữa đợt giữ số chương còn lại, không chạy thêm chương thứ ba ngoài batch hai chương.
- 429 tôn trọng Retry-After; 403 terminal, 503 dừng ở ba attempts; lỗi quyền Drive giữ PENDING và failed/error. Cookie/SSRF/pinned DNS tests Phase 6 chạy lại; challenge page có test riêng, không đưa CAPTCHA vào emptyRuns.
- Verify 205 file mất qua ba lượt không bỏ sót do danh sách DONE co lại; WEB tải lại, FOLDER verify không fetch mạng; thêm link vào WEB/FOLDER tự xếp đúng việc tải mới, giữ các file FOLDER mất không có URL. FILE pause/continue giữ temp và file DONE; cancel chapter hoàn tất/skipped rồi dọn temp.
- Hủy chương và tạm dừng chương được tách đúng baseline. Delete chương đã tải enqueue trash và chỉ trash file có snapshot ownership; không đổi số còn lại. Removed log qua nhiều đợt tăng version và giữ đủ hai lượt xóa; outbox mutation trong IO không giữ SQL lock và retry repair metadata mới.
- Monitor desktop/mobile 390px có filter, reorder, counters, settings, refresh, reload/quay lại tab; không GET toàn bộ danh sách chương. Đã xem screenshot local ignored. Download-only có chapter retry/pause/cancel, không delete hoặc config admin.
- Một browser regression cũ dùng selector tất cả `table` để đếm tám cột; khi monitor thêm bảng thứ hai, đổi selector sang caption **Bảng phân tích truyện**, giữ nguyên assertion tám cột/optimistic rows. Auth placeholder 501 chuyển thành endpoint 200; test permission/RPC được cập nhật tương ứng. Crash Drive trước đây cần retry tay, nay test kiểm queued + next_run_at tự retry. Không hạ assertion nghiệp vụ để làm xanh.

## Giới hạn

Chưa kiểm live cookie/quota/Drive ownership/Google OAuth/Netlify/PostgREST/Cloud Scheduler; CLI loop với Google thật chưa chạy. Worker finite và logic resume đã kiểm bằng fixture/SQL; scheduler enabled hoặc PID không được dùng làm bằng chứng hoàn thành tải. Chưa đo throughput/heap/cost trên thư viện lớn hoặc nghiệm thu touch vật lý. Mọi remote IO vẫn có thời gian in-flight; file orphan có thể còn sau cancel/delete, DB/reader không xuất bản file đó.

Phase 8 còn migration thư viện thật, progress mapping, parity/load/backup; Phase 9 phát hành/rollback/single-writer. Chỉ chạy các dịch vụ thật sau khi chủ dự án đóng code. Không chạy GAS trigger cũ và worker mới ghi cùng thư viện.
