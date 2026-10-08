# Phase 0 — Baseline và bộ kiểm thử đối chiếu

Baseline ứng dụng: **V1.59.2**, commit `aae3c570286edac1db5ca355cbce40f5108d0a10`. Phase này không sửa 29 file Apps Script hoặc 10 test info.txt gốc, không cần tài khoản cloud và không thực hiện Phase 1.

## Tài liệu và artifacts

- [inventory.json](inventory.json): checksum SHA-256/byte count/function list cho 29 nguồn, 34 API có tham số/quyền/đích, 42 nhóm chức năng có phase/ca nghiệm thu, giới hạn baseline.
- [PARITY.md](PARITY.md): bảng đối chiếu dễ đọc, phân biệt golden domain hiện có và acceptance test app mới chưa chạy.
- [DECISIONS.md](DECISIONS.md): kiến trúc, free-first, worker/Drive, chênh lệch tài liệu/mã và các lỗi cần thay đổi khi port.
- [library-profile.json](library-profile.json): 3 workload metadata synthetic; `realLibrary` chưa có dữ liệu thật.
- [REPORT.md](REPORT.md): kết quả mới của lần thực hiện Phase 0 và gate.
- [cases.json](../../tests/baseline/cases.json), [golden.json](../../tests/baseline/golden.json): case descriptors và expected output ghi từ nguồn pinned, không chép từ lịch sử test.
- [fixtures](../../tests/baseline/fixtures): 17 mẫu HTML/TXT/MD/CSV nguyên bản tự tạo và export library synthetic; chỉ `.test` domains, không nội dung tác phẩm hay cookie thật.

## Chạy kiểm tra

Yêu cầu: Git checkout có baseline commit, Node.js >=20; không cần npm install, network hoặc Google credentials.

Tại thư mục gốc repository:

```bash
node --test tests/book-info.test.js tests/baseline/*.test.cjs
```

PowerShell không mở rộng glob giống shell Unix; có thể dùng các file rõ ràng:

```text
node --test tests/book-info.test.js tests/baseline/golden.test.cjs tests/baseline/inventory.test.cjs tests/baseline/profile.test.cjs
```

Test runner không ghi lại snapshots. Mọi source drift khỏi baseline, generic Error ngoài kỳ vọng hoặc API/feature missing gây thất bại. VM chạy `.gs` thật với clock/Drive/Properties/HTTP giả lập; Google service thật chưa được kiểm. `Utilities.parseCsv` là CSV stand-in đã test riêng, không chứng minh provider Google thật có cùng tất cả edge cases.

Có hai sensitivity tests thay đổi thuật toán ordinal/ngưỡng chapter trong VM, chứng minh golden bắt thay đổi; không sửa file sản phẩm. Các ca lỗi validation/parser mong đợi là test pass khi lỗi đúng type/message, không phải test suite failed.

## Bảo quản và cập nhật baseline

Chỉ khi chủ đích review lại fixtures/expected mới dùng lệnh bảo trì:

```bash
node tools/baseline/record-golden.cjs --record-pinned-baseline
node tools/baseline/create-inventory.cjs
```

`record-golden` luôn đọc nguồn bằng `git show` tại commit pinned, không lấy mã đang sửa làm expected. Xem diff output và xác minh ca lỗi/neo metadata/CSV/chèn chương trước khi commit. Không chạy record để làm một thay đổi code mới hết fail; bản mới phải so với baseline và ghi exception ADR cho thay đổi có chủ ý.

Clone CI phải có baseline Git object. Khi dùng shallow checkout, lấy đủ history trước test (ví dụ checkout với fetch-depth=0); việc thiếu object là prerequisite thất bại, không tự bỏ test.

## Thống kê export thư viện thật về sau

Giữ export riêng trong `.local-library/` (đã gitignore). Format đầu vào JSON:

```json
{
  "schemaVersion": 1,
  "provenance": "private owner export",
  "books": [],
  "chapters": [],
  "files": []
}
```

`books` là các hàng BOOKS đủ 13 cột; `chapters` là hàng CHAPTERS đủ 12 cột, không kèm hàng header; `files` là metadata `{ "id": "...", "sizeBytes": 123 }`. Không cho token, cookie, secrets hoặc nội dung chương vào export dành cho profiler. Cần lưu thứ tự/kiểu các ô để audit migration; file sizes phải lấy từ metadata thật khi có quyền.

```bash
node tools/baseline/profile-library.cjs .local-library/export.json
```

Profiler chỉ đọc file JSON, in số lượng/kích thước/tổng hợp, không in tên/URL sách hoặc truy cập Drive. Thiếu inventory file thì kết quả missing-file là `null`, không tự coi là mọi file tồn tại. Các counter/status/ID lỗi vẫn cần migration validation sâu ở Phase 3/8.

`.claspignore` ở root chỉ cho `.gs`, `.html` và `appsscript.json` lên Apps Script, loại toàn bộ công cụ/tests/artifacts mới. Manifest/link clasp thuộc project người dùng hiện có; phase này không tạo hoặc ghi đè bindings.
