# Báo cáo Phase 5 local — 08/10/2026

Baseline web: `3b55a9dd8a55dd9c588d29573de772a7b11a20e6` (Phase 4). Phiên bản mới: `2.0.0-phase.6`, triển khai chung Phase 5–6. Baseline Apps Script V1.59.2 và 29 file `.gs/.html` giữ nguyên, không đổi golden hay phiên bản GAS.

**Gate local đạt; gate Google Drive/Netlify/Supabase cloud còn mở theo quyết định chủ dự án.** Không provision, deploy, nhập dữ liệu thật hoặc yêu cầu credentials trong lượt này.

## Phạm vi

F14/F16–F28/F36–F38/N03 và quyền N02 theo phạm vi Phase 5: quản lý metadata, bản nháp/save-all/partial/revision, thể loại chính/danh mục, import single/pair/folder, thêm chương, sửa/chương lỗi, bìa và outbox. Các nhánh phụ thuộc tải WEB/scheduler/cap đầy đủ vẫn thuộc Phase 7, UI nêu rõ.

Tái sử dụng `legacy.mjs` (Importer/Cleaner/ChapterTools/Utils) và helper Phase 3 (folder/info/chapter/import/removed log). Bổ sung React Manage/Upload, schemas management, RPC service-only, upload/private-cover staging, executor `workflows.ts`, Drive move/trash/putCover và sharp decode. Migrations **008–013** là các bước thêm/follow-up; không sửa migration 001–007 đã áp dụng. Ledger local được chạy lại và không có checksum drift.

Các ca local đã chạy mới trong lượt này, không cộng kết quả lịch sử hoặc lượt chạy lặp:

| Bộ kiểm tra | Đạt |
|---|---:|
| Legacy info/golden/hash (`npm run test:legacy`) | 98/98 |
| Domain/API unit (`npm test`, gồm Phase 1–6) | 162/162 |
| Foundation SQL (`npm run test:db`) | 29/29 |
| Auth SQL/API (`npm run test:auth:db`) | 17/17 |
| Auth concurrency | 1/1 |
| Storage SQL/API | 14/14 |
| Reader SQL/API | 12/12 |
| Management/analysis SQL/API/executor | 22/22 |
| Guest Chromium | 5/5 |
| Auth Chromium | 12/12 |
| Reader Chromium | 15/15 |
| Management/analysis Chromium | 13/13 |
| **Tổng** | **400/400** |

`npm run check` (typecheck + legacy + unit + web/server build) đạt. Build browser có server-secret/cookie sentinels rồi `npm run test:bundle` đạt; `npm audit` đầy đủ không có vulnerabilities với sharp 0.35.5. Docker frozen `npm ci`/build/prune đạt; image `book-worker:phase6` chạy `--check` với local DB và encode/decode WebP bằng sharp thành công. `npm run worker:check` và migration lặp đạt. Các kiểm này không cộng thành test case trong tổng 400.

## Bằng chứng quan trọng

- Import file chia đợt bằng DB/API/executor thật local, adapter Drive fixture: tạo info/temp/TXT, restart nối chương còn lại, dọn temp sau hoàn tất, không ghi lại chương DONE.
- Gián đoạn sau Drive tạo file và trước DB commit: retry tìm lại file/folder, không tạo trùng. Gián đoạn sau khi trash temp nhưng trước DB commit cũng được retry hoàn tất, không đọc lại temp đã dọn. Lease hết hạn được nhận lại; worker thứ hai bị lock chặn.
- Pair marker giữ lời tựa `*` và Phần/Quyển, báo missing/extra theo thuật toán cũ. Bản cũ có fallback theo vị trí khi hai danh sách bằng độ dài; test fixture được đối chiếu lại với `mergeTocStory_`, không sửa thuật toán/golden để ép kết quả.
- Folder giữ file IDs, bỏ info/import/log/bìa, từ chối đăng ký trùng; không copy chương.
- Partial save giữ lỗi/truyện missing, stale version không ghi đè. Browser kiểm sửa tiếp trong lúc save, giữ nháp, sidebar/Back warning, xác nhận nội dung chương chưa gửi, upload hai chunks byte-identical, preview bìa chưa commit và trash confirmation.
- Manager khác không xem staging asset của actor; manage không cần read vẫn xem được bìa sách ẩn qua endpoint riêng. Reader endpoint/quyền cũ được hồi quy.
- Pause chương FILE giữ temp và job paused; retry nối tiếp, không thay file DONE. Xóa chương lỗi ghi lý do/URL; số hiệu chương còn lại không đổi.
- Xóa sách hủy queue và tiến độ, worker không làm sống lại sách; trash không chạm root/file ngoài mapping. Audit giữ actor.
- Chromium 390px không tràn viewport; bảng Tải sách cuộn ngang trong vùng bảng. Ảnh management/download được xem để đối chiếu giao diện tại `.local-browser-results/phase-5-6-screenshots/` (ignored).

## Giới hạn nghiệm thu

Upload 64 MiB/phiên, 8 phiên/actor, chunk 256 KiB và TTL 24h là giới hạn vận hành mới; ca boundary/schema đã kiểm local, chưa đo tải 64 MiB trên Function cloud hay dung lượng gói Supabase miễn phí. Database chỉ giữ bytes staging tạm; Drive giữ file chính. Bìa kiểm 5 MB đầu vào/20 triệu pixel/1200px, chưa thử mọi ảnh camera thực tế.

Executor tối thiểu dùng lock chung và lượt hữu hạn 45s/10 chương; Phase 7 bổ sung scheduler và cap FILE/WEB độc lập. Credentials/role SQL cloud, OAuth owner Drive, lỗi quyền/quota thật, folder ngoài root hiện hữu, cleanup TTL khi worker không chạy và gate staging phải kiểm sau đóng code. Không gọi môi trường cloud đã sẵn sàng vận hành.

Không rollback bằng xóa migration có dữ liệu. Khi kiểm cloud sau này cần backup, forward migration đã review và thư mục staging riêng. Các bảng/mapping baseline legacy không bị đổi trong lượt này.
