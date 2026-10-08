# Phase 5 — Quản lý sách và nhập truyện (local)

Web `2.0.0-phase.6`, baseline Apps Script V1.59.2 giữ nguyên. Làm local trước; chưa triển khai hay kiểm dịch vụ cloud. [Bằng chứng](REPORT.md), [plan](../../PLAN_WEB_APP.md).

## Cách chạy và kiểm tra

Node 24 / npm 11.9.0 và Docker/PostgreSQL như [setup Phase 1](../phase-1/README.md):

```sh
npm ci
npm run db:up
npm run db:migrate
npm run worker:check
npm run check
npm run test:management:db
npx playwright install chromium
npm run test:management:browser
```

`test:management:db` tạo database local riêng, chạy migration và API bằng danh tính synthetic, dùng adapter Drive trong bộ nhớ, thực hiện executor rồi xóa database thử. Không cần Google API hay Netlify. Browser E2E dùng phiên đăng nhập/API fixture, không giả lập đăng nhập thành tài khoản thật. Dùng `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium` khi Chromium hệ thống đã có.

Mở UI qua `npm run dev` và `npm run dev:web` sau khi có cấu hình auth hợp lệ; hiện không bật đường đăng nhập giả cho ứng dụng. Khi chưa cấu hình OAuth, các kiểm thử fixture là cách kiểm chứng luồng local. Không đặt khóa dịch vụ trong `VITE_*`.

## Quản lý sách

- `/manage` yêu cầu quyền manage; lưới mặc định, bảng, tìm không dấu theo tên/tác giả/thể loại, sắp tên/tác giả/cập nhật và 24 truyện/trang.
- Sửa tên, tác giả, danh sách thể loại có thứ tự, xuất bản/ẩn và bìa thành bản nháp trong bộ nhớ của phiên giao diện. Không lưu bản nháp metadata vào database hoặc copy sang tài khoản khác. Đóng editor giữ nháp; **Lưu tất cả** ghi từng lô tối đa 24. Mục lỗi giữ lại; sửa tiếp trong lúc lưu được giữ và cập nhật revision.
- Tên được làm sạch theo `cleanName_`, kiểm duy nhất bằng chuẩn hóa không dấu. Thể loại đầu là thể loại chính. Bỏ danh mục vẫn giữ thể loại đã gắn vào sách; có nhập lại danh mục từ sách.
- Lưu xong metadata có thể chờ Drive; thẻ hiển thị đồng bộ pending/error/synced và có nút thử lại. Reader không thấy sách ẩn. Tài khoản manage có thể xem bìa sách ẩn qua endpoint riêng mà không cần quyền read.
- Danh sách chương 200/trang, giữ Phần/Quyển/số hiệu, sửa tiêu đề/URL, retry/pause/cancel/delete. Xóa chương lỗi ghi `_Chương lỗi đã xóa.txt` gồm thời điểm riêng, nhóm, số hiệu, URL và lý do; xóa chương thường không ghi nhật ký lỗi, không đánh lại số.
- Thêm chương link/file/dán: bắt buộc thứ tự, chọn nhóm hiện có hoặc xác nhận tạo nhóm mới; cấm trùng thứ tự/URL. FILE không thêm link. Dán tối đa 300000 ký tự; file chương 2 MB; nội dung chủ động thêm ngắn vẫn được nhận. Link chỉ được đăng ký PENDING, tải nội dung website thuộc Phase 7.
- Xóa sách có hộp xác nhận và lựa chọn trash thư mục; dọn tiến độ và hủy việc đang chờ. Worker khóa hàng sách trong lúc ghi, kiểm lại sách còn sống và quyền actor.
- Bản nháp có cảnh báo rời trang (sidebar, Back, beforeunload); nội dung chương chưa gửi có xác nhận trước khi đóng/hủy. Logout/đổi tài khoản hủy request và bỏ UI cũ.

## Nhập file và thư mục

Một file TXT/MD/Markdown/CSV giữ parser legacy cho Chương/Hồi tiếng Việt và lời tựa. Cặp mục lục + truyện giữ marker `#@`, `##@`, `###@`, `@`, `00`, quy tắc ghép theo vị trí khi hai danh sách bằng độ dài nhưng số hiệu khác; số missing/extra được báo đúng thuật toán baseline. Chương thừa vẫn được nhận theo baseline, không tự bỏ.

Upload qua phiên thuộc actor, chunk **256 KiB**, kiểm kích thước/chỉ số/checksum nội dung khi retry. File import tối đa **64 MiB** (giới hạn vận hành mới), tối đa 8 phiên chưa tiêu thụ/actor, TTL **24 giờ**. Chunk JSON <360000 byte, không đẩy cả file qua một Netlify Function. File nhập tạm nằm trong database riêng tư có TTL; executor tạo `_import.json` trên Drive và checkpoint từng chương. Đây là staging tạm thời, không dùng database làm nơi giữ TXT lâu dài.

Nhập thư mục chỉ nhận thư mục con trong root được cấu hình, phải có quyền ghi và mỗi folder chỉ thuộc một truyện. Không copy/tải lại file chương. Bỏ info/import/removed-log/ảnh và file không có số; báo skipped. Tên trống dùng tên folder. Mọi truyện mới đều ẩn và có `info.txt` đúng bốn mục; link gốc rỗng với FILE/FOLDER.

## Ảnh bìa và đồng bộ Drive

JPEG/PNG/WebP tối đa 5 MB đầu vào. Server kiểm magic bytes, giải mã bằng sharp **0.35.5**, giới hạn 20 triệu pixel, xoay orientation, bỏ metadata, resize cạnh dài tối đa 1200, xuất WebP. Preview dùng Blob URL có bearer và được thu hồi; ảnh upload lỗi không thay ảnh đang dùng.

Bìa mới là staging asset thuộc actor. Lưu tất cả mới gắn vào sách và enqueue COVER. Hủy nháp không đổi bìa hiện tại; worker dọn asset không dùng sau TTL 24 giờ. Sau khi đồng bộ thành công, bytes staging đã dùng cũng được dọn sau 24 giờ khi không còn operation chờ. Chỉ xóa cover cũ có ownership matching, không xóa file tùy ý. Chưa có ảnh dùng bìa chữ; thay/xóa cập nhật version và reader kiểm lại mapping sau IO. Bốn mục `info.txt` không thêm ảnh bìa.

BOOK_SYNC/COVER/TRASH nằm trong outbox, retry hữu hạn, có trạng thái lỗi và retry UI; tìm lại file theo tên khi tạo file xong nhưng transaction chưa commit. Outbox cover cũ không ghi đè cover mới. Transaction DB không rollback được Google Drive; đây là lý do giữ ID/version/checkpoint và kiểm replay.

## API và executor

API phía server kiểm token, account active, origin, quyền và schema trước service-only RPC:

| Endpoint | Quyền / hành vi |
|---|---|
| GET/PUT `/api/manage/books` | manage; danh sách / save batch partial |
| DELETE `/api/manage/books/:id` | manage; revision + trash option |
| GET/POST `/api/manage/books/:id/chapters` | manage; metadata / enqueue add |
| PUT `/api/manage/books/:id/chapters/:chapter` | manage; action + revision |
| GET `/api/manage/books/:id/cover` | manage; bìa proxy, có kiểm sau IO |
| POST `/api/manage/books/:id/sync-retry` | manage; retry outbox |
| GET/POST/DELETE `/api/manage/genres[/id]` | manage; danh mục |
| POST `/api/manage/genres/import` | manage; lấy danh mục từ sách |
| POST `/api/manage/uploads` | manage; tạo phiên upload |
| PUT/DELETE `/api/manage/uploads/:id` | manage + owner; chunk / cancel |
| POST `/api/manage/uploads/:id/complete` | manage + owner; finalize |
| POST `/api/manage/uploads/:id/cover` | manage + owner; decode/stage |
| GET `/api/manage/assets/:id` | manage + owner; preview |
| POST `/api/manage/imports` | manage; trả 202 + jobId |
| GET `/api/manage/jobs`, POST `/:id/retry` | manage + actor; trạng thái / retry |

`npm run worker` chạy hữu hạn khi có DATABASE_URL và cấu hình Drive owner phía server; `npm run worker:check` chỉ kiểm schema, không claim việc và không cần Google credentials. CLI mặc định ngân sách 45 giây để nhận/chạy chương mới, 10 chương mỗi lượt import; IO đang chạy có timeout/request budget riêng của adapter, nên đây không phải deadline cưỡng bức tiến trình; job/lease/outbox được lưu PostgreSQL. Lock chung đảm bảo phân tích tuần tự và writer không chạy chồng trong executor tối thiểu này. FILE/WEB cap riêng, scheduler và tải WEB đầy đủ để Phase 7.

Worker SQL dùng kết nối máy chủ có quyền đọc schema private và sửa bảng nghiệp vụ, không phải khóa/browser role. Giữ quyền DB này phía server; cấu hình role tối thiểu và TLS cloud được nghiệm thu sau khi đóng code. Không dùng local migration CLI để tự chạy database cloud. Kiểm root/scopes/Drive thật, upload qua Function cloud và quota database staging vẫn còn mở.
