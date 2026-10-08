import { useEffect, useRef, useState } from "react";
import type { Account } from "../../../../packages/contracts/src/index";
import { hasPermission } from "../../../../packages/contracts/src/index";
import type { Call } from "../manage/upload";
export function Download({
  account,
  call,
  notify,
}: {
  account: Account;
  call: Call;
  notify: (text: string) => void;
}) {
  const [input, setInput] = useState(""),
    [mode, setMode] = useState("auto"),
    [total, setTotal] = useState(1),
    [name, setName] = useState(""),
    [jobs, setJobs] = useState<any[]>([]),
    [pending, setPending] = useState<any[]>([]),
    [error, setError] = useState(""),
    [genres, setGenres] = useState(""),
    [settings, setSettings] = useState<any | null>(null);
  const controller = useRef(new AbortController()),
    submissions = useRef(new Set<string>()),
    generation = useRef(0);
  useEffect(() => {
    const c = new AbortController();
    controller.current = c;
    const n = ++generation.current;
    async function poll() {
      try {
        const data = await call("/analysis", { signal: c.signal });
        if (n === generation.current) {
          setJobs(data.jobs);
          setError("");
        }
      } catch (e) {
        if (!c.signal.aborted) setError((e as Error).message);
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      c.abort();
      clearInterval(timer);
      generation.current++;
    };
  }, [call]);
  async function submit() {
    const urls = [
      ...new Set(
        input
          .split(/[;\n]+/)
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    ];
    if (!urls.length) return;
    try {
      for (const raw of urls) {
        const u = new URL(raw);
        if (!["http:", "https:"].includes(u.protocol)) throw Error();
      }
    } catch {
      setError(
        "URL phải bắt đầu bằng http:// hoặc https://; dữ liệu được giữ trong ô nhập",
      );
      return;
    }
    const fresh = urls.filter((u) => !submissions.current.has(u));
    if (!fresh.length) return;
    fresh.forEach((u) => submissions.current.add(u));
    setInput("");
    setPending((p) => [
      ...p,
      ...fresh.map((url) => ({
        url,
        id: "pending:" + url,
        status: "submitting",
      })),
    ]);
    try {
      await call("/analysis", {
        method: "POST",
        body: JSON.stringify({
          urls: fresh,
          mode,
          ...(mode === "manual" ? { total, name } : {}),
        }),
        signal: controller.current.signal,
      });
      const data = await call("/analysis", {
        signal: controller.current.signal,
      });
      setJobs(data.jobs);
      notify("Đã vào hàng phân tích; truyện ANALYZED chưa tự tải");
    } catch (e) {
      if (!controller.current.signal.aborted) {
        setInput((previous) => [previous, ...fresh].filter(Boolean).join("\n"));
        setError((e as Error).message);
      }
    } finally {
      fresh.forEach((u) => submissions.current.delete(u));
      setPending((p) => p.filter((x) => !fresh.includes(x.url)));
    }
  }
  async function action(j: any, action: string) {
    try {
      await call("/analysis/actions", {
        method: "POST",
        body: JSON.stringify({ id: j.id, action }),
        signal: controller.current.signal,
      });
      setJobs(
        (await call("/analysis", { signal: controller.current.signal })).jobs,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function save(j: any, field: string, value: string) {
    if (!j.book) return;
    try {
      const b = j.book,
        result = await call("/analysis/books", {
          method: "PUT",
          body: JSON.stringify({
            id: b.id,
            version: b.version,
            name: b.name,
            author: b.author,
            genres: b.genres,
            visibility: b.visibility,
            [field]:
              field === "genres"
                ? value
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean)
                : value,
          }),
          signal: controller.current.signal,
        });
      if (!result[0]?.ok) throw Error(result[0]?.error || "Không lưu được");
      setJobs(
        (await call("/analysis", { signal: controller.current.signal })).jobs,
      );
      notify("Đã lưu ngay thông tin truyện");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="download">
      <h1>Tải sách</h1>
      <label>
        Chế độ phân tích
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="auto">Tự động</option>
          <option value="manual">Thủ công</option>
        </select>
      </label>
      {mode === "manual" && (
        <>
          <label>
            Tên truyện
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Tổng chương
            <input
              type="number"
              min="1"
              max="20000"
              value={total}
              onChange={(e) => setTotal(Number(e.target.value))}
            />
          </label>
        </>
      )}
      <label>
        {mode === "manual"
          ? "Link chương mẫu"
          : "URL truyện (mỗi dòng hoặc ngăn bằng ;)"}
        <textarea value={input} onChange={(e) => setInput(e.target.value)} />
      </label>
      <button onClick={() => void submit()}>Thêm URL và phân tích</button>
      {error && <p role="alert">{error}</p>}
      <div className="table-wrap">
        <table>
          <caption>Bảng phân tích truyện</caption>
          <thead>
            <tr>
              {[
                "STT",
                "Tên truyện",
                "Tác giả",
                "Thể loại",
                "URL",
                "Thư mục",
                "Trạng thái",
                "Thao tác",
              ].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...jobs, ...pending].map((j, i) => (
              <tr key={j.id}>
                <td>{i + 1}</td>
                <td>
                  {j.book && hasPermission(account, "manage") ? (
                    <input
                      aria-label={"Tên " + j.book.name}
                      defaultValue={j.book.name}
                      key={j.book.name}
                      onBlur={(e) => {
                        if (e.target.value !== j.book.name)
                          void save(j, "name", e.target.value);
                      }}
                    />
                  ) : (
                    j.book?.name || "—"
                  )}
                </td>
                <td>
                  {j.book && hasPermission(account, "manage") ? (
                    <input
                      aria-label={"Tác giả " + j.book.name}
                      defaultValue={j.book.author}
                      key={j.book.author}
                      onBlur={(e) => {
                        if (e.target.value !== j.book.author)
                          void save(j, "author", e.target.value);
                      }}
                    />
                  ) : (
                    j.book?.author || "—"
                  )}
                </td>
                <td>
                  {j.book && hasPermission(account, "manage") ? (
                    <input
                      aria-label={"Thể loại " + j.book.name}
                      defaultValue={j.book.genres.join(", ")}
                      key={j.book.genres.join(", ")}
                      onBlur={(e) => {
                        if (e.target.value !== j.book.genres.join(", "))
                          void save(j, "genres", e.target.value);
                      }}
                    />
                  ) : (
                    j.book?.genres.join(", ") || "—"
                  )}
                </td>
                <td>
                  <a
                    href={/^https?:\/\//i.test(j.url) ? j.url : undefined}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {j.url}
                  </a>
                </td>
                <td>
                  {j.book?.folderId && (
                    <a
                      href={
                        "https://drive.google.com/drive/folders/" +
                        encodeURIComponent(j.book.folderId)
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      Mở thư mục
                    </a>
                  )}
                </td>
                <td>
                  {j.status === "submitting"
                    ? "Chờ xác nhận"
                    : j.status === "queued"
                      ? "Chờ phân tích"
                      : j.status === "running"
                        ? "Đang phân tích"
                        : j.status === "failed"
                          ? "Lỗi"
                          : j.book?.status || j.status}
                  {j.error && <p>{j.error}</p>}
                </td>
                <td>
                  {j.status !== "submitting" && (
                    <>
                      {["failed", "done"].includes(j.status) && (
                        <button onClick={() => void action(j, "retry")}>
                          Phân tích lại
                        </button>
                      )}
                      <button onClick={() => void action(j, "drop")}>Bỏ</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!jobs.length && !pending.length && <p>Chưa có URL phân tích.</p>}
      {hasPermission(account, "manage") && (
        <fieldset>
          <legend>Gán thể loại cho tất cả truyện ANALYZED</legend>
          <input
            aria-label="Thể loại hàng loạt"
            value={genres}
            onChange={(e) => setGenres(e.target.value)}
          />
          <button
            onClick={() =>
              void call("/analysis/genres", {
                method: "PUT",
                body: JSON.stringify({
                  genres: genres
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                }),
              })
                .then((result) =>
                  notify(
                    `Đã cập nhật ${result.filter((r: any) => r.ok).length} truyện; lỗi ${result.filter((r: any) => !r.ok).length}`,
                  ),
                )
                .catch((e) => setError(e.message))
            }
          >
            Gán thể loại cả bảng
          </button>
        </fieldset>
      )}
      {hasPermission(account, "admin") && (
        <details>
          <summary>Cấu hình phân tích</summary>
          <button
            onClick={() =>
              void call("/settings/analysis")
                .then(setSettings)
                .catch((e) => setError(e.message))
            }
          >
            Đọc cấu hình
          </button>
          {settings && (
            <>
              <label>
                SITE_RULES
                <textarea
                  value={settings.SITE_RULES}
                  maxLength={2000}
                  onChange={(e) =>
                    setSettings({ ...settings, SITE_RULES: e.target.value })
                  }
                />
              </label>
              <label>
                JUNK_WORDS
                <textarea
                  value={settings.JUNK_WORDS}
                  onChange={(e) =>
                    setSettings({ ...settings, JUNK_WORDS: e.target.value })
                  }
                />
              </label>
              <label>
                DELAY_MS
                <input
                  type="number"
                  value={settings.DELAY_MS}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      DELAY_MS: Number(e.target.value),
                    })
                  }
                />
              </label>
              <button
                onClick={() =>
                  void call("/settings/analysis", {
                    method: "PUT",
                    body: JSON.stringify(settings),
                  })
                    .then(() => notify("Đã lưu cấu hình"))
                    .catch((e) => setError(e.message))
                }
              >
                Lưu cấu hình
              </button>
            </>
          )}
        </details>
      )}
      <p>Chuyển xuống tải và giám sát tải nền sẽ triển khai ở Phase 7.</p>
    </div>
  );
}
