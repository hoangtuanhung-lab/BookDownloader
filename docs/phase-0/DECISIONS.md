# Phase 0 — Quyết định kiến trúc và thay đổi có chủ ý

Ngày: 08/10/2026. Phạm vi: thiết kế/baseline, không có dịch vụ cloud được tạo. Người dùng đã chọn: **ưu tiên gói miễn phí; chỉ đề xuất nâng cấp sau khi đo tải**.

## ADR-001 — Thư viện dùng chung và ba mục cũ

Giữ Tải sách, Quản lý sách, Đọc truyện và bộ nghiệp vụ V1.59.2. Một thư viện, metadata dùng chung; quyền và dữ liệu đọc theo người. React/TypeScript/Vite trên Netlify, Supabase PostgreSQL/Auth. Tên/ID và Drive file đang có được bảo toàn qua migration.

Lý do: giữ luồng người dùng và tái sử dụng domain/CSS/reader, đồng thời bỏ phụ thuộc runtime Apps Script. Chưa dựng app/DB; các phase tiếp theo phải chứng minh tương đương bằng inventory và golden.

## ADR-002 — Google đăng nhập, read mặc định và bootstrap admin

Google OAuth hỗ trợ Gmail/Workspace. User mới nhận read và tới `/read`; không cấp admin cho tài khoản đầu tiên. Bootstrap owner bằng thao tác server có audit; read/download/manage/admin độc lập, kiểm API và RLS. Reader không cần cấp quyền Drive. User bị khóa phải bị từ chối ngay cả khi session còn hạn.

Publication tách download status. Sách mới/nhập migration private mặc định, manage xuất bản khi đã sẵn sàng. Các ca tài nguyên ẩn, đổi quyền, cache và progress giữa user phải có E2E trước phát hành.

## ADR-003 — Google Drive chỉ giữ file, chủ thư viện cấp quyền riêng

Drive chứa TXT, cover, info/import/removed log. Database là nguồn metadata/job/progress. Không dùng Sheets/Properties làm runtime mới. Chủ thư viện cấp OAuth Drive offline riêng; giữ secrets server-side. Ưu tiên My Drive owner để đọc file cũ; Shared Drive/service account chỉ chọn sau kiểm thực tế.

Scope `drive.file` không tự đủ cho thư viện có sẵn. Access thật, refresh expiry/quota và file quyền ghi phải kiểm ở Phase 3. Phase 0 không yêu cầu credential và không gọi Drive.

## ADR-004 — Worker hữu hạn, queue bền vững, không chạy tải dài trong Netlify request

Job PostgreSQL + lease/checkpoint, FILE và WEB có cap riêng. API nhận việc và trả 202; worker phân tích/tải tiếp khi tab đóng. Worker Node có thể chạy local trong phát triển Phase 1. Deployment đề xuất Cloud Run Jobs/Cloud Scheduler khi quota/billing đã được kiểm chứng; không dùng GitHub Actions làm worker production hoặc giữ toàn bộ tải trong một Netlify Function.

Không biến AUTO_RESUME thành lời hứa process sống mãi: chạy batch hữu hạn, lưu checkpoint và kích hoạt tiếp. Lease/version/outbox giải quyết crash, file tạo trước DB commit và hai worker ghi cùng sách.

## ADR-005 — Free-first, không tự kích hoạt chi phí

Quyết định từ câu trả lời của người dùng: ưu tiên Netlify/Supabase free tiers, test worker local trước. Không tạo tài khoản trả phí, enable billing hoặc mua dịch vụ trong Phase 0. Không xem free tier là cam kết chi phí bằng 0: giới hạn/credit/pause/egress/Drive quota và điều kiện billing thay đổi theo nhà cung cấp.

Trước deployment worker thật cần kiểm điều kiện Cloud Run/Cloud Scheduler, quota miễn phí và việc cần billing account. Ưu tiên nằm trong hạn mức miễn phí; nếu cần billing hoặc nâng gói thì trình phương án và số đo cho chủ dự án trước khi kích hoạt. Không bỏ tính năng tải nền để ép hệ thống vào một gói miễn phí không đáp ứng.

Bảng ngân sách ban đầu (chưa phải báo giá):

| Thành phần | Chính sách | Cần đo/kiểm trước nâng cấp |
|---|---|---|
| Netlify web/API | Free tier khi đáp ứng | Build/deploy credits, request/compute, response/payload size, bandwidth |
| Supabase Auth/PostgreSQL | Free tier khi đáp ứng | DB/storage, auth users, egress, connection và inactivity policy |
| Worker | Local cho phát triển; free allowance cloud nếu đủ điều kiện | CPU/RAM/thời gian active, job executions, lịch điều phối, image/log storage và billing prerequisite |
| Google Drive | Dùng kho owner đang có | Dung lượng, API requests/quota, nội dung đọc và cache hiệu quả |

Giới hạn đang dùng phải ghi lại ở Phase 1/3/8 theo ngày kiểm, khu vực và plan. Tài liệu tham khảo để kiểm lại: [Netlify pricing](https://www.netlify.com/pricing/), [Supabase pricing](https://supabase.com/pricing), [Cloud Run pricing](https://cloud.google.com/run/pricing), [Cloud Scheduler pricing](https://cloud.google.com/scheduler/pricing), [Drive limits](https://developers.google.com/workspace/drive/api/guides/limits). Chưa đo load của hệ mới, chưa xác nhận plan/account live.

## ADR-006 — Không mang lỗi bảo mật baseline sang app nhiều người

Ba ca characterization trong golden ghi lại hành vi mã cũ, không phải điều kiện an toàn cho bản mới:

1. `legacy-domain-substring`: `siteRule_` khớp `fiction.test` với `notfiction.test` bằng substring.
2. `legacy-cookie-substring`: `siteCookie_` có cùng vấn đề; giá trị fixture hoàn toàn giả, không có cookie thật.
3. `legacy-cache-before-file-permission`: `readChapterFile_` trả cache hit trước `fileRegistered_`; ca giả lập cho thấy file không đăng ký vẫn nhận cache.

Khi port: khớp exact host hoặc subdomain boundary cho domain/cookie, kiểm quyền sách/file trước cache hit, kiểm lại redirect và SSRF. Các case này phải chuyển thành negative security tests (không match/không đọc) và ghi exception có chủ ý trong báo cáo parity. Không dùng snapshot cũ để ép bản mới giữ lỗi; không sửa baseline trong Phase 0.

## ADR-007 — Source of truth và khác biệt tài liệu

Đối chiếu mã thật V1.59.2 đã tìm các chênh lệch cần lưu ý:

| Mục mô tả cũ/plan web | Mã thật | Quyết định port |
|---|---|---|
| Plan cũ mục Code.gs còn ghi V1.57.0/03-10 | Code.gs là V1.59.2/08-10 | Inventory/version lấy nguồn pinned; chỉ sửa mô tả stale, không đổi code |
| “Chỉ sửa tác giả không chạm Drive” | updateBookInfo_ ghi info.txt sau Sheet | Giữ cập nhật info, dùng outbox/repair; không hứa DB+Drive atomic |
| Số chương được mô tả như 1..N | chNum/mixShift/placeChapter có fractional và có thể số âm | ID mới ổn định, giữ legacy_order và display_number, không ép integer hay renumber |
| File chương tối đa “2 MB” | AC_MAX_FILE_=2000000 byte | Giữ 2.000.000 byte, không đổi thành 2 MiB |
| Hàng phân tích “8800 ký tự” | anaSave_ dùng utf8Len_ và ANA_MAX_BYTES_=8800 | Legacy là byte; job DB mới không phải áp limit Properties nhưng cần giới hạn batch/body |
| Reader cluster “tối đa 40 và giới hạn byte” | Server cap 40; browser cluster 5/2 cụm, chưa có cap response byte | Byte limit là bổ sung bắt buộc trong API mới, chưa có trong baseline |
| “Bỏ 2 dòng đầu” file đọc | stripFileHead_ phân tích đoạn và strict kiểm name/heading cho FOLDER | Giữ nội dung file không khớp header, không cắt mù |
| Hai pipeline FILE/mạng | FOLDER không có nguồn tải và verify không đưa READY | Giữ ngoại lệ FOLDER khi đổi schema/worker |
| Miêu tả số hiệu là số | Số hiệu hỗ trợ `1-2`, `*` và số | DB display_number dạng text, ID/order riêng |

`decode_` dùng `String.fromCharCode` với entity số; xử lý entity ngoài BMP chưa được nâng trong phase này. Case decode ghi output thật; khi cải thiện phải có ca Unicode và ghi quyết định thay đổi, không tự cập nhật golden.

## ADR-008 — Kích thước và migration thật chưa biết

Chưa có export thư viện owner hoặc binding Google live trong phạm vi Phase 0. `realLibrary` trong profile để null, không dùng số synthetic giả làm dữ liệu thật. Có công cụ offline chỉ đọc JSON để thống kê sau khi owner cung cấp export vào đường dẫn ignored `.local-library/`.

Ba workload original synthetic: 14 sách/126 chương đại diện WEB/FILE/FOLDER và mọi trạng thái sách; 100 sách/20.000 chương để thiết kế phân trang; 1 sách/20.000 chương cho đầu lớn của manual analyze. Đây là dữ liệu metadata giả lập, không phải load test Netlify/Drive/database.

Mặc định ban đầu: trang thư viện 24 sách (mới, sẽ đo), đọc cluster 5 giữ 2 cụm, download batch 5 và cap 2 mỗi pipeline (theo baseline). Các file metadata synthetic nhỏ chưa đại diện kích thước TXT/ảnh thật; kiểm riêng thêm chương giới hạn 2.000.000 byte, paste 300.000 ký tự, cover đề xuất 5 MB/1.200px ở Phase 5 và cold/warm transfer ở Phase 8. Chưa có max file toàn sách được xác minh; không tự áp limit 2 MB cho import cả truyện.
