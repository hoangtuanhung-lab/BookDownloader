# Phase 2 — Google đăng nhập và phân quyền

Web **2.0.0-phase.2** có luồng Google OAuth/PKCE, session refresh/logout, menu/routes theo quyền và trang quản trị tài khoản. Google OAuth thật ở staging **chưa kiểm chứng** do thiếu project/site/credentials. Xem [báo cáo](REPORT.md).

## Quyền và API

Tài khoản mới có `read` một lần qua trigger Auth. Lần đăng nhập sau không cấp lại quyền đã bị thu hồi. Không tự cấp admin cho người đăng nhập đầu tiên. `read`, `download`, `manage` độc lập; `admin` có toàn bộ quyền. Người đăng nhập tới `/read`, không cần OAuth Drive; nội dung thư viện thật nằm ở Phase 3–4.

| API | Quyền/hoạt động |
|---|---|
| `GET /api/me` | Xác thực session và tài khoản active, trả ID/name/permissions từ DB |
| `GET /api/admin/users?after=UUID` | admin, 50 tài khoản/trang |
| `PUT /api/admin/users/:id` | admin, permissions + status, transaction/audit; giữ ít nhất một admin active |
| `GET/PUT /api/me/preferences` | read, chính người trong token; không nhận user ID từ client |
| `GET/PUT /api/me/progress/:bookId` | read và publication; chapter thuộc sách/DONE; expectedRevision, server timestamp |
| API sách/tải/Drive chưa triển khai | Kiểm đăng nhập/quyền rồi trả 501; chưa thao tác nội dung |

API dùng `Authorization: Bearer ...`; mutations JSON tối đa 8 KB và Origin khớp chính xác `APP_ORIGINS`. Không dùng cookie để xác thực API. Server gọi Supabase Auth để kiểm signed token trước khi đọc claims, kiểm expiry/issuer/audience/role/sub và session còn tồn tại; sau đó kiểm account/permissions mới nhất trong DB. Browser không gọi RPC nhận actor UUID và không có service role.

## Chạy kiểm tra local

Tiếp tục dùng setup Phase 1, Node 24.19.0/npm 11.9.0:

```bash
npm ci
npm run db:up
npm run db:migrate
npm run check
npm run test:db
npm run test:auth:db
npm run test:auth:concurrency
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:browser
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:auth:browser
npm run test:bundle
```

Trên máy chưa có Chromium, cài `npx playwright install --with-deps chromium` và bỏ biến executable. Tests browser Phase 2 dùng SDK Supabase thật với responses/sessions synthetic, không đăng nhập Google thật. SQL/API tests thực thi PostgreSQL thật, tạo users/sessions synthetic trong transaction rồi rollback. Concurrency test tạo database local riêng, kiểm hai request đồng thời bỏ quyền admin rồi xóa database test. Không có nút đăng nhập test, fake token hoặc quyền test trong runtime sản phẩm.

Các migration Phase 2 là `202610080003`–`005`, sau hai migration Phase 1. SQL runners chỉ chạy local; `local-auth*.sql` chỉ mô phỏng schema Auth tại local, **không chạy trên Supabase**. DB chỉ đọc bằng RLS từ browser; ghi progress/preferences chuyển qua server RPC để bảo vệ revision và timestamp. Các Phase 1 tests tương ứng đã cập nhật cho quy tắc ghi mới, baseline Apps Script vẫn nguyên trạng.

## Thiết lập Google OAuth thật — staging miễn phí

1. Dùng Supabase project staging riêng. Trong SQL Editor, áp dụng migrations **001 → 005** theo thứ tự; chỉ áp dụng các file chưa có, không chạy lại tùy ý. Mỗi file có transaction. Không chạy các file `tools/dev/local-auth*.sql` lên cloud.
2. Trong Google Cloud Console, cấu hình OAuth consent screen và tạo OAuth client loại Web application. Nếu consent đang Testing, thêm các tài khoản thử nghiệm. Authorized redirect URI của Google là **`https://PROJECT_REF.supabase.co/auth/v1/callback`** (callback Supabase, khác callback web ở bước 4).
3. Trong Supabase Authentication → Providers → Google, bật Google và nhập Client ID/Client Secret ở dashboard. Chỉ bật các phương thức đăng nhập dự kiến (Google); web không cung cấp email/password. Không đặt Google Client Secret vào repo hoặc frontend.
4. Trong Supabase Authentication → URL Configuration, đặt Site URL là URL staging Netlify. Thêm redirect URL **chính xác**: `https://STAGING_HOST/auth/callback`, `http://127.0.0.1:5173/auth/callback`, `http://localhost:5173/auth/callback` nếu chạy local. Không dùng wildcard hay `next` URL tùy ý. Dùng URL branch staging cố định để kiểm thử; preview chưa allowlist không có OAuth.
5. Trong Netlify, cấu hình biến **build** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (publishable/anon key của staging). Biến **functions** là `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_ENV=staging`, `APP_ORIGINS=https://STAGING_HOST`. Không đưa service role/Drive tokens/cookie vào `VITE_*`. Hai phía phải dùng cùng project. Context production dùng một project/key riêng.
6. Deploy staging/rebuild web. Kiểm `/api/health`; đăng nhập Google, xác nhận `/read`, profile/read chỉ được tạo một lần, chưa có quyền quản trị. Web chỉ yêu cầu `openid email profile`; OAuth Drive là kết nối khác ở Phase 3.
7. Trong Supabase Authentication → Users, lấy UUID của **tài khoản chủ dự án đã xác nhận Google**. Cấu hình `BOOTSTRAP_ADMIN_USER_ID` trong môi trường server/CLI cùng `SUPABASE_URL` và `SUPABASE_SERVICE_ROLE_KEY`, rồi chạy từ repo:

   ```bash
   npm run bootstrap:admin
   ```

   Bootstrap chỉ chạy một lần cho một owner, có audit. Không có API/nút công khai để tự bootstrap. UUID và khóa nhập qua cấu hình riêng, không commit vào repo. Token cũ được kiểm lại quyền mỗi request; tab web cập nhật khi focus hoặc sau tối đa 30 giây.
8. Vào **Quản trị**, cấp `download`, `manage`, `read` cho các tài khoản thử; thử đọc riêng, tải riêng, quản lý riêng và admin. Gọi trực tiếp API và mở URL thay vì chỉ nhìn menu. Khóa/thu hồi quyền phải có hiệu lực ở API/RLS; không thể khóa hoặc bỏ admin cuối cùng.
9. Kiểm logout, refresh, hai tài khoản/hai tab, session bị thu hồi, token hết hạn và progress riêng user trên Supabase thật. Thực hiện lại nghiệm thu staging trong plan; đến lúc đó Phase 2 mới đạt gate đầy đủ.

Nếu phát triển web local với Supabase staging thật: `.env` dùng `APP_ENV=staging`, URL/keys staging, `APP_ORIGINS=http://127.0.0.1:5173,http://localhost:5173`, rồi chạy API/web như Phase 1. DB health và Auth/RPC sẽ cùng trỏ staging. Các SQL runner local vẫn dùng `DATABASE_URL` local và từ chối remote DB; migration staging dùng SQL Editor/quy trình Supabase. Không dùng khóa production cho local/preview.

## Session và dữ liệu riêng

PKCE callback được exchange một lần kể cả React StrictMode, xóa query khỏi URL; thành công chuyển `/read`, không dùng return URL từ query. SDK tự refresh session. Account và quyền lấy từ API, không lấy user metadata làm quyền. Mất quyền/đổi tài khoản/logout hủy requests cũ và xóa storage `book:user:*`; response cũ không được thay account mới. Logout xóa session local ngay cả khi request sign-out lỗi. JWT giữ lại bị từ chối sau khi Supabase session được thu hồi; nếu sign-out server mất kết nối, token vẫn có thể còn hiệu lực tới khi server thu hồi hoặc hết hạn, nên API luôn kiểm session/account.

Dữ liệu riêng ở các phase sau phải dùng namespace `book:user:<authUuid>:...` và transport hủy request này. Reader cache và drafts của quản lý sách thực tế chưa có ở Phase 2; Phase 4–5 phải nối vào cơ chế đó, không dùng cache dùng chung từ Apps Script.

Google Workspace cũng là Google login được xác nhận; không giới hạn đuôi `@gmail.com`. Source Apps Script V1.59.2 và quy tắc bốn mục info.txt giữ nguyên.
