import React, { useEffect, useState } from "react";
import { z } from "zod";
const Status = z.object({
  maintenance: z.boolean(),
  rootId: z.string().nullable(),
  revision: z.number(),
  alerts: z.record(z.string(), z.number()),
});
export function Operations({
  call,
  notify,
}: {
  call: (path: string, init?: RequestInit) => Promise<unknown>;
  notify: (message: string) => void;
}) {
  const [state, setState] = useState<z.infer<typeof Status> | null>(null),
    [busy, setBusy] = useState(false),
    [kind, setKind] = useState("register"),
    [id, setId] = useState(""),
    [name, setName] = useState("");
  const labels: Record<string, string> = {
    expiredLeases: "Tác vụ hết lượt xử lý",
    stuckJobs: "Tác vụ chờ quá lâu",
    failedJobs: "Tác vụ lỗi",
    failedSync: "File đồng bộ lỗi",
    migrationReview: "Sách chờ đối soát",
  };
  async function load() {
    try {
      setState(Status.parse(await call("/admin/operations")));
    } catch (e) {
      notify(
        e instanceof Error ? e.message : "Không tải được trạng thái vận hành",
      );
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function act(path: string, input: unknown) {
    setBusy(true);
    try {
      await call(path, { method: "PUT", body: JSON.stringify(input) });
      await load();
      notify("Đã cập nhật");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Không thực hiện được thao tác");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Vận hành thư viện">
      <h2>Vận hành thư viện</h2>
      <button disabled={busy} onClick={() => void load()}>
        Làm mới vận hành
      </button>
      {state && (
        <>
          <p>
            Bảo trì:{" "}
            <strong>{state.maintenance ? "Đang bật" : "Đang tắt"}</strong>
          </p>
          <p>
            Khi bảo trì, thay đổi thư viện và tác vụ tải tạm dừng. Người dùng
            vẫn đọc được sách đã xuất bản.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act("/admin/operations", { enabled: !state.maintenance })
            }
          >
            {state.maintenance ? "Tắt bảo trì" : "Bật bảo trì"}
          </button>
          <p>
            Thư mục lưu sách: {state.rootId || "Chưa đăng ký trong ứng dụng"}
          </p>
          <fieldset disabled={busy || !state.maintenance}>
            <legend>Thư mục Drive</legend>
            <label>
              Thao tác{" "}
              <select
                aria-label="Thao tác"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="register">Đăng ký thư mục có sẵn</option>
                <option value="create">Tạo thư mục mới</option>
              </select>
            </label>
            <label>
              {kind === "create" ? "ID thư mục cha" : "ID thư mục"}
              <input value={id} onChange={(e) => setId(e.target.value)} />
            </label>
            {kind === "create" && (
              <label>
                Tên thư mục mới
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
            )}
            <button
              onClick={() =>
                void act("/drive/root", {
                  requestId: crypto.randomUUID(),
                  revision: state.revision,
                  kind,
                  id,
                  name: kind === "create" ? name : undefined,
                })
              }
            >
              Lưu thư mục
            </button>
          </fieldset>
          <p>
            Bật bảo trì trước khi cấu hình thư mục. Thư viện đã có sách giữ
            nguyên thư mục gốc; chuyển thư mục cần đối soát riêng.
          </p>
          <ul>
            {Object.entries(state.alerts).map(([key, count]) => (
              <li key={key}>
                {labels[key] || key}: {count}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
