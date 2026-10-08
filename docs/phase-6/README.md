# Phase 6 — Phân tích URL (local)

Web `2.0.0-phase.6`. [Hướng dẫn chạy local](../phase-5/README.md), [bằng chứng](REPORT.md), [plan](../../PLAN_WEB_APP.md). Chưa gọi website thật, Google API hay Netlify trong nghiệm thu này.

## Luồng thao tác

1. Vào **Tải sách** bằng quyền download. Tự động nhận nhiều URL qua `;` hoặc từng dòng. Thủ công cần tên, URL chương mẫu và tổng **1–20000**.
2. Hàng tạm hiện ngay trước response. Đang gửi/phân tích vẫn thêm URL khác; URL sai giữ trong ô, máy chủ từ chối trả URL lại ô. Server chuẩn hóa URL và khử trùng.
3. Server trả 202 + job ID; job tồn tại trong PostgreSQL khi đóng tab. Worker phân tích tuần tự, checkpoint từng trang mục lục và tiếp tục ở lượt sau.
4. Bảng có đúng 8 cột STT / tên / tác giả / thể loại / URL / thư mục / trạng thái / thao tác. URL lỗi giữ nguyên cùng lý do và nút phân tích lại/bỏ. Retry bắt đầu phân tích mới với cấu hình hiện tại; checkpoint phục vụ việc nối lượt tự động.
5. Kết quả được giữ ở **ANALYZED**, tạo folder + info.txt, chưa tải chương và chưa xuất bản. Edit thông tin trên màn này lưu ngay nếu có manage; download đơn lẻ không được sửa metadata/genre. Gán thể loại cả bảng ANALYZED kiểm manage và báo kết quả từng truyện.
6. Phân tích lại giữ ID chương, file và tiến độ; chỉ thêm URL/số chưa có, điều chỉnh thứ tự mixed theo baseline. Worker và database chống trùng nguồn/tên/thứ tự. Sau khi bỏ một URL, thêm lại URL đó tạo lại lượt phân tích, không mất URL trong trạng thái cancelled.

## Parser tái sử dụng

Port async của `discover_`, dùng các hàm pure đã port từ Adapters/Parser/ChapterManager: JSON-LD/meta/itemprop, `SITE_RULES`, dò nội dung, phân trang, mixed Quyển/Chương và số hiệu `1-2`. HTTP được inject, không có UrlFetchApp/Utilities.sleep trong runtime mới. Delay giữa trang có thể hủy và dùng cấu hình DELAY_MS, mặc định 800ms như bản cũ.

Tự động không sinh URL thiếu từ một quan sát. Nếu có ít nhất hai chương, giữ phép chứng minh template bằng URL đã thấy của baseline; slug không khớp thì cảnh báo và không bổ sung. Đây là siết quy tắc để tránh trường hợp một chương sinh hàng nghìn URL. Link nguồn, paging và URL sinh được kiểm máy chủ; link ra ngoài origin hoặc prefix sách bị loại. Giới hạn 300 trang, 20000 chương, HTML mỗi response 2 MB. Không thấy tên/chương hoặc phân trang không xác định được thì báo lỗi; CAPTCHA/Cloudflare challenge được báo không hỗ trợ.

`SITE_RULES` tối đa 2000 ký tự; admin đọc/lưu SITE_RULES, JUNK_WORDS, DELAY_MS qua cấu hình trên màn Tải sách. JUNK_WORDS được đồng bộ tới khóa reader để đổi cấu hình làm đổi cache key. Cookie nguồn chỉ đọc từ biến bí mật `SOURCE_COOKIES_JSON` phía worker, không trả lại UI.

## HTTP và ranh giới

`SourceHttp` chỉ nhận HTTP(S) trên cổng chuẩn, không user/password. Chặn localhost, mạng riêng, metadata, IPv4 reserved/multicast và IPv6 mapped/tunnel/documentation. Kiểm toàn bộ DNS answers; kết nối dùng địa chỉ vừa kiểm qua lookup pinned. Mỗi redirect kiểm lại URL/DNS; không dùng proxy môi trường hay fetch fallback có thể bỏ kiểm. Timeout DNS 5s, request 15s, tối đa 5 redirect, TLS kiểm bình thường.

Cookie chỉ gửi cho hostname/domain boundary khớp, không chuyển sang hostname khác ngoài phạm vi. Preflight các URL sinh tái sử dụng DNS trong một lượt hữu hạn; kết nối HTTP thật luôn kiểm mới. Worker không log cookie/token/HTML thô vào response. Checkpoint HTML/mục lục là dữ liệu tạm service-only, endpoint trạng thái chỉ xuất metadata/error cho người có download.

| Endpoint | Quyền |
|---|---|
| GET/POST `/api/analysis` | download; list / queue |
| POST `/api/analysis/actions` | download; retry/drop |
| PUT `/api/analysis/books` | download + manage; lưu ngay với revision |
| PUT `/api/analysis/genres` | download + manage; bulk partial |
| GET/PUT `/api/settings/analysis` | admin; cấu hình parser |

Chuyển xuống tải, FILE/WEB concurrency, pause/resume job tải WEB, monitor và scheduler thuộc Phase 7. Không mở URL website thật trong local tests và không coi fixture thành kiểm chứng internet; smoke website có quyền truy cập sẽ làm sau đóng code cùng các gate cloud còn mở.
