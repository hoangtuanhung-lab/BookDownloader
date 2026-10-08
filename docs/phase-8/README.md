# Phase 8 — Chuyển dữ liệu và đối chiếu local

Đọc `plan_TrinhTaiTruyen.md` và `PLAN_WEB_APP.md` trước khi sửa code. Baseline GAS V1.59.2 giữ nguyên. Web mới `2.0.0-phase.8`; làm local trước, kiểm dịch vụ thật sau khi đóng code.

## Công cụ đã có

- `export-phase8-read-only.gs` dùng cùng `export-read-only.gs`: đọc BOOKS/CHAPTERS/CONFIG và tách LOG, DB_ID/ANA_QUEUE/FLD_/IMP_/DEL_, UserProperties vào `privateReview`. Hai helper nằm ngoài bộ 29 file baseline và không được `clasp push` tự động. Chưa chạy trên Apps Script thật. Cookies/credentials không được xuất; cấu hình server riêng. LOG/lỗi queue có thể có nội dung riêng tư: lưu cả gói trong `.local-library/`, không commit hoặc gửi lên chat.
- `export-browser-progress.js`: chủ động chạy trong DevTools của **frame đọc truyện cũ**, đúng tài khoản, tải file xuống máy. Netlify không đọc được storage của origin cũ. Origin/email trong export không tự chứng minh chủ sở hữu.
- `convertLegacyProgress` đổi `c/y/p` thành chapter order/scroll/ratio và báo JSON sai hoặc cùng sách từ nhiều origin. Operator chọn bản sau đối chiếu timestamp `t`; không tự merge. Giữ file gốc để đối soát. Import cần UUID/email khớp bootstrap owner active, email đã xác minh và có admin; không phân phối progress owner cho người dùng khác. Cấu hình đọc cá nhân chưa tự chuyển.
- `migration:local`: nhập metadata vào database **local rỗng**, transaction nguyên khối. Inventory phải đầy đủ và chứng minh ancestry đến root. ID book/chapter/group ổn định; giữ decimal order, nhãn `*`/`1-2`, URL, author, genres, folder/file IDs và retry/error. Không tạo folder/file, không outbox, không tự xuất bản. Ngày tạo `dd/MM/yyyy` dùng múi giờ Việt Nam; ISO có offset được nhận; ngày không hiểu phải sửa rõ trước nhập. Ngày chương được lưu trong report để đối soát vì schema runtime không có trường ngày legacy riêng.
- Checksum gồm toàn bộ export đã parse và options. Cùng source/checksum chạy lại giữ counts/IDs, không ghi đè sửa mới; snapshot thay đổi bị chặn, chưa có delta tự động. Resource mất/soft-delete không được dựng lại. SQL lỗi rollback cả dữ liệu và ledger. `skippedChapterKeys` chỉ nhận DONE không file đã được người quản trị xác nhận; thiếu file khác luôn lỗi.
- DOWNLOADING/READY/IDLE được giữ trong report, chuyển PAUSED; jobs mới paused, không nhận lease cũ. ANALYZED giữ nguyên, FOLDER không tạo tác vụ tải. FILE pending giữ dừng cho tới khi đối chiếu `_import.json`; chưa tự chuyển manifest cũ thành checkpoint runtime mới. ANA_QUEUE và removed logs giữ trong archive riêng, **chưa tự replay thành jobs hoặc rows runtime**; CONFIG được giữ trong review report, **chưa tự áp dụng vào settings mới**. Đây là các bước đối soát còn mở, không được bỏ archive.
- Migration review chặn `start/retry/verify` và worker/outbox của sách nhập. `review_legacy_book` là RPC dành riêng server/operator: cần admin owner, checksum và hashes synced, không có FILE pending chưa reconcile. Duyệt không tự xuất bản hoặc tự chạy jobs. Việc ghi trạng thái `synced` phải dựa kiểm file/quyền thật sau đóng code; kiểm hash của backup local không chứng minh quyền Drive live.
- `migration:verify-files`: kiểm bytes/hash của **mọi file chương tham chiếu** với manifest trước migration, giới hạn đường dẫn trong backup root kể cả symlink. Không ghi Drive/database; báo thiếu/hỏng/outside. Không thay backup info/cover/_import/removed logs. Giữ backup toàn bộ folder khi chuyển thật.

## Chạy kiểm chứng

```bash
npm ci
npm run db:up
npm run check
npm run test:migration:db
npm run test:migration:load
npm run test:migration:restore
```

Các SQL tests tạo rồi xóa database có UUID riêng; không truncate database phát triển. Restore rehearsal cần Docker Compose service `bookdownloader-db-1`, chạy pg_dump/pg_restore của chính PostgreSQL container. Dump synthetic nằm ở `.local-library/phase8/rehearsal.dump`, quyền 0600, ignored. CI chạy migration/load tests; restore Docker rehearsal thực hiện local riêng.

Ba workload Phase 0: 14 sách/126 chương đủ nguồn và trạng thái; 100 sách/20.000 chương; một sách/20.000 chương. Ngưỡng cố định trong `tools/dev/phase8-load.ts` trước chạy: import <120s mỗi workload, page p95 <500ms, cold/warm <500ms, process RSS <512 MiB, worker mock 20 chương <30s, warm không đọc file lại. [Số đo](load-result.json) là PostgreSQL local và Drive/HTTP in-memory; delay bằng 0 ở riêng bài đo worker. Không suy ra tốc độ website, quota hay chi phí cloud. RSS đo process Node, không phải tổng RAM database/container.

## Rehearsal thư viện của chủ dự án (sau khi đóng code)

1. Chủ thư viện dừng trigger/tải cũ, freeze chỉnh sửa; chờ các execution kết thúc. Dừng worker mới. Chốt snapshot, tài khoản owner và root. Không cho hai hệ ghi cùng folder.
2. Export read-only, tách private state; lập inventory đầy đủ, backup folder/file, SHA-256 manifest. Giữ raw export bảo mật; không bật lại trigger cũ trong lúc đối soát.
3. Tạo database local riêng và chạy `db:migrate` bằng DATABASE_URL localhost của database đó. Chuẩn bị danh tính owner local đã bootstrap để diễn tập. CLI từ chối hostname remote. **Không dùng CLI này để nhập trực tiếp Supabase cloud.**
4. Tạo options private theo mẫu dưới; xác minh skipped/progress, không tin email export đơn thuần. Lưu file trong `.local-library/`.
5. Dry-run, verify files, import, rerun với tên report mới; kiểm checksum/count/IDs/date/group/order/status, removed logs, manifests, queue và CONFIG. Không chỉnh snapshot rồi dùng lại cùng source key.
6. Review selected books, backup/restore metadata và files; sau đó mới thiết kế/duyệt công cụ migration cloud/delta và đối soát FILE pending. Gate thật vẫn mở.

```json
{
  "sourceKey": "owner-snapshot-YYYYMMDD",
  "ownerId": "UUID_CUA_BOOTSTRAP_OWNER_DA_XAC_MINH",
  "ownerEmail": "EMAIL_OWNER_DA_XAC_MINH",
  "driveSubject": "GOOGLE_SUBJECT_CUA_CHU_THU_VIEN",
  "skippedChapterKeys": [],
  "progress": []
}
```

```bash
npm run migration:dry-run -- .local-library/export.json .local-library/dry-run.json
npm run migration:verify-files -- .local-library/export.json .local-library/options.json .local-library/files .local-library/manifest.json .local-library/files-report.json
npm run migration:local -- .local-library/export.json .local-library/options.json .local-library/import-report.json
npm run migration:local -- .local-library/export.json .local-library/options.json .local-library/rerun-report.json
```

Manifest: object có key Drive file ID, value `{ "path": "relative/chapter.txt", "sha256": "64-hex" }`. `driveSubject` phải là chủ thư viện thực tế, không phải email reader. Mọi report mới phải chưa tồn tại; chế độ file 0600. Nếu DB đã commit mà ghi report thất bại, kiểm ledger rồi chạy lại cùng snapshot/options với output mới; không xóa dữ liệu để thử lại. Chuẩn bị review FILE/queue/config/delta và test OAuth/Drive/cloud trước khi tuyên bố Phase 8 hoàn tất toàn bộ.
