# Phase 4 — thư viện và đọc truyện local

Phase 4 thay placeholder `/read` bằng thư viện và trình đọc. Tiếp tục làm local trước; Google API, Netlify và database cloud kiểm sau khi đóng code theo quyết định chủ dự án. Độc giả không cần nối Drive cá nhân. UI đọc hoạt động độc lập với worker tải.

## Chạy kiểm thử

Dùng checkout hiện tại, Node 24.19.0, npm 11.9.0 và PostgreSQL local như [Phase 1](../phase-1/README.md).

```bash
npm ci --cache /tmp/book-npm-cache --no-audit --no-fund
npm run db:up
npm run db:migrate
npm run check
npm run test:reader:db
npm run test:reader:browser
```

Ở môi trường cloud hiện tại, dùng Chromium hệ thống:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:reader:browser
```

Máy cá nhân chưa có browser Playwright chạy `npx playwright install chromium`. CI đã thêm reader SQL/browser sau các bộ regression cũ. `test:reader:db` chỉ tạo/xóa database test ở local; không chấp nhận remote database. Browser tests dùng SDK Auth thật, danh tính/API responses synthetic và nội dung tự viết; SQL/API tests dùng PostgreSQL thật local + Drive adapter trên transport mô phỏng. Không có endpoint đăng nhập giả hoặc cờ bỏ xác thực trong sản phẩm.

`npm run dev` và `npm run dev:web` khởi động API/web như trước. Khi chưa có cấu hình Auth thật, đăng nhập vẫn báo chưa cấu hình; không mở thư viện cho khách để thay việc kiểm quyền. Bộ browser local tạo phiên kiểm thử trong môi trường của runner. UI nhập/sửa thư viện và upload bìa triển khai ở Phase 5, không giả thành công ở Phase 4.

## Cách dùng

- Thư viện chỉ hiện sách published/chưa xóa, kể cả tài khoản admin đang ở màn Đọc. Tìm không dấu theo tên/tác giả/thể loại; lưới/bảng; sort tên/tác giả/cập nhật/đọc gần đây; 24 sách mỗi trang. Bìa chữ dùng khi chưa có ảnh hoặc ảnh lỗi; ảnh tải có Bearer token, hiển thị blob riêng, chỉ tải khi gần viewport.
- Chọn Đọc truyện/Đọc tiếp. Mục lục giữ Phần/Quyển, nhóm không phân loại, Hồi, số ghép `1-2`, lời tựa `*` và thứ tự số âm/phân số. Mỗi trang mục lục tối đa 200 chương; có nút sang trang trước/sau để không tải toàn bộ 20.000 chương vào RAM.
- Chương trước/sau; trong chế độ cuộn, ← → đổi chương, PageUp/PageDown cuộn nội dung. Trong chế độ trang, các phím đó lật trang, nút lật/chạm mép/vuốt ngang cũng dùng được; qua trang cuối/đầu có thể sang chương kế/trước. Khi bôi chọn chữ, chạm mép không lật trang.
- Cài đặt đọc: font và hệ số cỡ chữ từ bản cũ, ngày/đêm, lọc ánh sáng xanh, cuộn dọc/lật trang. Phông Literata/Merriweather/Roboto/EB Garamond/Tinos được self-host bằng các subset Latin/Latin-ext/Vietnamese; không gọi CDN Google Fonts. Times New Roman vẫn ưu tiên khi có trên máy. Giữ ratio khi đổi font/cỡ chữ/mode/resize hoặc khi font tải xong. Trợ giúp dùng dialog và Escape.
- Sách rỗng, chương thiếu, dữ liệu đã xóa hoặc API/Drive lỗi có trạng thái rõ và nút thử lại; retry không kẹt vào một lỗi đã lưu trong cache. Nội dung là text React, không render HTML từ truyện.

## Cache và tiến độ riêng

Cụm nội dung có 5 chương, prefetch cụm kế, giữ tối đa 2 cụm và 4.000.000 byte JSON trong cache browser. API giới hạn nội dung mỗi cụm 2.000.000 byte; phần vượt giới hạn trả lỗi riêng, không giả có nội dung. Cache có scope user/book và opaque version tag. Mỗi lần chuyển chương đều lấy metadata mới qua API để kiểm tài khoản/publication/chapter/mapping; tag thay đổi sẽ không dùng nội dung cũ. Đổi sách/thoát reader/logout đổi user hủy request và bỏ cache; response cũ không được gắn vào sách mới. Các giới hạn là payload byte; bộ nhớ heap có thêm overhead UTF-16/DOM, cần đo thiết bị thật ở đợt nghiệm thu.

Progress/preferences dùng `book:user:<UUID>:`. Local debounce 500 ms, progress server khoảng 4 giây; preferences server 500 ms. Có flush best-effort ở visibility/pagehide và khi về thư viện. Request có timeout 10 giây, AbortController và kiểm user sở hữu callback. Lỗi mạng giữ pending để thử lần mở sau. Reload cùng tài khoản đã xác minh giữ dữ liệu pending; logout/đổi user/thu hồi quyền xóa namespace. Nội dung truyện không ghi localStorage.

DB revision và thời gian máy chủ là chuẩn. Pending có revision cũ thì hiện dialog, không tự ghi đè. Chọn vị trí máy chủ bỏ pending, lấy revision mới và không ghi lại vị trí cũ khi chuyển chương; chọn tiếp tục local mới rebase có chủ ý. Tiến độ trên card lấy riêng theo actor; user mới không nhận progress của chủ thư viện. `ReaderPreferences.view` thêm scroll/page, giữ tương thích DTO Phase 2 khi chưa có field này.

## API và database

| Endpoint GET | Vai trò |
|---|---|
| `/api/books?q=&sort=name&offset=0` | Library 24 sách, DTO không có source URL/Drive IDs |
| `/api/books/:bookUUID` | Sách published và progress/index riêng user |
| `/api/books/:bookUUID/chapters?offset=0&limit=200` | Trang mục lục và opaque cache tags |
| `/api/books/:bookUUID/cluster?start=0` | Cụm tối đa 5; start ở bội số 5 |
| Chapter content / cover của Phase 3 | Giữ nguyên API kiểm mapping, quyền và proxy |

Migration `202610080007_reader_library.sql` thêm reader RPC service-only và field view; không sửa migration đã áp dụng. RPC actor lấy từ verified Auth ở máy chủ; browser không gọi RPC với actor tùy ý. Cluster kiểm lại publication sau khi đọc tất cả chương; permission denial hủy cả response thay vì trả dữ liệu riêng một phần. Cache server và Drive bounds của Phase 3 vẫn áp dụng.

## Nghiệm thu sau khi đóng code

Kiểm Google OAuth/Drive, PostgREST/RLS và Netlify thật, hai thiết bị/điện thoại thật, font/CSP/blob cover, thời gian API cluster, mức heap và thư viện lớn. Chưa provision hoặc bật billing. Các fonts đi kèm license ở `apps/web/public/fonts/licenses/`; license font không thay thế license của mã dự án.

Xem [kết quả](REPORT.md), [Phase 3](../phase-3/README.md) và [plan](../../PLAN_WEB_APP.md).
