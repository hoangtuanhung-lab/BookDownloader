# Phân tích và tải nền trên Netlify — web 2.0.0-phase.9.2

## Lỗi và thay đổi

URL đã vào PostgreSQL nhưng không rời trạng thái Chờ phân tích vì bản Netlify trước chỉ có API/web, không có worker nhận việc. Không phải chỉ thiếu một nút: trước đó cần một tiến trình worker riêng.

Bản này bổ sung phương án Netlify cho staging. API lưu tác vụ trước rồi gọi Background Function; nếu gọi thất bại, tác vụ vẫn còn để thử lại. Dòng queued có nút **Phân tích** gọi worker, không retry/reset checkpoint hay thêm URL lần nữa. Cấu hình thiếu hiện ở bảng; lỗi thao tác không bị lần polling kế tiếp xóa mất.

Background Function dùng executor hiện có (WEB/FILE/import/outbox), mỗi lượt hữu hạn 45 giây, checkpoint và lease cũ. Scheduled Function gọi tiếp mỗi 5 phút ở published deploy, chỉ khi bật worker. Không polling từ trình duyệt để xử lý công việc. Giữ trạng thái ANALYZED chờ người dùng chuyển xuống tải; giữ info.txt gồm Tên truyện, Tác giả, Thể loại, link gốc.

## Thiết lập bằng dashboard, không cần chạy máy tính

Giữ bốn biến Drive và khóa máy chủ Supabase đã có. Trong Netlify → Environment variables, thêm ba biến áp dụng **Functions / Production** (Production là context của published site, dù đây là thư viện thử):

| Biến | Giá trị |
|---|---|
| `DATABASE_URL` | URI PostgreSQL của **Supabase Connect → Session pooler**, thay mật khẩu thật; mã hóa URL các ký tự đặc biệt trong mật khẩu |
| `DRIVE_OWNER_SUBJECT` | Google `sub` của đúng tài khoản đã cấp refresh token Drive |
| `NETLIFY_WORKER_ENABLED` | `true` |

Netlify tự cấp `URL` là URL site; không lấy URL worker từ dữ liệu do browser gửi. Không dùng transaction pooler: worker giữ advisory lock qua nhiều transaction. Không dùng Supabase Project URL hoặc service-role key thay URI/mật khẩu PostgreSQL.

Nếu chủ Drive đã đăng nhập Google vào ứng dụng bằng cùng tài khoản, lấy `sub` bằng câu đọc này trong Supabase SQL Editor (thay email nếu cấp Drive bằng tài khoản khác):

```sql
select i.identity_data->>'sub' as google_sub
from auth.identities i
join auth.users u on u.id = i.user_id
where i.provider = 'google'
  and u.email = 'hoangtuanhung@gmail.com';
```

Nếu không có kết quả, cần xác minh định danh Google của tài khoản cấp token trước; không tự dùng UUID Supabase thay Google sub. Secret nhập trực tiếp dashboard, không chat/GitHub. Không thêm tiền tố `VITE_`.

Redeploy từ main. Kiểm Functions có `api`, `library-worker-background`, `library-worker-schedule`; kiểm khả năng dùng Background/Scheduled Functions và hạn mức theo gói Netlify thực tế trước bật. Không tự nâng gói hay billing. Với token Drive khi OAuth còn Testing, tiếp tục lưu ý khả năng hết hạn sau 7 ngày.

Nếu chế độ bảo trì đang bật, worker không xử lý. Nếu DB đã đăng ký root, worker ưu tiên root DB hơn biến môi trường; đổi root qua Quản trị → Vận hành theo receipt/maintenance, không sửa DB tùy ý. Root do chủ dự án chọn: `1gQJT3X917z72F1weR1pNzGPeQm4vqvqm`.

Mở Tải sách → bấm **Phân tích** ở URL đang chờ hoặc thêm URL mới. Theo dõi chuyển trạng thái, thông tin sách và thư mục/info.txt. Dùng Functions logs: `library_worker` kèm processed/busy/maintenance hoặc `library_worker_unavailable` / `library_worker_schedule_unavailable`. Không ghi exception gốc, tokens hoặc URI database vào logs.

## Quyền và giới hạn

- API worker kiểm Google session, quyền download và Origin cho POST. Background entry chỉ chấp nhận POST với khóa máy chủ; endpoint công khai không được claim việc. Scheduled wake dùng xác thực máy chủ.
- Một session advisory lock toàn cục ngăn các Background Functions Netlify chồng nhau. Executor vẫn kiểm quyền actor, lease epoch, khóa theo sách, maintenance và root binding. Worker Cloud Run/local tiếp tục được hỗ trợ; tránh bật đồng thời các scheduler khi chưa đo tải.
- Đây là lựa chọn triển khai bổ sung của Phase 10 cho staging, thay yêu cầu phải chạy worker trên máy tính. Cloud Run Jobs vẫn là phương án trong kế hoạch ban đầu. Không đổi 23 migrations hay dữ liệu baseline GAS.
- Lịch 5 phút có khoảng chờ giữa các lượt; invocation/compute tiêu thụ quota/credits Netlify, chưa đo trên site thật. Có thể tắt xử lý bằng `NETLIFY_WORKER_ENABLED=false`; lịch vẫn tồn tại nhưng không gọi Background Function. Không hứa miễn phí toàn bộ.

## Bằng chứng local — 09/10/2026

- 200/200 unit/API (7 regressions mới): thiếu bindings, authenticated launcher, non-202/network failure, background deny, enqueue-before-wake, permission/origin/manual không requeue, singleton/maintenance/cleanup.
- 15/15 Chromium quản lý/phân tích, gồm nút đúng cột và lỗi vẫn hiện qua polling mà URL còn nguyên.
- 22/22 PostgreSQL download/API/executor: Drive fixture, info/checkpoint/retry/fencing/permission/maintenance liên quan.
- Một kiểm PostgreSQL thật local: hai lượt Netlify cạnh tranh, lượt thứ hai busy; unlock xong chạy tiếp được, không Drive IO.
- Typecheck/build/bundle đạt; build/release candidate gồm cả hai Netlify functions mới và checksum.

Chưa xác minh deployment hoặc Google/Netlify/Supabase thật từ workspace: thiếu credentials cloud. Kết quả local không chứng minh URL truyenfull.live đã phân tích được; website nguồn có thể từ chối hoặc yêu cầu cấu hình parser/cookie riêng.
