const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {root,baselineCommit,createRuntime}=require('./legacy-runtime.cjs');
const show=f=>execFileSync('git',['show',`${baselineCommit}:${f}`],{cwd:root});
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const names=execFileSync('git',['ls-tree','-r','--name-only',baselineCommit],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(f=>/\.(gs|html)$/.test(f));
const files=names.map(name=>{const bytes=show(name);return {path:name,bytes:bytes.length,sha256:sha(bytes),functions:[...bytes.toString().matchAll(/^function (\w+)\(([^)]*)\)/gm)].map(m=>({name:m[1],parameters:m[2].split(',').map(s=>s.trim()).filter(Boolean)}))};});
const {ctx}=createRuntime({pinned:true});
const code=show('Code.gs').toString();
const plan=fs.readFileSync(path.join(root,'PLAN_WEB_APP.md'),'utf8');
const apiMap=Object.fromEntries([...plan.matchAll(/^\| (api_\w+) \| ([^\n]+?) \| ([^\n]+?) \|$/gm)].map(m=>[m[1],{target:m[2].trim(),permission:m[3].trim()}]));
const features=[...plan.matchAll(/^\| ([FN]\d{2}) \| ([^\n]+?) \| ([^\n]+?) \| ([^\n]+?) \|$/gm)].map(m=>({id:m[1],behavior:m[2].trim(),source:m[3].trim(),phases:m[4].trim()}));
const goldenCases=JSON.parse(fs.readFileSync(path.join(root,'tests/baseline/cases.json'),'utf8'));
const acceptance={
F01:['Nhập một/nhiều URL bằng dấu ; và dòng thêm; phân biệt tự động/thủ công; URL sai không mất ô nhập.'],
F02:['Máy chủ chậm: dòng chờ xuất hiện trước response; thêm URL khi phân tích đang chạy; reject trả input đúng.'],
F03:['Đóng/mở tab vẫn còn queue; lỗi lưu lại; retry chuyển cuối queue; bỏ URL; ANALYZED không tự tải.'],
F04:['Đối chiếu 8 cột và thao tác theo từng trạng thái; metadata chưa có để trống; link folder đúng.'],
F05:['JSON-LD/meta/H1, vùng lồng, selector cấu hình, auto fallback và thiếu/quá ngắn: đối chiếu golden.'],
F06:['Mục lục 2 trang có lặp URL/trang; URL mẫu đúng/sai; giữ cảnh báo, không sinh URL không chứng minh.'],
F07:['Mixed volume/flat và chương 1-2 đúng thứ tự/nhãn; reanalyze chỉ thêm thiếu, không mất IDs/file/progress.'],
F08:['Chuyển một/tất cả ANALYZED; cap đầy vào IDLE; đổi thứ tự giữ fairness.'],
F09:['Hai pipeline FILE/WEB cap độc lập; FOLDER không có URL job; đúng mọi transition sách/chương.'],
F10:['Đóng tab vẫn tải nền; pause ở ranh giới batch; start/retry; AUTO_RESUME=false dừng tự tiếp tục.'],
F11:['401/403 không retry vô hạn; 429 Retry-After; 5xx retry budget; delay/cookie đúng domain.'],
F12:['Tạo file xong rồi lỗi DB; chạy lại không duplicate; verify file mất; FOLDER không thành WEB.'],
F13:['Monitor tổng và filters chờ/phân tích/tải/pause/error khớp DB; refresh và từng thao tác đúng quyền.'],
F14:['Retry/cancel/pause/delete từng chương, sửa URL/title, count và quyền; DONE bỏ qua không đọc như có file.'],
F15:['Một đến ba ERROR rỗng giữa DONE bị bỏ; bốn liên tiếp/cuối sách giữ; không renumber.'],
F16:['Append log cho tự xóa/xóa chương lỗi; group/số hiệu/lý do đầy đủ; không ghi cho xóa DONE.'],
F17:['TXT/MD/CSV quoting/newline, duplicate chapter, Hồi tiếng Việt và lời tựa; lỗi không có heading.'],
F18:['Marker Phần/Quyển, preamble; ghép thiếu/thừa và fallback theo index; không mất nội dung ngoài mục lục.'],
F19:['Import folder với tên chương đa dạng, file phụ và duplicate số; giữ skipped và folder uniqueness.'],
F20:['Import dài checkpoint ở từng batch; _import.json còn khi chưa xong; hoàn tất mới dọn.'],
F21:['Thêm link/file/paste; nhóm mới/cũ/rỗng, chèn giữa, số trùng; FILE không thêm từ link.'],
F22:['Nội dung tự thêm ngắn được nhận; >300000 ký tự hoặc >2000000 byte bị chặn, message rõ.'],
F23:['Grid mặc định/table, tìm không dấu tên/tác giả, sort/page; reload nhớ lựa chọn theo user.'],
F24:['Tên khác dấu/hoa là trùng; rename/move theo primary genre; lỗi Drive có trạng thái repair rõ.'],
F25:['Multi-genre/primary, nhập từ sách; xóa danh mục không mất metadata; tên normalize trùng loại.'],
F26:['Sửa hai draft rồi Save all, một lỗi giữ lại; cảnh báo rời trang; màn Tải sách lưu ngay.'],
F27:['Bulk genre chỉ ANALYZED; lỗi từng item không mất success khác; kiểm quyền manage.'],
F28:['Delete khi worker chạy: không resurrect; option trash; dọn queue/progress; file ngoài ownership không xóa.'],
F29:['Reader chỉ DONE có file của sách được đọc, cây/dropdown nhóm/lời tựa; hidden/deleted/cache không bypass quyền.'],
F30:['Scroll/page, swipe/keys/edge click, biên chương, font/resize/rotate giữ vị trí.'],
F31:['Bốn font hệ số, size, ngày/đêm, bốn mức blue; giá trị cấu hình lạ trở mặc định.'],
F32:['Cụm 5, prefetch ở hai chương cuối, giữ tối đa hai cụm; batch tối đa 40; giới hạn byte mới được test riêng.'],
F33:['Hai thiết bị/clock lệch, khôi phục local/server, tab hide và chương khác hỏi continue; không stale overwrite.'],
F34:['Bìa chữ fallback, status badge, progress user và Read continue đúng chương đã đọc.'],
F35:['Dark Glass/sidebar/help/toast/modal focus/Esc/Tab/skeleton, mobile không tràn ngang ngoài vùng cuộn chủ ý.'],
F36:['Root create/register đủ quyền; defaults/limits config; không trả cookie hoặc secrets cho reader.'],
F37:['Bốn heading, Unicode và link rỗng FILE/FOLDER; update/no-change/trashed/restart; import không tính info là chương.'],
F38:['Audit actor/action/result và timestamp; lỗi tiếng Việt; không log cookie/token; query logs có quyền.'],
N01:['Google lần đầu tạo reader và redirect /read; login lại/session expiry/logout/blocked có E2E thật.'],
N02:['Các tổ hợp read/download/manage/admin, direct API/URL và RLS; reader không tự cấp quyền.'],
N03:['Ảnh validate/upload/preview/staged Save all/cancel/replace/remove/fallback; lỗi không mất bìa đang dùng.'],
N04:['Hai user dùng cùng browser; cache/progress/preferences tách user; không chuyển progress owner cho user mới.']};
for(const f of features){f.acceptanceCases=acceptance[f.id];if(!f.acceptanceCases)throw Error('Missing acceptance '+f.id);f.baselineCases=goldenCases.filter(c=>c.features.includes(f.id)).map(c=>c.id);f.implementationEvidence='planned; not executed against the new app';}
const apis=[...code.matchAll(/^function (api_\w+)\(([^)]*)\)/gm)].map(m=>{if(!apiMap[m[1]])throw Error('Missing API map '+m[1]);return {name:m[1],parameters:m[2].split(',').map(s=>s.trim()).filter(Boolean),...apiMap[m[1]],acceptanceCases:['Authenticated happy path with schema + resource ownership','Missing/expired/blocked token and insufficient role rejected','Invalid input/foreign resource, error and no unauthorized side effect'],implementationEvidence:'planned; legacy inventory only'};});
const inventory={schemaVersion:1,baselineCommit,version:ctx.VERSION,sourceCount:files.length,sourceBytes:files.reduce((s,f)=>s+f.bytes,0),files,apis,features,
  legacyInfoTest:{path:'tests/book-info.test.js',sha256:sha(show('tests/book-info.test.js')),cases:10},
  limits:{chapterOrderMax:99999,manualAnalyzeMaxChapters:20000,discoveryMaxPages:300,chapterNetworkMinCharacters:50,chapterPasteMaxCharacters:ctx.ADD_TEXT_MAX_,chapterFileMaxBytes:2000000,siteRulesMaxCharacters:ctx.RULES_MAX_,genresMax:ctx.GENRES_MAX_,analysisQueueMaxBytes:ctx.ANA_MAX_BYTES_,analysisUrlMaxCharacters:ctx.ANA_URL_MAX_,analysisMoveMaxBooks:ctx.ANA_MOVE_MAX_,analysisErrorMaxCharacters:ctx.ANA_ERR_MAX_,analysisErrorMaxRows:ctx.ANA_ERR_LIST_MAX_,readerBatchMaxChapters:40,readerClusterChapters:5,readerRetainedClusters:2,readerCacheTTLSeconds:ctx.RD_TTL_,emptyRunMax:ctx.EMPTY_RUN_MAX_,defaults:JSON.parse(JSON.stringify(ctx.DEFAULTS))},
  notes:['Manual/discovery limits and browser constants checked against source; source hashes pin exact evidence.','42 feature groups have planned acceptance cases, not 42 executed E2E tests.','No production library or credential exported.']};
fs.writeFileSync(path.join(root,'docs/phase-0/inventory.json'),JSON.stringify(inventory,null,2)+'\n');
console.log(`Pinned ${files.length} sources, ${apis.length} APIs, ${features.length} feature groups.`);
