# Phase 7 — Tải nền và vận hành tác vụ trên local

Web `2.0.0-phase.7`. Làm local trước; Google API, Netlify, Supabase, Cloud Run/Scheduler và website thật kiểm sau đóng code. Không provision, deploy hoặc bật billing. Mã Apps Script V1.59.2 giữ nguyên.

## Chạy và kiểm tra

Dùng Node 24.19.0/npm 11.9.0, frozen lock và PostgreSQL local theo [setup nền](../phase-1/README.md):

```bash
npm ci --no-audit --no-fund
npm run db:up
npm run db:migrate
npm run worker:check
npm run check
npm run test:download:db
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:download:browser
```

Trên máy chưa có Chromium hệ thống: `npx playwright install --with-deps chromium`, rồi `npm run test:download:browser`. Kiểm SQL/worker tạo database riêng, auth synthetic và Drive/HTTP fixture; không cần credentials và không gọi Google hay website thật. Browser dùng phiên synthetic qua route interception của test; production API không có cửa đăng nhập giả.

`npm run dev` và `npm run dev:web` khởi động API và giao diện local. Auth Google thật vẫn là gate riêng. Sau khi đóng code, chủ thư viện cấu hình các binding Drive phía máy chủ trong Environment Settings/`.env` ignored, rồi mới thử worker với thư mục staging riêng. Không gửi token/cookie qua chat. Google login của người đọc không cấp quyền ghi Drive cho worker.

## Chạy worker độc lập trình duyệt

- `npm run worker` hoặc `node dist/worker.mjs`: một lượt hữu hạn, mặc định ngân sách công việc mềm 45 giây, tối đa 10 jobs và 20 outbox candidates. HTTP có timeout 15 giây, Drive 5 giây/request; IO đang chạy có thể kết thúc sau ngân sách mềm.
- `npm run worker:loop` hoặc `node dist/worker.mjs --loop`: loop do người vận hành bật, nghỉ 10 giây giữa các lượt. Đóng tab không dừng tiến trình này. SIGINT/SIGTERM yêu cầu dừng sau lượt hiện tại và đóng pool; không cắt ngang file đang gửi.
- `--check`: xác nhận schema Phase 7, không claim việc, không gọi Drive/website và không cần binding Google.

Docker vẫn mặc định chạy **một lượt** để dùng với Cloud Run Jobs sau này. Chạy image với `--loop` là lựa chọn riêng cho tiến trình local được quản lý. Chưa bật scheduler cloud hoặc đo allowance/billing; giữ gói miễn phí làm ưu tiên. CLI loop với Google thật chưa chạy trong đợt local này; executor hữu hạn và sự độc lập với tab được kiểm bằng fixture/SQL/browser.

## Cấu hình và trạng thái

Mục **Tải sách → Giám sát tác vụ → Cấu hình tải nền** dành cho admin:

| Khóa | Mặc định | Giới hạn |
|---|---:|---:|
| BATCH_SIZE | 5 chương/đợt | 1–100 |
| DELAY_MS | 800 ms | 0–10000 |
| MAX_RETRY | 3 lần HTTP/chương | 1–10 |
| MAX_CONCURRENT | 2 truyện WEB hoạt động | 1–10 |
| FILE_CONCURRENT | 2 truyện FILE hoạt động | 1–10 |
| AUTO_RESUME | true | boolean |

FILE và WEB được admission riêng; `IDLE → READY → DOWNLOADING`, ưu tiên giảm dần rồi thứ tự tạo ổn định. Worker lấy việc bằng claim ngắn và khóa theo sách; hai worker không ghi cùng sách, sách khác vẫn tiến triển. Cap là số sách được admission, không phải số thread bắt buộc được tạo: một tiến trình xử lý tuần tự, chạy nhiều tiến trình mới sử dụng song song các slot.

`QUEUED`/`DONE` trong schema cũ vẫn tương thích; `DONE` là trạng thái hoàn tất tương đương `COMPLETED` của GAS. Job state riêng `queued/running/paused/done/failed/cancelled`; retry chờ bằng `next_run_at`, không giữ SQL transaction khi chờ hoặc gọi HTTP/Drive. Khi AUTO_RESUME=false, ngân sách chương của một đợt được checkpoint qua retry/yield; hết đợt thì PAUSED, bấm Tiếp tục để chạy đợt mới.

SITE_RULES/JUNK_WORDS tiếp tục dùng [cấu hình Phase 6](../phase-6/README.md). DELAY_MS tải dùng cấu hình tải riêng; DELAY_MS trong cấu hình phân tích chỉ áp dụng discovery. Cookie nguồn `SOURCE_COOKIES_JSON`, root `DRIVE_ROOT_ID` và owner `DRIVE_OWNER_SUBJECT` là binding máy chủ; không xuất cookie/token vào API/settings/browser. Đổi root của thư viện đã có dữ liệu phải đối chiếu inventory/mapping trước, không đổi tùy ý qua giao diện.

## Thao tác

- **Chuyển xuống tải** trên dòng ANALYZED hoặc trong monitor; không tự tải khi phân tích xong. **Tải tất cả** xếp tối đa 200 sách mỗi request để API ngắn, trả số còn lại; bấm tiếp nếu còn. Lên/xuống đổi priority cho IDLE, không đổi IDs hoặc thứ tự chương.
- **Tạm dừng/Hủy tác vụ:** giữ file đã commit và temp FILE, vô hiệu lease/epoch; lệnh có hiệu lực trước commit tiếp theo. HTTP/file đang in-flight có thể hoàn tất trên Drive; file chưa commit không được xuất bản/đăng ký. Tiếp tục có thể khôi phục file dở. Xóa sách vẫn dùng quản lý sách và lựa chọn trash như Phase 5.
- **Thử lại lỗi:** reset ERROR và ngân sách HTTP. 401/403/CAPTCHA giữ lỗi rõ, cần sửa quyền/cookie/rules; không thử vô hạn hoặc bypass bot. 429/5xx/network có budget, backoff/jitter và Retry-After (tối đa 1 giờ) lưu trong DB. Lỗi quyền/auth Drive giữ tác vụ failed; transient Drive có retry hữu hạn.
- **Chương lỗi:** download được retry/pause/cancel; delete cần thêm manage và revision hiện tại. Pause giữ ERROR; cancel đánh dấu DONE/skipped không có file và không xuất hiện trong reader. Retry có thể khôi phục chương skipped. Xóa chương lỗi ghi snapshot/lý do; xóa chương đã tải enqueue trash đúng file/owner. Không đánh lại số chương.
- **Kiểm tra file:** mỗi trang tối đa 100 DONE, cursor theo order ổn định. File WEB mất trở lại PENDING và tiếp tục tải. FILE đã dọn temp cần nhập lại nguồn; FOLDER báo lỗi và không biến thành việc tải mạng. Thêm chương bằng link vào FOLDER là yêu cầu tải riêng được chủ động cho phép, dùng cap WEB và chỉ xử lý chương có URL; không tự fetch các file mất không có nguồn. Lỗi quyền/ngoài root không coi là file mất. Browser không gửi arbitrary Drive file ID.

Monitor trả tối đa 24 sách/trang và 100 chương lỗi/trang, có filter FILE/WEB/FOLDER, làm mới, progress/counters/errors/in-flight. Poll 3 giây lấy tổng hợp, không tải toàn bộ hàng chương và không kích hoạt worker. DONE chỉ đếm chương thật không skipped; cột bỏ qua hiển thị riêng, nên sách hoàn tất có thể có ít file hơn tổng số chương. Bộ đọc tiếp tục chỉ đọc file đã đăng ký, published và có quyền.

## File và recovery

Tái sử dụng parser/cleaner/filename/group/header của baseline; WEB giữ số ghép/Phần/Quyển, tên truyện + đầu chương + body. Checkpoint trước upload ghi vị trí/tên/hash/phiên bản, không giữ body chương WEB lâu dài trong DB. Retry tìm đúng file/hash, kiểm owner/root và epoch/lease/chapter version trước đăng ký. FILE dùng `_import.json`, nối chương chưa xong, chỉ dọn temp khi hoàn tất, kể cả crash sau trash temp nhưng trước commit.

`info.txt` giữ đúng bốn mục tên/tác giả/thể loại/link gốc; nguồn FILE/FOLDER trống. Writer theo sách tuần tự hóa download/import/sync/cover/trash. Outbox đọc metadata hiện hành, kiểm lại sau IO; thay metadata trong lúc gửi file dẫn đến retry và repair phiên bản mới, không giả báo synced. Removed log dựng lại từ snapshot trong DB với thời điểm Việt Nam; mỗi đợt tự bỏ chương tăng version để các lượt log sau không bị mất vì dedupe hoặc cùng phiên bản Drive.

`emptyRuns_` áp dụng WEB NO_CONTENT/TOO_SHORT đúng baseline: tối đa ba lỗi liên tiếp có đầu/cuối hợp lệ, không bỏ dải dài hoặc lỗi cuối; không renumber. CAPTCHA/HTTP/quyền/timeout không được coi là chương rỗng để tự xóa. Audit lưu actor/action/chapter/error code/retry/recover, không token/cookie/body.

## Schema và giới hạn còn mở

Migrations **014–017** thêm state, control/lease epochs, cancel flag, settings, RPC service-only, chapter actions/trash và monitor. Không sửa migration 001–013 đã áp dụng. Migration local lặp kiểm checksum; rollback có dữ liệu dùng backup và forward migration, không xóa file migration.

Chưa nghiệm thu Google API thật, OAuth/role DB cloud, Netlify Function limits, scheduler/billing, website thực tế và load lớn. Giới hạn upload/bìa/cache của các phase trước giữ nguyên. Dead process giữ advisory lock tới khi connection đóng; lease không cho worker khác ghi chồng khi process cũ còn giữ connection. Cần cấu hình DB/network timeouts và giám sát thật ở gate vận hành.

Phase 8 chuyển dữ liệu thật và đối chiếu Fxx/load/backup; Phase 9 phát hành và chuyển single-writer. Chưa gọi hệ mới hoàn tất thay thế Apps Script.
