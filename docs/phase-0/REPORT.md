# Báo cáo thực hiện Phase 0

Ngày: 08/10/2026 (Asia/Saigon). Baseline: Apps Script V1.59.2 tại `aae3c570286edac1db5ca355cbce40f5108d0a10`. Repository lúc bắt đầu Phase 0: `e81dfa2a5c6b44678acf3582b2b3cfdbf1c70a0c`. Runtime kiểm thử: Node.js v24.19.0.

## Kết quả

- Khóa SHA-256 và byte count cho 29 file mã nguồn (18 `.gs`, 11 `.html`); mã sản phẩm và 10 test info.txt ban đầu giữ nguyên byte-for-byte.
- Inventory đủ 34 API với tên/tham số, đích mới, quyền và ca nghiệm thu; đủ F01–F38/N01–N04 (42 nhóm) với phase và acceptance cases, không có nhóm bị bỏ sang “ngoài phạm vi”.
- 17 fixture original synthetic cho HTML/phân trang/chương/metadata và TXT/MD/CSV/Hồi/marker, cộng một metadata export thư viện synthetic. Không tải nội dung/cookie từ website thật, chỉ dùng domain `.test`.
- 74 golden cases ghi bằng thực thi source của commit pinned, gồm expected errors và 3 characterization cases cần đổi vì an toàn đa người dùng. Snapshot không sinh từ mã tương lai đang sửa.
- Golden bao phủ normalize/URL, Cleaner, Parser/metadata, rules, discovery/paging/mixed, import/merge, group ordering, filename/document, reader header, empty runs, removed log, info và utf8 sizing.
- Thêm profiler offline read-only; kiểm missing/duplicate/orphan/malformed metadata, không in tên/URL/nội dung user. Actual owner library chưa cung cấp.
- Ba profile synthetic: 14 sách/126 chương; 100 sách/20.000 chương; 1 sách/20.000 chương. Các số này là workload thiết kế, không đo quota hoặc hiệu năng app/cloud.
- ADR chốt mô hình thư viện/auth/quyền/publication/Drive và phương án worker, ghi free-first theo câu trả lời người dùng; không tạo dịch vụ, enable billing hay kích hoạt nâng gói.
- Đã ghi các chênh lệch plan/mã và 3 hành vi an toàn cần đổi khi port; không sửa baseline để làm biến mất bằng chứng.
- `.local-library/` được gitignore; `.claspignore` chỉ cho root `.gs/.html` và manifest để các tests/tools/artifacts không lên Apps Script.

## Kiểm chứng đã chạy

Từ thư mục gốc checkout:

```bash
node --test tests/book-info.test.js tests/baseline/golden.test.cjs tests/baseline/inventory.test.cjs tests/baseline/profile.test.cjs
node tools/baseline/profile-library.cjs tests/baseline/fixtures/library-export.json
git diff --check
```

Kết quả suite: **98 tests, 98 pass, 0 fail, 0 skipped, 0 cancelled**.

Phân rã: 74 golden; 10 info.txt gốc; 14 kiểm tra baseline integrity, snapshot/neo output, 2 source mutation trong VM, API/feature coverage, syntax/templates, CSV stand-in, fetch isolation và profiler. 11 case có lỗi validation/parser theo kỳ vọng vẫn pass vì đúng loại/nội dung lỗi; không bị giấu dưới dạng skip/expected-failure.

Hai mutation kiểm sensitivity: đổi thuật toán ordinal 21 thành 22 và nâng ngưỡng chương 50 lên 500 trong VM làm output khác snapshot đúng như dự kiến; source trên đĩa không thay đổi.

Profiler chạy CLI trả 14 sách/126 chương, WEB=5/FILE=5/FOLDER=4, 72 metadata file, tổng 100.870 bytes, max 1.932 bytes và không có issue cấu trúc trong mẫu. Không suy ra dung lượng thư viện thật từ các số này.

API inventory cũng kiểm 18 file server parse, 3 script giao diện parse và 10 template includes tồn tại. Không dùng syntax check để thay thế các golden/functional tests.

## Gate và công việc còn mở

**Gate đối chiếu Phase 0 đạt:** mọi feature/API có phase và ca nghiệm thu, checksum và expected output có nguồn xác định; có runner kiểm lại và ADR cho thay đổi có chủ ý. Có thể triển khai Phase 1 với fixtures, chưa coi app mới đã chạy.

**Một hạng mục khảo sát thư viện thật còn mở:** số sách/chương và max file thực tế chưa thể xác định vì chưa có export owner. Checklist giữ `[!]`, không giả đánh xong bằng dữ liệu mẫu. Profiler và quy trình private export đã sẵn sàng; cần hoàn tất trong Phase 3 trước chọn thông số theo dữ liệu thật, và bắt buộc trước nghiệm thu migration Phase 8. Gate plan ban đầu cho phép thiếu dữ liệu thật khi chuẩn bị fixtures.

**Chưa chạy:** Google Auth/Drive/Sheets thật; Netlify/Supabase/Cloud Run; browser E2E/UI và migration/restore thực; các bộ lịch sử ngoài repo. 98 tests không chứng minh auth đa người, RLS, API mới, worker hoặc phân trang trình đọc đã triển khai.

**Chi phí:** free-first đã chốt; số tiền/live quotas chưa đo. Worker cloud chỉ provision sau kiểm điều kiện billing/free allowance; việc cần kích hoạt billing hoặc nâng cấp phải có chấp thuận riêng, không ngầm được cấp bởi yêu cầu Phase 0.

**Bước tiếp theo theo plan:** Phase 1 — cấu trúc web/API/worker/domain/contracts, schema/RLS migrations và CI; giữ baseline Apps Script làm đối chiếu.
