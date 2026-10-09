# Sửa lỗi lưu quyền — 2.0.0-phase.9.1

Ngày 09/10/2026. Chủ dự án báo health trả `status=ok/database=ok`, đã bootstrap owner và gặp “Không xử lý được yêu cầu” khi lưu quyền trên web. Health/owner là kết quả chủ dự án cung cấp; chưa thu thập response authenticated của lần lỗi từ staging.

Đã tái hiện local bằng transport giống PostgREST: `app_admin_update` trả void và HTTP 204 không body sau khi đã ghi quyền; adapter gọi `response.json()` nên ném SyntaxError, API trả 500 dù quyền đã lưu. Test tái hiện trước sửa nhận 500 thay vì 200.

Adapter RPC nay chấp nhận 204/body rỗng thành `null`, giữ JSON null và JSON thông thường; HTTP thất bại không thành success, malformed JSON và text lỗi không lộ nội dung upstream. Không tự retry mutation. Kiểm session/admin/origin, SQL last-admin guard và transaction giữ nguyên. Cùng xử lý giúp `bootstrap_admin` và RPC void khác. Version manifests/lockfile đồng bộ `2.0.0-phase.9.1`; schema vẫn đến migration 023, không đổi migration đã áp dụng hoặc SQL bootstrap.

Kiểm tra local đã chạy:

- Typecheck, 193/193 unit/API/domain (4 regression mới; transport auth tổng 10/10).
- 17/17 auth SQL/API và 1/1 last-admin concurrency.
- 12/12 auth/admin browser.
- Build web/API/worker và bundle server-secret check đạt.

Các kết quả Phase 9 495/495 giữ nguyên mốc lịch sử; không tuyên bố chạy lại toàn bộ DB/browser/load cho patch này. Regression mô phỏng PostgREST chưa thay kiểm lại thao tác trên Netlify/Supabase thật.

## Kiểm lại trên staging

1. Deploy commit sửa lỗi hoặc mới hơn; `/api/version` cần `version=2.0.0-phase.9.1`, đối chiếu revision với deploy.
2. Tải lại trang admin, bấm Làm mới trước: lần lưu báo lỗi trước đó có thể đã ghi quyền.
3. Sửa quyền cần thiết, Lưu quyền; cần báo “Đã cập nhật tài khoản”. Làm mới/reload vẫn giữ quyền.
4. Nếu còn lỗi, ghi HTTP status, trường error/message/correlationId của response PUT `/api/admin/users/<UID>` trong Network và log function tương ứng. Không gửi Authorization header, cookie, JWT hoặc request token. Có thể còn nguyên nhân cloud khác; không bypass quyền hoặc sửa bảng trực tiếp.

Không cần chạy lại bootstrap hoặc 23 migration để dùng patch này.
