# Kết quả Phase 2 — 08/10/2026

**Đã triển khai và kiểm chứng phần local. Google OAuth staging chưa nghiệm thu.** Người dùng xác nhận chưa có URL Supabase/Netlify và chọn hoàn tất local trước. Không provision cloud hoặc bật billing. Web phiên bản **2.0.0-phase.2**; 29 source Apps Script và bộ info.txt baseline giữ nguyên V1.59.2.

## Đã triển khai

- Google login bằng Supabase SDK với PKCE, callback cố định; query được xóa, bỏ qua next/return URL, default `/read`, exchange một lần trong StrictMode, auto-refresh/logout.
- Profile/read tạo một lần từ Auth trigger; login không khôi phục quyền đã thu hồi. Bootstrap owner UUID từ CLI server một lần, Google identity đã xác nhận và active; không tự nâng quyền cho first signup.
- API xác thực qua Supabase Auth trước khi đọc signed claims, kiểm expiry/issuer/audience/sub/role; RPC kiểm session còn tồn tại. Account blocked/permissions được kiểm lại mỗi request, không cache quyền trong server.
- Menu/routes theo quyền độc lập read/download/manage; admin có tất cả quyền. Trang quản trị phân trang 50 accounts, cấp/thu hồi quyền, khóa tài khoản, audit transaction, bảo vệ admin cuối cùng kể cả hai mutations đồng thời.
- APIs preferences/progress chỉ lấy actor từ token, strict DTO không nhận user ID client. Progress kiểm publication/chapter, expectedRevision và server time; không cho browser ghi trực tiếp để bỏ qua conflict checks.
- Đổi user/logout/thu hồi quyền hủy requests, xóa namespace riêng, chống response cũ và token refresh cũ phục hồi UI sau logout. SDK auth events được defer để tránh khóa auth callback; UI cập nhật quyền khi focus hoặc 30 giây.
- Thêm migrations 003–005, local Auth users/sessions stand-ins, schemas/DTOs, CI auth SQL/concurrency/browser, hướng dẫn staging từng bước. Các runner local từ chối remote database; sản phẩm không có fake-login endpoint hoặc flag bỏ xác thực.

## Kiểm chứng thực thi

| Kiểm tra | Kết quả |
|---|---|
| Legacy baseline/golden/info | **98/98** đạt, source hashes giữ nguyên |
| Domain/contracts/API/auth transport unit | **94/94** đạt (73 cũ + 21 auth/permission/transport) |
| PostgreSQL RLS/constraints | **29/29** đạt, cập nhật expectation cho server-only writes |
| Auth SQL + API kết nối PostgreSQL thật | **17/17** đạt, seed transaction rollback |
| Concurrent admin mutations | **1/1** đạt; xác nhận advisory lock chặn request thứ hai, còn một admin active; DB test riêng đã xóa |
| Guest/UI shell browser | **5/5** đạt trên Chromium hệ thống |
| Auth/admin/session browser | **12/12** đạt trên SDK thật với responses synthetic |
| Typecheck/build/bundle | Đạt; service role sentinel không xuất hiện trong browser assets |
| Docker worker rebuild/run | Build và readiness exit 0; vẫn skeleton Phase 1, chưa nhận jobs |
| npm audit | 0 vulnerabilities tại lần kiểm |
| Clone sạch + database mới | `npm ci`, `npm run check`, các bộ SQL/concurrency/browser và kiểm bundle đều đạt; tổng 256/256, working tree sạch |

Tổng **256/256** kiểm tra tự động đạt, không skip. N01/N02 và foundation N04 có bằng chứng local; nội dung đọc, Drive cache/drafts thực tế cần tích hợp ở Phase 3–5. Test mới không sửa expected goldens/source legacy để làm cho port đạt.

Browser tests kiểm callback PKCE exchange một lần, default reader/no Drive setup, URL/menu theo quyền, admin DTO, logout/storage, blocked, OAuth URL/scopes, callback lỗi, refresh, revoke admin và response cũ sau đổi user. Các JWT/session và endpoint OAuth trong tests là synthetic; không coi là chứng minh Google/Supabase staging hoạt động thật.

Auth transport tests kiểm gọi `/auth/v1/user`, service-only RPC, invalid/expired JWT claims, unconfirmed/non-Google identity, session đã thu hồi, lỗi mạng và không lộ raw error/key. Chữ ký JWT thực tế được giao cho Supabase Auth kiểm; kiểm signed token và Auth sessions trên dịch vụ thật còn ở gate staging.

## Phần chưa nghiệm thu

- Chưa có Supabase/Netlify staging và Google OAuth client; chưa đăng nhập Google thật hoặc kiểm PostgREST/JWT/session revocation trên Supabase thật. Người dùng chủ động để sau local. Hướng dẫn cấu hình đầy đủ ở [README](README.md).
- Reader hiện tới `/read` và kiểm quyền; chưa đọc nội dung thật. Quản lý/tải sách vẫn placeholder Phase 5–7, không báo thành công giả.
- Không có Drive OAuth/token trong luồng login; chưa tạo ảnh bìa, worker business handlers hoặc migration thư viện thật.
- CI đã cập nhật nhưng chưa xác nhận remote Actions/Netlify preview chạy. Chưa publish lại môi trường cloud.
- Thử lưu `start_skill` mới hai lần bị backend trả `INVALID_ARGUMENT`. Đọc lại draft thấy revision 1 vẫn là hướng dẫn Phase 1, chưa có Phase 2; hướng dẫn Phase 2 đã lưu trong repo. Install script Phase 1 vẫn dùng npm ci/check và phù hợp dependency lockfile mới. Draft cloud chưa cập nhật thành công.

Các giới hạn source/gate khác của Phase 0–1 tiếp tục áp dụng. Không đánh dấu toàn bộ Phase 2 hoàn tất staging bằng kết quả mock/local.
