# BookDownloader — Trình tải truyện

Ứng dụng web tiếng Việt để tải truyện theo chương từ website, nhập truyện có sẵn, quản lý thư viện trên Google Drive và đọc ngay trong trình duyệt. Project chạy trên **Google Apps Script**, dùng **Google Sheets** làm cơ sở dữ liệu và **Google Drive** lưu nội dung.

Mã nguồn ban đầu được nhập từ `TrinhTaiTruyen_V1.59.1.zip`. Phiên bản hiện tại trong `Code.gs`: **1.59.2**, cập nhật **08/10/2026**.

## Web app mới — Phase 9 local

Đã thêm nền **React/TypeScript/Vite + Netlify Functions + PostgreSQL/Supabase + Node worker** bên cạnh ứng dụng Apps Script. Có khung giao diện, domain/contracts, schema/RLS, CI, luồng Google OAuth/PKCE và quản trị phân quyền. Auth/API/SQL/browser đã kiểm thử local; Google OAuth thật còn chờ cấu hình staging. Phase 3 có Drive adapter, API đọc chương/ảnh có kiểm quyền, cache PostgreSQL và migration dry-run; kiểm thử bằng dữ liệu synthetic ở local. Phase 4 có thư viện/reader cuộn và lật trang, mục lục, font/ngày đêm, cache và tiến độ riêng theo user. Phase 5 có quản lý sách, bản nháp/Lưu tất cả, nhập file/cặp marker/thư mục, thêm chương và ảnh bìa. Phase 6 có phân tích URL tự động/thủ công, checkpoint phân trang, hàng chờ bền vững và bảng 8 cột. Phase 7 có worker tải WEB/FILE độc lập trình duyệt, cap riêng, checkpoint/resume/retry, pause/cancel/verify và giám sát tác vụ; scheduler cloud chưa bật. Phase 8 có importer local/checksum, owner progress binding, review gate, verify hash/backup restore và load/parity report. Phase 9 bổ sung bảo trì/root UI-API, reconcile FILE pending/queue/LOG/CONFIG/ngày giờ, delta có review và backup file/DB/restore, release candidate/CI/manual deploy và runbook. Các kiểm thử local đạt; nghiệm thu dịch vụ/thư viện thật và production còn mở. Google Drive sẽ lưu file, database lưu metadata và trạng thái.

Xem [Phase 9 vận hành](docs/phase-9/README.md), [báo cáo Phase 9](docs/phase-9/REPORT.md), [release/rollback và sơ đồ](docs/phase-9/RUNBOOK.md), [Phase 8 local](docs/phase-8/README.md), [báo cáo và phần còn mở](docs/phase-8/REPORT.md), [hướng dẫn Phase 7](docs/phase-7/README.md), [báo cáo Phase 7](docs/phase-7/REPORT.md), [hướng dẫn Phase 5](docs/phase-5/README.md), [báo cáo Phase 5](docs/phase-5/REPORT.md), [hướng dẫn Phase 6](docs/phase-6/README.md), [báo cáo Phase 6](docs/phase-6/REPORT.md), [hướng dẫn Phase 4](docs/phase-4/README.md), [báo cáo Phase 4](docs/phase-4/REPORT.md), [hướng dẫn Phase 3](docs/phase-3/README.md), [báo cáo Phase 3](docs/phase-3/REPORT.md), [setup nền Phase 1](docs/phase-1/README.md), [hướng dẫn Google OAuth/Phase 2](docs/phase-2/README.md), [kết quả kiểm chứng](docs/phase-2/REPORT.md) và [plan triển khai](PLAN_WEB_APP.md). Làm local trước; sau khi đóng code mới kiểm Google API, Netlify và database cloud. Ưu tiên gói miễn phí; chưa provision staging hoặc bật billing. Các hướng dẫn Apps Script bên dưới vẫn áp dụng cho V1.59.2.

Bước tiếp theo: [Phase 10 — kiểm staging sau đóng code](docs/phase-10/README.md). Đã chuẩn bị checklist; chưa có URL/credentials để chạy dịch vụ thật, production vẫn chưa kích hoạt.

## Chức năng chính

- Phân tích một hoặc nhiều URL truyện, lấy tên, tác giả, thể loại và danh sách chương; giữ truyện đã phân tích để người dùng chọn bắt đầu tải.
- Quản lý hàng chờ tải, tải theo từng đợt, tạm dừng, tiếp tục và thử lại chương lỗi. Có trigger chạy nền mỗi phút khi được bật và có tác vụ tải.
- Lưu mỗi chương thành file TXT; tổ chức thư mục theo thể loại, tên truyện và Phần/Quyển khi có.
- Tạo `info.txt` trong thư mục truyện khi thêm từ website, file hoặc thư mục Drive; cập nhật khi sửa thông tin truyện. Truyện cũ được bổ sung file khi tiếp tục tải.
- Nhập truyện từ file văn bản hoặc thư mục Drive có sẵn; thêm chương bằng URL, file hoặc nội dung dán trực tiếp.
- Quản lý tên truyện, tác giả, thể loại; xem thư viện dạng bảng hoặc lưới.
- Đọc truyện theo kiểu cuộn dọc hoặc lật trang, chỉnh phông/cỡ chữ và lưu vị trí đọc.
- Cấu hình vùng nội dung theo website bằng `SITE_RULES`, lọc từ rác và xem nhật ký xử lý.

## Kiến trúc

```text
Trình duyệt (HTML / CSS / JavaScript)
    │ google.script.run
    ▼
Google Apps Script (Code.gs và các module .gs)
    ├── Google Sheets: CONFIG, BOOKS, CHAPTERS, LOG
    ├── Google Drive: thư mục truyện và file chương
    ├── UrlFetchApp: lấy HTML từ website nguồn
    └── Trigger autoTick: xử lý hàng tải nền
```

Đây là ứng dụng dành cho sử dụng cá nhân. Mã nguồn hiện không có hệ thống đăng nhập hoặc phân quyền riêng; dữ liệu chính dùng chung trong project Apps Script.

## Yêu cầu

- Tài khoản Google có quyền dùng Apps Script, Drive và Sheets.
- Trình duyệt hiện đại; kết nối Internet để sử dụng ứng dụng và tải nội dung.
- Quyền truy cập các website nguồn và quyền sử dụng nội dung cần tải.

Không cần Node.js, Python, máy chủ riêng hay database ngoài để chạy ứng dụng. Các file `.gs` sử dụng dịch vụ của Apps Script nên không chạy trực tiếp bằng Node.js. Mở `Index.html` như file HTML thông thường cũng không chạy được ứng dụng vì trang dùng template Apps Script và `google.script.run`.

## Cài đặt trên Google Apps Script

1. Tải repository về máy hoặc clone:

   ```bash
   git clone https://github.com/hoangtuanhung-lab/BookDownloader.git
   cd BookDownloader
   ```

2. Mở [Google Apps Script](https://script.google.com/), tạo một **project mới** độc lập.
3. Chép **tất cả file `.gs` và `.html` ở thư mục gốc** vào project, giữ đúng tên và loại file. Ví dụ: `Code.gs` là file Script tên `Code`, `Index.html` là file HTML tên `Index`. Thay nội dung `Code.gs` mặc định bằng file của project. Không chép các file Markdown vào trình soạn thảo Apps Script.
4. Trong **Project Settings**, chọn runtime **V8** và múi giờ phù hợp, ví dụ `Asia/Ho_Chi_Minh`. Bản ZIP không kèm `appsscript.json`; dùng manifest của project mới và để Apps Script suy ra các OAuth scope từ mã nguồn.
5. Chọn **Deploy → New deployment → Web app**:
   - **Execute as:** Me (thực thi dưới tài khoản của bạn).
   - **Who has access:** Only myself (chỉ mình bạn).
6. Hoàn tất cấp quyền khi Google yêu cầu. Ứng dụng cần dùng Drive, Sheets, gửi yêu cầu HTTP tới website và tạo trigger chạy nền.
7. Mở URL ứng dụng web của deployment. Trong **Cài đặt**, đăng ký thư mục gốc bằng ID/link Drive hoặc tạo thư mục mới bằng tên.

Khi truy cập dữ liệu lần đầu, ứng dụng tự tạo spreadsheet `TRUYEN_DOWNLOADER_DB` với các sheet `CONFIG`, `BOOKS`, `CHAPTERS`, `LOG`; ID được lưu ở Script Property `DB_ID`. Không cần tự tạo hoặc nhập ID spreadsheet khi cài mới.

Khi cập nhật mã nguồn, chép các file thay đổi vào **project hiện có**, rồi vào **Deploy → Manage deployments → Edit → New version → Deploy**. Giữ dữ liệu Drive và Script Properties nếu muốn tiếp tục dùng thư viện cũ.

## Sử dụng nhanh

1. Vào **Tải sách**, dán URL trang truyện; nhiều URL có thể phân cách bằng dấu `;`. Bấm **Phân tích**.
2. Chờ bảng phân tích lấy thông tin và danh sách chương. Sửa thông tin nếu cần, rồi chọn **Chuyển xuống tải** hoặc **Chuyển tất cả xuống tải**.
3. Theo dõi tiến độ và hàng chờ; mở danh sách chương để xử lý các chương lỗi.
4. Vào **Quản lý sách** để tìm truyện, đổi thể loại hoặc thêm truyện từ file/thư mục Drive.
5. Mở **Đọc truyện** hoặc chọn đọc từ thư viện; dùng cài đặt đọc để đổi phông, cỡ chữ và kiểu cuộn/lật trang.

Với file văn bản, định dạng đơn giản cho từng chương là:

```text
Chương 1: Khởi đầu
Nội dung chương thứ nhất...

Chương 2: Hành trình
Nội dung chương thứ hai...
```

Luồng nhập file có nhận TXT, Markdown và CSV. CSV dùng ba cột: số chương, tiêu đề, nội dung. Chức năng thêm một chương từ file nhận TXT/Markdown. Xem [hướng dẫn sử dụng](HUONG_DAN_SU_DUNG.md) và nút **?** trong các hộp thoại để biết định dạng mục lục, định dạng Hồi và tên file chương trong thư mục Drive.

## Cấu hình đáng chú ý

File `info.txt` nằm ở thư mục chính của từng truyện, có định dạng:

```text
##Tên truyện
Tên truyện

##Tác giả
Tên tác giả

##Thể loại
Thể loại của truyện

##link gốc
https://example.com/truyen/
```

Thông tin chưa có được để trống. Truyện nhập từ file hoặc thư mục Drive không có URL nguồn trong dữ liệu hiện tại nên mục `link gốc` để trống. File được cập nhật tại chỗ, không tạo thêm bản mỗi đợt tải và không được tính là một chương khi nhập thư mục.

| Khóa | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `ROOT_FOLDER` | `TRUYEN_DOWNLOADER` | Tên thư mục gốc mặc định |
| `ROOT_FOLDER_ID` | Trống | ID thư mục gốc; đăng ký qua giao diện |
| `BATCH_SIZE` | `5` | Số chương xử lý mỗi đợt cho một truyện |
| `DELAY_MS` | `800` | Khoảng nghỉ giữa các lần tải, tính bằng mili giây |
| `MAX_RETRY` | `3` | Giới hạn thử lại yêu cầu lấy nội dung |
| `MAX_CONCURRENT` | `2` | Số truyện được đưa vào trạng thái tải; mã giới hạn từ 1 đến 10 |
| `AUTO_RESUME` | `TRUE` | Cho phép tạo trigger để tiếp tục tải nền |
| `JUNK_WORDS` | Danh sách trong `Config.gs` | Các từ/cụm từ cần lọc khỏi nội dung |
| `SITE_RULES` | Trống | Quy tắc nhận diện nội dung, tiêu đề và link theo website |
| `SITE_COOKIES` | Trống | Cookie theo website khi cần xác thực |

Ví dụ `SITE_RULES`:

```text
example.com: content=reading-content; title=chapter-title; link=/chuong-
```

`content` và `title` là tên class hoặc ID, không phải CSS selector tùy ý. Nhiều website phân cách bằng `|` hoặc xuống dòng. Cấu hình mẫu không phải cam kết hỗ trợ một website cụ thể.

Đầu ra tải từ website hiện là TXT UTF-8. Dù `Config.gs` có khóa `FILE_TYPE` và `ENCODING`, không nên hiểu các khóa đó là tính năng xuất EPUB/PDF hay hỗ trợ mọi bảng mã.

Cookie đăng nhập là thông tin nhạy cảm: chỉ nhập trong môi trường cá nhân, không commit lên GitHub. Cookie được cấu hình trong dữ liệu `CONFIG`; không chia sẻ spreadsheet dữ liệu hoặc triển khai ứng dụng công khai.

## Cấu trúc mã nguồn

| File/nhóm file | Vai trò |
| --- | --- |
| `Code.gs` | `doGet`, phiên bản và các API gọi từ giao diện |
| `Config.gs`, `Database.gs` | Giá trị mặc định, schema và truy cập Sheets |
| `BookManager.gs`, `ChapterManager.gs`, `ChapterTools.gs` | Quản lý truyện, chương và thao tác thủ công |
| `AnalyzeQueue.gs` | Hàng chờ phân tích URL và trạng thái phân tích lỗi |
| `Downloader.gs`, `Scheduler.gs` | Tải theo đợt, thử lại và trigger chạy nền |
| `Parser.gs`, `Adapters.gs`, `Cleaner.gs` | Trích xuất HTML, quy tắc website và làm sạch nội dung |
| `Importer.gs` | Nhập truyện từ file và thư mục |
| `DriveManager.gs`, `ReaderData.gs` | Thư mục/file Drive, dữ liệu đọc và lưu tiến độ |
| `Utils.gs`, `Logger.gs`, `Favicon.gs` | Hàm dùng chung, nhật ký và favicon |
| `Index.html`, `Sidebar.html`, `Dashboard.html`, `Manager.html`, `Reader.html`, `Modals.html` | Template và các màn hình giao diện |
| `CSS.html`, `ReaderCSS.html` | Giao diện và kiểu hiển thị đọc truyện |
| `JS.html`, `ManagerJS.html`, `ReaderJS.html` | Logic giao diện phía trình duyệt |
| `HUONG_DAN_SU_DUNG.md` | Hướng dẫn người dùng từ bản nguồn |
| `plan_TrinhTaiTruyen.md` | Mô tả, lịch sử phát triển và ghi nhận kiểm thử từ bản nguồn |

## Kiểm thử và giới hạn

Bản nguồn không kèm bộ test tự động độc lập, cấu hình CI hoặc cấu hình `clasp`. Các kết quả ghi trong `plan_TrinhTaiTruyen.md` là lịch sử của bản nguồn, không chứng minh deployment mới hoạt động.

Repository hiện có 10 kiểm thử cho `info.txt`, chạy bằng Node.js (chỉ cần cho kiểm thử phát triển):

```bash
node --test tests/book-info.test.js
```

Các kiểm thử dùng dịch vụ Google giả lập để kiểm tra tạo/cập nhật file, các luồng thêm truyện và tải tiếp, bỏ qua file thông tin khi nhập chương, cùng lỗi ghi Drive. Chúng không thay thế kiểm tra với Drive/Sheets thật.

Sau khi triển khai trên Apps Script, kiểm tra ít nhất:

1. Trang mở được, tải trạng thái thành công và spreadsheet dữ liệu được tạo.
2. Tạo/đăng ký thư mục Drive thành công.
3. Phân tích một truyện từ website bạn có quyền truy cập; đối chiếu tên và danh sách chương.
4. Tải một số chương, kiểm tra nội dung TXT trong Drive và trạng thái trong giao diện.
5. Mở trình đọc, đổi chương, tải lại trang để kiểm tra khôi phục vị trí đọc.
6. Nếu dùng tải nền, kiểm tra trigger `autoTick` và lịch sử **Executions** khi đóng trang.

Apps Script chịu hạn mức thời gian thực thi, số lần gọi UrlFetch, trigger, dung lượng Properties/Cache và hạn mức Drive/Sheets. Website thay đổi HTML, yêu cầu JavaScript, CAPTCHA hoặc chặn truy cập tự động có thể làm phân tích/tải thất bại. Không bảo đảm hỗ trợ mọi website; dùng `SITE_RULES` khi cấu trúc HTML phù hợp.

Mã có cơ chế loại bỏ một số chương lỗi nội dung rỗng/quá ngắn, có ghi nhật ký. Khi thiếu chương, xem sheet `LOG` và file `_Chương lỗi đã xóa.txt` trong thư mục truyện trước khi thêm lại. Truyện nhập từ file có thể cần `_import.json` khi chưa xử lý xong; không xóa file này giữa lượt nhập.

## Tài liệu và giấy phép

- [Hướng dẫn sử dụng chi tiết](HUONG_DAN_SU_DUNG.md)
- [Mô tả và lịch sử phát triển của bản nguồn](plan_TrinhTaiTruyen.md)
- [Kế hoạch chuyển sang web app Netlify: 10 phase, giữ tính năng cũ và bổ sung đăng nhập/phân quyền/ảnh bìa](PLAN_WEB_APP.md) — Phase 0 có baseline; Phase 1–7 đã triển khai local; Phase 8 có công cụ local nhưng gate đầy đủ còn mở; Phase 9 chưa triển khai.
- [Hạn mức Google Apps Script](https://developers.google.com/apps-script/guides/services/quotas)
- [Triển khai ứng dụng web Apps Script](https://developers.google.com/apps-script/guides/web)

Repository chưa có file `LICENSE`. Việc công bố mã nguồn không tự cấp một giấy phép sử dụng cụ thể; cần chủ sở hữu xác định giấy phép trước khi phân phối lại theo điều khoản đó.

Kiểm thử đối chiếu cho kế hoạch web mới và cách chạy: [Phase 0](docs/phase-0/README.md). Kết quả hiện tại: 98/98 tests với nguồn Apps Script và dịch vụ giả lập; chưa kiểm dịch vụ cloud thật.
