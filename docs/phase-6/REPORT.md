# Báo cáo Phase 6 local — 08/10/2026

Web `2.0.0-phase.6`, triển khai cùng Phase 5 từ baseline `3b55a9d`. **Gate local đạt; smoke website thật và các gate cloud còn mở.** Làm local trước theo quyết định chủ dự án. Xem [bảng kiểm đầy đủ 400/400](../phase-5/REPORT.md); đây là cùng lượt kiểm, không cộng hai lần.

F01–F07/F26/F27: bảng 8 cột, automatic/manual, optimistic row, nhận URL trong lúc có việc, reject trả URL, queue durable, giữ lỗi/retry/drop, metadata lưu ngay và genre bulk có manage. Kết quả ANALYZED có info/folder và không tự tải/xuất bản. Parser port async tái sử dụng hàm pure Adapters/Parser/ChapterManager và có HTTP injection; thêm SSRF/DNS pinning/cookie boundary.

**Kiểm mới:** 11 unit Phase 6 (IP/DNS/mapped IPv6/metadata/reserved, private redirect, cookie cross-domain, connection pinned, discovery paging/mixed/range, không sinh 2950 URL từ một chương, template hợp lệ/slug sai, CAPTCHA/pager lỗi, manual 1–20000, checkpoint resume). 7 unit Phase 5, 22 SQL/API/executor và 13 browser dùng chung hai phase. Legacy/domain goldens được chạy lại nguyên trạng để đối chiếu.

SQL/API/executor kiểm hold ANALYZED không tải, reanalyze giữ IDs/file DONE/progress riêng, lỗi HTTP 403 giữ URL/lý do, retry/drop, quyền bulk, actor bị thu hồi không được fetch website. Browser kiểm 8 cột, nhiều URL qua `;`, thêm lượt tiếp, server reject trả input, invalid URL giữ nguyên và cấu hình manual 20000 chương.

Checkpoint sau từng trang được lưu trong jobs service-only. Test nối lượt không fetch lại trang trước. Retry thủ công xóa checkpoint discovery và đọc cấu hình hiện tại; các lượt tự nối giữ analysisConfig snapshot. URL đã bỏ được enqueue lại. Cấu hình JUNK_WORDS cập nhật cache key reader; SITE_RULES giữ grammar `|`/xuống dòng và giới hạn 2000 ký tự.

**Chênh lệch có chủ đích:** tự bổ sung URL tự động cần ít nhất hai quan sát trước khi chạy phép kiểm template legacy; một chương đơn lẻ không đủ chứng minh mẫu. Parser không tự coi CAPTCHA hoặc phân trang không xác định là thành công. Không port UrlFetchApp/Utilities.sleep vào server; dùng HTTP bounded và delay có thể hủy.

Chưa kiểm website thật hoặc bypass bot/CAPTCHA; không cam kết hỗ trợ mọi website. Chưa chạy Cloud Scheduler/Cloud Run/Google API/Netlify/Supabase cloud, chưa đo rate/quota hay migration thư viện thật. Các việc đó giữ mở để kiểm sau đóng code; bước nghiệp vụ tiếp theo là **Phase 7** tải WEB/FILE đầy đủ, monitor và vận hành scheduler.
