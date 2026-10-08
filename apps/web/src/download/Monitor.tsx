import { useEffect, useRef, useState } from "react";
import {
  hasPermission,
  type Account,
} from "../../../../packages/contracts/src/index";
import type { Call } from "../manage/upload";
const labels: Record<string, string> = {
  ANALYZED: "Đã phân tích",
  IDLE: "Xếp hàng",
  QUEUED: "Xếp hàng",
  READY: "Sẵn sàng",
  DOWNLOADING: "Đang tải",
  PAUSED: "Tạm dừng",
  DONE: "Hoàn tất",
  ERROR: "Lỗi",
};
export function Monitor({
  account,
  call,
  notify,
}: {
  account: Account;
  call: Call;
  notify: (message: string) => void;
}) {
  const [books, setBooks] = useState<any[]>([]),
    [total, setTotal] = useState(0),
    [filter, setFilter] = useState("all"),
    [offset, setOffset] = useState(0),
    [error, setError] = useState(""),
    [selected, setSelected] = useState<any | null>(null),
    [errors, setErrors] = useState<any[]>([]),
    [errorOffset, setErrorOffset] = useState(0),
    [settings, setSettings] = useState<any | null>(null),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const controller = new AbortController(),
      n = ++generation.current;
    let pending = false;
    async function poll() {
      if (pending) return;
      pending = true;
      try {
        const r = await call(`/download?filter=${filter}&offset=${offset}`, {
          signal: controller.signal,
        });
        if (n === generation.current) {
          setBooks(r.books);
          setTotal(r.total);
          setError("");
        }
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally {
        pending = false;
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
      generation.current++;
    };
  }, [call, filter, offset, tick]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void call(`/download/books/${selected.id}/errors?offset=${errorOffset}`, {
      signal: controller.signal,
    })
      .then(setErrors)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [call, selected, errorOffset, tick]);
  async function action(action: string, id?: string) {
    if (busy) return;
    if (
      action === "cancel" &&
      !window.confirm(
        "Hủy tác vụ tải? File đã lưu được giữ; có thể tải tiếp sau.",
      )
    )
      return;
    setBusy(true);
    try {
      const result = await call("/download/actions", {
        method: "POST",
        body: JSON.stringify({ action, ...(id ? { id } : {}) }),
      });
      setTick((x) => x + 1);
      notify(
        action === "start-all"
          ? `Đã xếp tải ${result.started?.length ?? 0} truyện; còn ${result.remaining ?? 0} đã phân tích${result.remaining ? " — bấm tiếp để xếp đợt kế" : ""}`
          : action === "pause" || action === "cancel"
            ? "Đã yêu cầu dừng; file đang gửi có thể xuất hiện trên Drive nhưng kết quả bị chặn trước commit"
            : "Đã cập nhật hàng chờ; worker chạy độc lập trình duyệt",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Giám sát tải nền" className="monitor">
      <h2>Giám sát tác vụ</h2>
      <p>
        Worker chạy độc lập trình duyệt. Tạm dừng/hủy ngăn commit tiếp theo; một
        yêu cầu HTTP hoặc file đang gửi có thể hoàn tất trên Drive trước khi
        worker nhận lệnh.
      </p>
      <div className="manage-tools">
        <label>
          Nhóm tác vụ
          <select
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setOffset(0);
            }}
          >
            <option value="all">Tất cả</option>
            <option value="WEB">WEB</option>
            <option value="FILE">FILE</option>
            <option value="FOLDER">FOLDER</option>
          </select>
        </label>
        <button onClick={() => setTick((x) => x + 1)}>Làm mới tác vụ</button>
        <button disabled={busy} onClick={() => void action("start-all")}>
          Tải tất cả đã phân tích
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="table-wrap">
        <table>
          <caption>Tiến độ tải</caption>
          <thead>
            <tr>
              {[
                "Truyện",
                "Nguồn",
                "Trạng thái",
                "Tiến độ",
                "Lỗi / bỏ qua",
                "Thao tác",
              ].map((t) => (
                <th key={t}>{t}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {books.map((b) => (
              <tr key={b.id}>
                <td>{b.name}</td>
                <td>{b.sourceType}</td>
                <td>
                  {labels[b.status] || b.status}
                  {b.inFlight && <small> · Có lượt đang chạy</small>}
                  {b.phase && <p>{b.phase}</p>}
                  {b.error && <p>{b.error}</p>}
                  {b.nextRunAt && b.pending > 0 && (
                    <small>
                      Lượt tiếp: {new Date(b.nextRunAt).toLocaleString("vi-VN")}
                    </small>
                  )}
                </td>
                <td>
                  <progress
                    aria-label={"Tiến độ " + b.name}
                    value={b.done}
                    max={Math.max(1, b.total)}
                  />
                  {b.done}/{b.total} · chờ {b.pending}
                </td>
                <td>
                  {b.errors} / {b.skipped}
                  <button
                    onClick={() => {
                      setSelected(b);
                      setErrorOffset(0);
                    }}
                  >
                    Xem chương lỗi
                  </button>
                </td>
                <td>
                  {b.sourceType !== "FOLDER" && (
                    <>
                      <button
                        disabled={busy}
                        onClick={() => void action("start", b.id)}
                      >
                        {b.status === "ANALYZED"
                          ? "Chuyển xuống tải"
                          : "Tải / Tiếp tục"}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => void action("pause", b.id)}
                      >
                        Tạm dừng
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => void action("cancel", b.id)}
                      >
                        Hủy tác vụ
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => void action("retry", b.id)}
                      >
                        Thử lại lỗi
                      </button>
                    </>
                  )}
                  <button
                    disabled={busy}
                    onClick={() => void action("verify", b.id)}
                  >
                    Kiểm tra file
                  </button>
                  {["IDLE", "QUEUED"].includes(b.status) && (
                    <>
                      <button
                        disabled={busy}
                        aria-label={"Lên " + b.name}
                        onClick={() => void action("up", b.id)}
                      >
                        ↑
                      </button>
                      <button
                        disabled={busy}
                        aria-label={"Xuống " + b.name}
                        onClick={() => void action("down", b.id)}
                      >
                        ↓
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!books.length && <p>Chưa có tác vụ trong nhóm này.</p>}
      <div>
        <button
          disabled={!offset}
          onClick={() => setOffset((x) => Math.max(0, x - 24))}
        >
          Trang tác vụ trước
        </button>
        <span>
          {" "}
          {offset + 1}–{Math.min(offset + 24, total)} / {total}{" "}
        </span>
        <button
          disabled={offset + 24 >= total}
          onClick={() => setOffset((x) => x + 24)}
        >
          Trang tác vụ sau
        </button>
      </div>
      {selected && (
        <section aria-label="Chương lỗi tác vụ">
          <h3>Chương lỗi: {selected.name}</h3>
          <button onClick={() => setSelected(null)}>Đóng danh sách lỗi</button>
          {errors.map((c) => (
            <div key={c.id}>
              <span>
                {c.displayNumber || c.order} · {c.title} ·{" "}
                {c.error || "Đã tạm bỏ"} · thử {c.retries}
              </span>
              {[
                "retry",
                "pause",
                "cancel",
                ...(hasPermission(account, "manage") ? ["delete"] : []),
              ].map((a) => (
                <button
                  key={a}
                  disabled={busy}
                  onClick={() => {
                    if (
                      a === "delete" &&
                      !window.confirm(
                        "Xóa chương lỗi? Không đánh lại số chương.",
                      )
                    )
                      return;
                    setBusy(true);
                    void call("/download/chapters", {
                      method: "POST",
                      body: JSON.stringify({
                        id: selected.id,
                        chapter: c.id,
                        version:
                          books.find((b) => b.id === selected.id)?.version ||
                          selected.version,
                        action: a,
                      }),
                    })
                      .then(() => setTick((x) => x + 1))
                      .catch((e) => setError(e.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  {
                    {
                      retry: "Thử lại chương",
                      pause: "Tạm bỏ chương",
                      cancel: "Hủy chương",
                      delete: "Xóa chương",
                    }[a]
                  }
                </button>
              ))}
            </div>
          ))}
          <button
            disabled={!errorOffset}
            onClick={() => setErrorOffset((x) => Math.max(0, x - 100))}
          >
            Chương lỗi trước
          </button>
          <button
            disabled={errors.length < 100}
            onClick={() => setErrorOffset((x) => x + 100)}
          >
            Chương lỗi sau
          </button>
        </section>
      )}
      {hasPermission(account, "admin") && (
        <details>
          <summary>Cấu hình tải nền</summary>
          <button
            onClick={() =>
              void call("/settings/download")
                .then(setSettings)
                .catch((e) => setError(e.message))
            }
          >
            Đọc cấu hình tải
          </button>
          {settings && (
            <>
              <p>
                MAX_CONCURRENT giới hạn WEB; FILE_CONCURRENT giới hạn FILE
                riêng. AUTO_RESUME tắt: dừng sau một đợt, bấm Tiếp tục để chạy
                đợt kế.
              </p>
              {[
                "BATCH_SIZE",
                "DELAY_MS",
                "MAX_RETRY",
                "MAX_CONCURRENT",
                "FILE_CONCURRENT",
              ].map((k) => (
                <label key={k}>
                  {k}
                  <input
                    type="number"
                    aria-label={k}
                    value={settings[k]}
                    onChange={(e) =>
                      setSettings({ ...settings, [k]: Number(e.target.value) })
                    }
                  />
                </label>
              ))}
              <label>
                <input
                  type="checkbox"
                  checked={settings.AUTO_RESUME}
                  onChange={(e) =>
                    setSettings({ ...settings, AUTO_RESUME: e.target.checked })
                  }
                />
                Tự tiếp tục sau mỗi đợt
              </label>
              <button
                onClick={() =>
                  void call("/settings/download", {
                    method: "PUT",
                    body: JSON.stringify(settings),
                  })
                    .then(() => notify("Đã lưu cấu hình tải"))
                    .catch((e) => setError(e.message))
                }
              >
                Lưu cấu hình tải
              </button>
              <p>
                Cookie nguồn và thư mục gốc dùng cấu hình máy chủ; không gửi
                secret qua giao diện.
              </p>
            </>
          )}
        </details>
      )}
    </section>
  );
}
