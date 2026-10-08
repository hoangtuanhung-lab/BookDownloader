# Báo cáo Phase 9 local

Ngày 09/10/2026, phiên bản `2.0.0-phase.9`. PostgreSQL 17/Node 24.19.0/npm 11.9.0/Chromium local; fixture nội dung tự viết, Google/OAuth/HTTP giả. Không tạo hoặc deploy Google API, Netlify, Supabase hay worker cloud; không bật scheduler/billing. Production gate của plan vẫn mở.

## Đã triển khai

- SQL statement write gate và worker admission/shared session lock: bảo trì từ chối writer còn chạy; worker không nhận việc/IO khi bảo trì, root binding server dùng chung cho API/worker.
- Admin operations/root UI/API, kiểm admin/origin và root write access; CAS revision/receipt chống replay; pending/uncertain không tự tạo lại. Root không đổi dưới thư viện có sách. Migration 023 sửa record-alias ambiguity và replay receipt sau tăng revision, không sửa checksum migration đã áp dụng.
- Reconcile CONFIG/GENRES, ngày giờ chương +07, FILE manifests/checkpoint, ANA_QUEUE paused/failed, removed log và LOG archive. Unresolved rollback; không nhập credentials, không đưa lỗi gốc lên báo cáo công khai. Rerun/delta dedup LOG/queue/removed log.
- Delta metadata cần planHash, snapshot DB/files khớp, owner/root/source cố định và baseline chưa bị sửa native; giữ IDs, archive removals, reset dangling progress, jobs paused/review lại. Không ghi/xóa Drive trong delta.
- Backup dump DB + offline content, SHA-256/permissions/path checks, restore DB mới còn bảo trì/digest/ACL/progress; tamper bị chặn. Restore không đảo Drive remote writes và không overwrite DB nguồn.
- Release version/commit/contract/minimum schema, build record/hashes/preflight, CI main candidate và manual production workflow đóng mặc định; kiểm provenance/lock/public keys, browser production rebuild đúng SHA có manifest riêng. DB/worker/scheduler riêng có review. Hướng dẫn [user/admin/dev](README.md), [sơ đồ/cutover/smoke/rollback](RUNBOOK.md).
- Importer rerun dùng indexed existence checks, giữ kiểm mapped resource missing mà tránh conditional outer joins. Kết quả benchmark mới ở `.local-library` và snapshot Phase 9; báo cáo Phase 8 giữ nguyên lịch sử.

29 file `.gs/.html` gốc/V1.59.2 không đổi. Bộ golden/info.txt baseline vẫn đạt.

## Kết quả kiểm thử

**495/495 kiểm thử độc lập đạt**, không đếm các lượt rerun là kiểm thử mới:

| Nhóm | Đạt |
|---|---:|
| Legacy golden/info | 98/98 |
| Unit/API/domain (Phase 1–9) | 189/189 |
| Foundation SQL/RLS | 29/29 |
| Auth SQL/API + concurrency | 17/17 + 1/1 |
| Storage SQL/API | 14/14 |
| Reader SQL/API | 12/12 |
| Management/analysis SQL/API/executor | 22/22 |
| Download SQL/API/executor | 22/22 |
| Migration local + restore + load | 15/15 |
| Operations/root/reconcile/backup/delta/FILE resume/preflight | 22/22 |
| Browser Phase 1/2/4/5/7/9 | 5 + 12 + 15 + 13 + 5 + 4 = 54/54 |

`npm run check` (typecheck/tests/build), bundle secret checks, repeat migrations, worker check, Docker worker build/check và WebP native smoke đạt. YAML hai workflows parse được; production dependency audit: 0 vulnerabilities. Các kiểm tra artifact/provenance/tamper dùng local, không tuyên bố GitHub-hosted release hoặc Netlify deploy đã chạy.

[Operations fixture result](operations-result.json) ghi 22 checks: ACL, active writer lock, root receipts, missing manifest rollback, private archives, reader trong bảo trì, backup/restore/tamper, delta conflicts/rerun, FILE resume không HTTP, alerts/preflight và rollback.

[Load result](load-result.json) giữ ngưỡng Phase 8: import <120s, page p95/read <500ms, RSS <512MiB, queue <30s, warm read 0 Drive fetch. Ba fixture: 14 sách/126 chương, 100 sách/20.000 chương, một sách/20.000 chương. Queue xử lý 20 chương qua hai finite passes. Một lượt bị SQL timeout, workspace cũng hết dung lượng cache Docker; đã dọn cache build (không xóa DB/volume/source), kiểm lại và benchmark cuối đạt. Timings local không xác lập quota/cost cloud; các giá trị đó vẫn null.

## Chưa đóng gate production

Google OAuth/scopes/owner/refresh/Drive 403-429; Supabase live RLS/connection/migrations; Netlify deploy/domain/redirect và mobile thực tế; full bytes backup, delta/migration/rollback **thư viện thật**; worker image registry/scheduler/backup schedule/alert delivery/chi phí và owner acceptance. Cần kiểm sau đóng code theo yêu cầu chủ dự án. UI counters không thay monitoring DB unavailable; manual workflow viết xong không chứng minh deployment thành công. Local verify files không chứng minh Drive access thật.

Các khoảng trống code Phase 8 đã có đối soát local ở Phase 9; không dùng kết quả này để tuyên bố hệ mới đã thay GAS trên production.
