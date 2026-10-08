# Phase 0 — Đối chiếu chức năng và API

Baseline: V1.59.2, commit `aae3c570286edac1db5ca355cbce40f5108d0a10`. Mọi hàng có ca nghiệm thu và phase; ca nghiệm thu app mới hiện **chưa chạy**. Các tên golden chỉ thể hiện hành vi domain/harness đã kiểm, không xác nhận cả feature hoạt động trên cloud.

## 42 nhóm chức năng

| Mã | Phase | Ca nghiệm thu bắt buộc | Golden hiện có (một phần) |
|---|---|---|---|
| F01 | 6 | Nhập một/nhiều URL bằng dấu ; và dòng thêm; phân biệt tự động/thủ công; URL sai không mất ô nhập. | `normalize-book-url`, `invalid-book-url` |
| F02 | 6 | Máy chủ chậm: dòng chờ xuất hiện trước response; thêm URL khi phân tích đang chạy; reject trả input đúng. | Chưa có ca domain; cần E2E/API ở phase tương ứng |
| F03 | 6 | Đóng/mở tab vẫn còn queue; lỗi lưu lại; retry chuyển cuối queue; bỏ URL; ANALYZED không tự tải. | `utf8-size-unicode` |
| F04 | 6 | Đối chiếu 8 cột và thao tác theo từng trạng thái; metadata chưa có để trống; link folder đúng. | Chưa có ca domain; cần E2E/API ở phase tương ứng |
| F05 | 0, 6 | JSON-LD/meta/H1, vùng lồng, selector cấu hình, auto fallback và thiếu/quá ngắn: đối chiếu golden. | `decode-entities`, `metadata-jsonld`, `metadata-fallback`, `nested-html-block`, `clean-html-no-scripts`, `chapter-explicit-selector`, `chapter-auto-selector`, `chapter-too-short`, `chapter-no-content`, `site-rules-custom` |
| F06 | 6 | Mục lục 2 trang có lặp URL/trang; URL mẫu đúng/sai; giữ cảnh báo, không sinh URL không chứng minh. | `relative-url`, `discover-paged`, `discover-broken-pagination`, `discover-missing-chapters`, `verified-gap-template`, `inconsistent-gap-template` |
| F07 | 6, 7 | Mixed volume/flat và chương 1-2 đúng thứ tự/nhãn; reanalyze chỉ thêm thiếu, không mất IDs/file/progress. | `title-two-level`, `chapter-number-27`, `chapter-number-28`, `chapter-number-29`, `volume-display-number`, `discover-mixed`, `filename-56`, `filename-57`, `filename-58` |
| F08 | 7 | Chuyển một/tất cả ANALYZED; cap đầy vào IDLE; đổi thứ tự giữ fairness. | Chưa có ca domain; cần E2E/API ở phase tương ứng |
| F09 | 7 | Hai pipeline FILE/WEB cap độc lập; FOLDER không có URL job; đúng mọi transition sách/chương. | Chưa có ca domain; cần E2E/API ở phase tương ứng |
| F10 | 7 | Đóng tab vẫn tải nền; pause ở ranh giới batch; start/retry; AUTO_RESUME=false dừng tự tiếp tục. | Chưa có ca domain; cần E2E/API ở phase tương ứng |
| F11 | 7 | 401/403 không retry vô hạn; 429 Retry-After; 5xx retry budget; delay/cookie đúng domain. | `legacy-cookie-substring` |
| F12 | 3, 7 | Tạo file xong rồi lỗi DB; chạy lại không duplicate; verify file mất; FOLDER không thành WEB. | `filename-56`, `filename-57`, `filename-58` |
| F13 | 7 | Monitor tổng và filters chờ/phân tích/tải/pause/error khớp DB; refresh và từng thao tác đúng quyền. | Chưa có ca domain; cần E2E/API ở phase tương ứng |
| F14 | 5, 7 | Retry/cancel/pause/delete từng chương, sửa URL/title, count và quyền; DONE bỏ qua không đọc như có file. | Chưa có ca domain; cần E2E/API ở phase tương ứng |
| F15 | 7 | Một đến ba ERROR rỗng giữa DONE bị bỏ; bốn liên tiếp/cuối sách giữ; không renumber. | `chapter-too-short`, `chapter-no-content`, `empty-runs-63`, `empty-runs-64`, `empty-runs-65` |
| F16 | 5, 7 | Append log cho tự xóa/xóa chương lỗi; group/số hiệu/lý do đầy đủ; không ghi cho xóa DONE. | `removed-log-line`, `removed-log-empty-fields` |
| F17 | 5 | TXT/MD/CSV quoting/newline, duplicate chapter, Hồi tiếng Việt và lời tựa; lỗi không có heading. | `ordinal-7`, `ordinal-8`, `ordinal-9`, `ordinal-10`, `hoi-heading-inline`, `strip-toolbar-and-junk`, `import-chapters.txt`, `import-chapters.md`, `import-chapters.csv`, `import-hoi.txt`, `import-no-headings`, `preamble-document` |
| F18 | 5 | Marker Phần/Quyển, preamble; ghép thiếu/thừa và fallback theo index; không mất nội dung ngoài mục lục. | `marked-paired-merge`, `marked-malformed` |
| F19 | 5 | Import folder với tên chương đa dạng, file phụ và duplicate số; giữ skipped và folder uniqueness. | `folder-name-44`, `folder-name-45`, `folder-name-46`, `folder-name-47`, `folder-name-48`, `folder-name-49`, `folder-name-50` |
| F20 | 5, 7 | Import dài checkpoint ở từng batch; _import.json còn khi chưa xong; hoàn tất mới dọn. | `chapter-document` |
| F21 | 5 | Thêm link/file/paste; nhóm mới/cũ/rỗng, chèn giữa, số trùng; FILE không thêm từ link. | `insert-between-group-chapters`, `duplicate-group-display-number`, `flat-chapter-inside-volume`, `invalid-chapter-order`, `max-chapter-order` |
| F22 | 5 | Nội dung tự thêm ngắn được nhận; >300000 ký tự hoặc >2000000 byte bị chặn, message rõ. | Chưa có ca domain; cần E2E/API ở phase tương ứng |
| F23 | 4, 5 | Grid mặc định/table, tìm không dấu tên/tác giả, sort/page; reload nhớ lựa chọn theo user. | `normalize-vietnamese` |
| F24 | 5 | Tên khác dấu/hoa là trùng; rename/move theo primary genre; lỗi Drive có trạng thái repair rõ. | `normalize-vietnamese`, `sanitize-filename`, `formula-input-rejected` |
| F25 | 5 | Multi-genre/primary, nhập từ sách; xóa danh mục không mất metadata; tên normalize trùng loại. | `genre-normalization` |
| F26 | 5, 6 | Sửa hai draft rồi Save all, một lỗi giữ lại; cảnh báo rời trang; màn Tải sách lưu ngay. | Chưa có ca domain; cần E2E/API ở phase tương ứng |
| F27 | 6 | Bulk genre chỉ ANALYZED; lỗi từng item không mất success khác; kiểm quyền manage. | Chưa có ca domain; cần E2E/API ở phase tương ứng |
| F28 | 5, 7 | Delete khi worker chạy: không resurrect; option trash; dọn queue/progress; file ngoài ownership không xóa. | Chưa có ca domain; cần E2E/API ở phase tương ứng |
| F29 | 4 | Reader chỉ DONE có file của sách được đọc, cây/dropdown nhóm/lời tựa; hidden/deleted/cache không bypass quyền. | `reader-strip-generated-header`, `reader-preserve-unmatched-folder-header`, `legacy-cache-before-file-permission` |
| F30 | 4 | Scroll/page, swipe/keys/edge click, biên chương, font/resize/rotate giữ vị trí. | Chưa có ca domain; cần E2E/API ở phase tương ứng |
| F31 | 4 | Bốn font hệ số, size, ngày/đêm, bốn mức blue; giá trị cấu hình lạ trở mặc định. | `strip-toolbar-and-junk` |
| F32 | 4 | Cụm 5, prefetch ở hai chương cuối, giữ tối đa hai cụm; batch tối đa 40; giới hạn byte mới được test riêng. | Chưa có ca domain; cần E2E/API ở phase tương ứng |
| F33 | 4 | Hai thiết bị/clock lệch, khôi phục local/server, tab hide và chương khác hỏi continue; không stale overwrite. | Chưa có ca domain; cần E2E/API ở phase tương ứng |
| F34 | 4, 5 | Bìa chữ fallback, status badge, progress user và Read continue đúng chương đã đọc. | Chưa có ca domain; cần E2E/API ở phase tương ứng |
| F35 | 1, 4–7 | Dark Glass/sidebar/help/toast/modal focus/Esc/Tab/skeleton, mobile không tràn ngang ngoài vùng cuộn chủ ý. | Chưa có ca domain; cần E2E/API ở phase tương ứng |
| F36 | 3, 5, 7 | Root create/register đủ quyền; defaults/limits config; không trả cookie hoặc secrets cho reader. | `junk-inline`, `site-rules-custom`, `site-rules-invalid-selector`, `legacy-domain-substring` |
| F37 | 3, 5, 7 | Bốn heading, Unicode và link rỗng FILE/FOLDER; update/no-change/trashed/restart; import không tính info là chương. | `folder-name-44`, `folder-name-45`, `folder-name-46`, `folder-name-47`, `folder-name-48`, `folder-name-49`, `folder-name-50`, `info-full`, `info-file-source-blank`, `info-update-no-duplicate` |
| F38 | 1, 5–7 | Audit actor/action/result và timestamp; lỗi tiếng Việt; không log cookie/token; query logs có quyền. | `removed-log-line` |
| N01 | 2 | Google lần đầu tạo reader và redirect /read; login lại/session expiry/logout/blocked có E2E thật. | Chưa có ca domain; cần E2E/API ở phase tương ứng |
| N02 | 2, 5–7 | Các tổ hợp read/download/manage/admin, direct API/URL và RLS; reader không tự cấp quyền. | Chưa có ca domain; cần E2E/API ở phase tương ứng |
| N03 | 5 | Ảnh validate/upload/preview/staged Save all/cancel/replace/remove/fallback; lỗi không mất bìa đang dùng. | Chưa có ca domain; cần E2E/API ở phase tương ứng |
| N04 | 2, 4 | Hai user dùng cùng browser; cache/progress/preferences tách user; không chuyển progress owner cho user mới. | Chưa có ca domain; cần E2E/API ở phase tương ứng |

## 34 API của Code.gs

| API và tham số baseline | Đích | Quyền | Ca nghiệm thu |
|---|---|---|---|
| `api_getState()` | GET /state, dữ liệu lọc theo quyền, phân trang | Theo từng nhóm dữ liệu; không trả secret | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_createAndStart(info)` | POST /books/from-web | download | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_queueAnalyze(urls)` | POST /analysis/jobs | download | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_dropPending(url)` | DELETE /analysis/jobs/:id | download | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_analyzeAndHold(url)` | Worker analysis job, POST /analysis/jobs/:id/start khi cần | download | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_retryAnalyze(url)` | POST /analysis/jobs/:id/retry | download | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_addChapter(id, kind, f)` | POST /books/:id/chapters | manage; thêm link cần download | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_chapterGroups(id)` | GET /books/:id/groups | read nếu sách xuất bản; manage/download khi quản trị | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_moveToDownload(ids)` | POST /downloads/enqueue | download | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_manualAnalyze(sampleUrl, total)` | POST /analysis/manual | download | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_tick()` | POST /jobs/wake, nhận job; scheduler xử lý, không tải trong request | download cho wake, danh tính worker cho drain | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_setStatus(id, action)` | POST /books/:id/download-actions | download; verify chỉ đọc trạng thái cần quyền quản trị sách | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_chapters(id)` | GET /books/:id/chapters | read nhận chương được phép; manage/download nhận dữ liệu quản trị | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_errorChapters(id)` | GET /books/:id/chapter-errors | manage hoặc download | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_chapterAction(id, num, action)` | POST /chapters/:id/actions | download cho retry/pause/cancel; manage cho delete | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_editChapter(id, num, url, title)` | PATCH /chapters/:id | manage; sửa URL kích hoạt tải cần download | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_firstChapterUrls(ids)` | GET /books/source-links | download hoặc manage | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_addBookFromFile(filename, base64, meta)` | POST /imports/file | manage | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_addBookFromFiles(tocName, tocB64, fileName, fileB64, meta)` | POST /imports/paired-files | manage | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_addBookFromFolder(folderInput, meta)` | POST /imports/drive-folder | manage | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_saveBook(id, f)` | PATCH /books/:id | manage | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_setGenreMany(ids, genre)` | POST /books/bulk-genres | manage | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_saveBooksBatch(items)` | POST /books/bulk-save | manage | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_deleteBook(id, trashFolder)` | DELETE /books/:id, tùy chọn trash_folder | manage | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_reorderQueue(id, dir)` | POST /downloads/:id/reorder | download | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_saveConfig(cfg)` | PATCH /settings | admin; có thể tách config vận hành cho download sau | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_saveGenres(list)` | PUT /genres | manage | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_readerList(id)` | GET /books/:id/reader-chapters | read và quyền sách | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_readChapter(bookId, fileId)` | GET /chapters/:id/content | read và quyền sách | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_readChapterCluster(bookId, fileIds)` | POST /reader/cluster | read, kiểm từng chapter, giới hạn count/bytes | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_saveReadingProgress(bookId, chapterId, y, ratio, t)` | PUT /me/progress/:bookId | read; chỉ chính mình | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_getReadingProgress(bookId)` | GET /me/progress/:bookId | read; chỉ chính mình | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_registerRoot(input)` | PUT /drive/root | admin | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |
| `api_createRoot(name)` | POST /drive/root | admin | Authenticated happy path with schema + resource ownership; Missing/expired/blocked token and insufficient role rejected; Invalid input/foreign resource, error and no unauthorized side effect |

## Trạng thái nghiệm thu

- Phase 0: source hash, API signatures, fixtures/golden, syntax/template, bộ info và profiler được kiểm thực thi.
- App mới: chưa tạo, nên tất cả ca nghiệp vụ HTTP/auth/RLS/browser/Drive live đang planned/unrun.
- Security characterization ADR-006 cần thay expected khi port; không bảo tồn lỗi substring hoặc cache-before-permission.
- Không thiếu chức năng/API trong mapping; không đánh dấu pass cho nghiệp vụ chưa triển khai.
