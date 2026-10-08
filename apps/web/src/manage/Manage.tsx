import { useEffect, useRef, useState } from "react";
import type {
  ManagedBook,
  MetadataEdit,
} from "../../../../packages/contracts/src/management";
import { uploadFile, type Call } from "./upload";
import { Cover } from "../reader/Library";
import { Reader } from "../reader/Reader";
import {
  LibraryBook,
  type LibraryBook as ReaderBook,
} from "../../../../packages/contracts/src/index";
function guardChapterClose(fn: () => void) {
  if (
    window.dispatchEvent(
      new CustomEvent("book:close-editor", { cancelable: true, detail: fn }),
    )
  )
    fn();
}
type Props = {
  user: string;
  call: Call;
  asset: (path: string, init?: RequestInit) => Promise<Blob>;
  notify: (text: string) => void;
  canRead?: boolean;
};
export function Manage({ user, call, asset, notify, canRead = false }: Props) {
  const [selected, setSelected] = useState<ReaderBook | null>(null),
    [sort, setSort] = useState("name");
  const [books, setBooks] = useState<ManagedBook[]>([]),
    [q, query] = useState(""),
    [offset, page] = useState(0),
    [total, setTotal] = useState(0),
    [grid, setGrid] = useState(true),
    [drafts, setDrafts] = useState<Record<string, MetadataEdit>>({}),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false),
    [editor, setEditor] = useState<ManagedBook | null>(null),
    [importing, setImporting] = useState(false),
    [genres, setGenres] = useState<{ id: string; name: string }[]>([]),
    [jobs, setJobs] = useState<any[]>([]),
    [genreName, setGenreName] = useState(""),
    [deleting, setDeleting] = useState<ManagedBook | null>(null),
    [trash, setTrash] = useState(false),
    [leave, setLeave] = useState<(() => void) | null>(null);
  const revision = useRef(0),
    controller = useRef<AbortController | null>(null),
    draftRef = useRef(drafts),
    dialog = useRef<HTMLDialogElement>(null),
    deleteDialog = useRef<HTMLDialogElement>(null),
    leaveDialog = useRef<HTMLDialogElement>(null);
  draftRef.current = drafts;
  async function refresh() {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setLoading(true);
    try {
      const data = await call(
        "/manage/books?q=" +
          encodeURIComponent(q) +
          "&offset=" +
          offset +
          "&sort=" +
          sort,
        { signal: c.signal },
      );
      setBooks(data.books);
      setTotal(data.total);
      setError("");
    } catch (e) {
      if (!c.signal.aborted) setError((e as Error).message);
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 250);
    return () => {
      clearTimeout(timer);
      controller.current?.abort();
    };
  }, [call, q, offset, sort]);
  useEffect(() => {
    let active = true;
    const c = new AbortController();
    const poll = async () => {
      try {
        const [g, j] = await Promise.all([
          call("/manage/genres", { signal: c.signal }),
          call("/manage/jobs", { signal: c.signal }),
        ]);
        if (active) {
          setGenres(g);
          setJobs(j);
        }
      } catch (e) {
        if (active && !c.signal.aborted) setError((e as Error).message);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      c.abort();
      clearInterval(timer);
    };
  }, [call]);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (Object.keys(draftRef.current).length) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const navigate = (e: Event) => {
      if (Object.keys(draftRef.current).length) {
        e.preventDefault();
        setLeave(() => (e as CustomEvent).detail);
      }
    };
    window.addEventListener("beforeunload", unload);
    window.addEventListener("book:before-navigate", navigate);
    return () => {
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("book:before-navigate", navigate);
    };
  }, []);
  useEffect(() => {
    editor ? dialog.current?.showModal() : dialog.current?.close();
  }, [editor]);
  useEffect(() => {
    deleting
      ? deleteDialog.current?.showModal()
      : deleteDialog.current?.close();
  }, [deleting]);
  useEffect(() => {
    leave ? leaveDialog.current?.showModal() : leaveDialog.current?.close();
  }, [leave]);
  function edit(b: ManagedBook, patch: Partial<MetadataEdit>) {
    revision.current++;
    setDrafts((d) => ({
      ...d,
      [b.id]: {
        ...(d[b.id] || {
          id: b.id,
          version: b.version,
          name: b.name,
          author: b.author,
          genres: b.genres,
          visibility: b.visibility,
        }),
        ...patch,
      },
    }));
  }
  async function save() {
    if (saving) return;
    setSaving(true);
    const batch = Object.values(draftRef.current),
      version = revision.current;
    try {
      for (let i = 0; i < batch.length; i += 24) {
        const items = batch.slice(i, i + 24),
          result = await call("/manage/books", {
            method: "PUT",
            body: JSON.stringify({ items }),
          });
        setErrors((previous) => {
          const next = { ...previous };
          for (const r of result)
            if (r.ok) delete next[r.id];
            else next[r.id] = r.error;
          return next;
        });
        setDrafts((previous) => {
          const next = { ...previous };
          for (const r of result)
            if (r.ok) {
              const snapshot = items.find((x) => x.id === r.id)!;
              if (JSON.stringify(next[r.id]) === JSON.stringify(snapshot))
                delete next[r.id];
              else if (next[r.id])
                next[r.id] = { ...next[r.id], version: r.version };
            }
          return next;
        });
      }
      notify(
        version === revision.current
          ? "Đã lưu các mục hợp lệ; mục lỗi được giữ lại"
          : "Đã lưu; phần vừa sửa tiếp vẫn là bản nháp",
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function deleteBook() {
    if (!deleting || saving) return;
    setSaving(true);
    try {
      await call("/manage/books/" + deleting.id, {
        method: "DELETE",
        body: JSON.stringify({ version: deleting.version, trash }),
      });
      setDrafts((d) => {
        const n = { ...d };
        delete n[deleting.id];
        return n;
      });
      setDeleting(null);
      notify("Đã xóa truyện");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  if (selected)
    return (
      <Reader
        user={user}
        initialBook={selected}
        call={call}
        notify={notify}
        back={() => {
          setSelected(null);
          void refresh();
        }}
      />
    );
  return (
    <div className="management">
      <h1>Quản lý sách</h1>
      <div className="toolbar">
        <label>
          Tìm truyện
          <input
            value={q}
            onChange={(e) => {
              query(e.target.value);
              page(0);
            }}
          />
        </label>
        <label>
          Sắp xếp
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              page(0);
            }}
          >
            <option value="name">Tên truyện</option>
            <option value="author">Tác giả</option>
            <option value="updated">Mới cập nhật</option>
          </select>
        </label>
        <button onClick={() => setGrid(!grid)}>{grid ? "Bảng" : "Lưới"}</button>
        <button onClick={() => setImporting(!importing)}>Thêm truyện</button>
        <button
          disabled={saving || !Object.keys(drafts).length}
          onClick={() => void save()}
        >
          Lưu tất cả ({Object.keys(drafts).length})
        </button>
        <button
          disabled={saving || !Object.keys(drafts).length}
          onClick={() => {
            setDrafts({});
            setErrors({});
            notify("Đã hủy bản nháp; ảnh chưa dùng sẽ được dọn");
          }}
        >
          Hủy bản nháp
        </button>
      </div>
      {error && (
        <p role="alert">
          {error} <button onClick={() => void refresh()}>Thử lại</button>
        </p>
      )}
      {loading && <p role="status">Đang tải thư viện…</p>}
      {importing && (
        <ImportForm
          call={call}
          notify={notify}
          done={() => {
            setImporting(false);
            void refresh();
          }}
        />
      )}
      <div className={grid ? "manage-grid" : "manage-table"}>
        {books.map((b) => {
          const d = drafts[b.id];
          return (
            <article
              key={b.id}
              className={"managed-book" + (d ? " pending" : "")}
            >
              <Cover book={b} asset={asset} management />
              <h2>{d?.name || b.name}</h2>
              <p>{d?.author ?? b.author}</p>
              <p>{(d?.genres || b.genres).join(", ") || "Chưa phân loại"}</p>
              <p>
                {b.done}/{b.total} chương · {b.status} ·{" "}
                {b.visibility === "published" ? "Đã xuất bản" : "Đang ẩn"}
              </p>
              <p>
                Đồng bộ:{" "}
                {b.sync === "pending"
                  ? "Đang chờ"
                  : b.sync === "error"
                    ? "Lỗi"
                    : "Đã xong"}
                {d && " · Chưa lưu"}
              </p>
              {errors[b.id] && <p role="alert">{errors[b.id]}</p>}
              <button onClick={() => setEditor(b)}>Sửa {b.name}</button>
              {b.progress && (
                <p>
                  Đang đọc chương {b.progress.index} ·{" "}
                  {Math.round(b.progress.ratio * 100)}%
                </p>
              )}
              {canRead && b.visibility === "published" && b.done > 0 && (
                <button
                  onClick={() =>
                    void call("/books/" + b.id)
                      .then((v) => setSelected(LibraryBook.parse(v)))
                      .catch((e) => setError(e.message))
                  }
                >
                  {b.progress ? "Đọc tiếp" : "Đọc truyện"}
                </button>
              )}
              <button
                onClick={() => {
                  setDeleting(b);
                  setTrash(false);
                }}
              >
                Xóa
              </button>
              {b.sync === "error" && (
                <button
                  onClick={() =>
                    void call("/manage/books/" + b.id + "/sync-retry", {
                      method: "POST",
                      body: JSON.stringify({ version: b.version }),
                    })
                      .then(refresh)
                      .catch((e) => setError(e.message))
                  }
                >
                  Thử đồng bộ lại
                </button>
              )}
            </article>
          );
        })}
      </div>
      {!loading && !books.length && <p>Chưa có truyện phù hợp.</p>}
      <div className="toolbar">
        <button
          disabled={!offset}
          onClick={() => page(Math.max(0, offset - 24))}
        >
          Trang trước
        </button>
        <span>
          {total} truyện · Trang {Math.floor(offset / 24) + 1}
        </span>
        <button
          disabled={offset + 24 >= total}
          onClick={() => page(offset + 24)}
        >
          Trang sau
        </button>
      </div>
      <details>
        <summary>Danh mục thể loại</summary>
        <p>
          Thể loại đầu tiên trong truyện là thể loại chính. Bỏ danh mục vẫn giữ
          thể loại đã gắn vào truyện.
        </p>
        <input
          aria-label="Tên thể loại"
          value={genreName}
          onChange={(e) => setGenreName(e.target.value)}
        />
        <button
          onClick={() =>
            void call("/manage/genres", {
              method: "POST",
              body: JSON.stringify({ name: genreName }),
            })
              .then(() => {
                setGenreName("");
                return call("/manage/genres");
              })
              .then(setGenres)
              .catch((e) => setError(e.message))
          }
        >
          Thêm thể loại
        </button>
        <button
          onClick={() =>
            void call("/manage/genres/import", { method: "POST" })
              .then(() => call("/manage/genres"))
              .then(setGenres)
          }
        >
          Nhập danh mục từ sách
        </button>
        {genres.map((g) => (
          <p key={g.id}>
            {g.name}{" "}
            <button
              onClick={() =>
                void call("/manage/genres/" + g.id, { method: "DELETE" }).then(
                  () => setGenres((list) => list.filter((x) => x.id !== g.id)),
                )
              }
            >
              Bỏ danh mục {g.name}
            </button>
          </p>
        ))}
      </details>
      <details open={jobs.some((j) => j.status !== "done")}>
        <summary>Tác vụ nhập</summary>
        {jobs.map((j) => (
          <p key={j.id}>
            {j.status} {j.error || ""}{" "}
            {j.result &&
              `Đã nhận ${j.result.found ?? 1} chương; bỏ qua ${j.result.skipped ?? 0}, thừa ${j.result.extra ?? 0}`}
            {j.status === "failed" && (
              <button
                onClick={() =>
                  void call("/manage/jobs/" + j.id + "/retry", {
                    method: "POST",
                  })
                }
              >
                Thử lại
              </button>
            )}
          </p>
        ))}
      </details>
      <dialog
        ref={dialog}
        onCancel={(e) => {
          e.preventDefault();
          guardChapterClose(() => setEditor(null));
        }}
        aria-label="Sửa truyện"
      >
        {editor && (
          <BookEditor
            key={editor.id}
            book={editor}
            draft={drafts[editor.id]}
            call={call}
            asset={asset}
            edit={(patch) => edit(editor, patch)}
            notify={notify}
            done={() => {
              setEditor(null);
              void refresh();
            }}
          />
        )}
      </dialog>
      <dialog
        ref={deleteDialog}
        onCancel={() => setDeleting(null)}
        aria-label="Xác nhận xóa truyện"
      >
        <h2>Xóa {deleting?.name}?</h2>
        <label>
          <input
            type="checkbox"
            checked={trash}
            onChange={(e) => setTrash(e.target.checked)}
          />
          Đưa thư mục Drive vào thùng rác
        </label>
        <div className="toolbar">
          <button autoFocus onClick={() => setDeleting(null)}>
            Hủy
          </button>
          <button disabled={saving} onClick={() => void deleteBook()}>
            Xác nhận xóa
          </button>
        </div>
      </dialog>
      <dialog
        ref={leaveDialog}
        onCancel={() => setLeave(null)}
        aria-label="Bản nháp chưa lưu"
      >
        <p>Còn bản nháp chưa lưu. Rời trang sẽ bỏ bản nháp.</p>
        <button autoFocus onClick={() => setLeave(null)}>
          Ở lại
        </button>
        <button
          onClick={() => {
            const fn = leave;
            setLeave(null);
            setDrafts({});
            fn?.();
          }}
        >
          Bỏ bản nháp và rời trang
        </button>
      </dialog>
    </div>
  );
}
function BookEditor({
  book: b,
  draft: d,
  call,
  asset,
  edit,
  notify,
  done,
}: {
  book: ManagedBook;
  draft?: MetadataEdit;
  call: Call;
  asset: Props["asset"];
  edit: (patch: Partial<MetadataEdit>) => void;
  notify: Props["notify"];
  done: () => void;
}) {
  const [chapters, setChapters] = useState<any[]>([]),
    [groups, setGroups] = useState<any[]>([]),
    [offset, page] = useState(0),
    [error, setError] = useState(""),
    [preview, setPreview] = useState(""),
    [busy, setBusy] = useState(false),
    [adding, setAdding] = useState(false),
    [ask, setAsk] = useState<any | null>(null),
    [current, setCurrent] = useState(b);
  const abort = useRef(new AbortController()),
    objectUrl = useRef(""),
    confirm = useRef<HTMLDialogElement>(null);
  async function load() {
    const data = await call(
      "/manage/books/" + b.id + "/chapters?offset=" + offset,
      { signal: abort.current.signal },
    );
    setChapters(data.chapters);
    setGroups(data.groups);
    setCurrent(data.book);
  }
  useEffect(() => {
    const c = new AbortController();
    abort.current = c;
    void load().catch((e) => {
      if (!c.signal.aborted) setError(e.message);
    });
    return () => {
      c.abort();
    };
  }, [call, b.id, offset]);
  useEffect(() => {
    const path =
      d?.coverAsset === null
        ? null
        : d?.coverAsset
          ? "/manage/assets/" + d.coverAsset
          : b.hasCover
            ? "/manage/books/" + b.id + "/cover"
            : null;
    setPreview("");
    if (!path) return;
    const c = new AbortController();
    let active = true,
      object = "";
    void asset(path, { signal: c.signal })
      .then((blob) => {
        if (active) {
          object = URL.createObjectURL(blob);
          objectUrl.current = object;
          setPreview(object);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
      c.abort();
      if (object) URL.revokeObjectURL(object);
    };
  }, [asset, b.id, b.version, b.hasCover, d?.coverAsset]);
  useEffect(() => {
    ask ? confirm.current?.showModal() : confirm.current?.close();
  }, [ask]);
  async function cover(file: File) {
    setBusy(true);
    try {
      const id = await uploadFile(call, file, "cover", abort.current.signal),
        a = await call("/manage/uploads/" + id + "/cover", {
          method: "POST",
          signal: abort.current.signal,
        });
      edit({ coverAsset: a.id });
    } catch (e) {
      if (!abort.current.signal.aborted) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function action(c: any, action: string, patch = {}) {
    setBusy(true);
    try {
      await call("/manage/books/" + b.id + "/chapters/" + c.id, {
        method: "PUT",
        signal: abort.current.signal,
        body: JSON.stringify({ version: current.version, action, ...patch }),
      });
      await load();
      notify("Đã cập nhật chương");
      setAsk(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h2>Sửa truyện</h2>
      <label>
        Tên truyện
        <input
          value={d?.name ?? b.name}
          onChange={(e) => edit({ name: e.target.value })}
        />
      </label>
      <label>
        Tác giả
        <input
          value={d?.author ?? b.author}
          onChange={(e) => edit({ author: e.target.value })}
        />
      </label>
      <label>
        Thể loại (thể loại chính trước)
        <input
          defaultValue={(d?.genres || b.genres).join(", ")}
          onBlur={(e) =>
            edit({
              genres: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
      <label>
        Xuất bản
        <select
          value={d?.visibility || b.visibility}
          onChange={(e) =>
            edit({ visibility: e.target.value as MetadataEdit["visibility"] })
          }
        >
          <option value="hidden">Ẩn</option>
          <option value="published">Xuất bản</option>
        </select>
      </label>
      <fieldset>
        <legend>Ảnh bìa sách</legend>
        {preview && (
          <img
            className="cover-preview"
            src={preview}
            alt="Xem trước bìa sách"
          />
        )}
        <input
          aria-label="Chọn ảnh bìa"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void cover(f);
          }}
        />
        <button
          disabled={busy}
          onClick={() => {
            edit({ coverAsset: null });
            setPreview("");
            URL.revokeObjectURL(objectUrl.current);
          }}
        >
          Xóa ảnh bìa
        </button>
        <p>JPEG/PNG/WebP ≤ 5 MB. Bìa thay đổi khi Lưu tất cả.</p>
      </fieldset>
      <button onClick={() => guardChapterClose(() => setAdding(!adding))}>
        Thêm chương
      </button>
      {adding && (
        <AddChapter
          groups={groups}
          book={current}
          call={call}
          notify={notify}
          done={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>Danh sách chương ({current.total})</summary>
        {chapters.map((c) => (
          <div className="chapter-edit" key={c.id}>
            <span>
              {[
                c.part,
                c.volume,
                c.displayNumber || c.order,
                c.title,
                c.status,
                c.error,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <input
              aria-label={"Tiêu đề " + c.id}
              defaultValue={c.title}
              onBlur={(e) => {
                if (e.target.value !== c.title)
                  void action(c, "edit", { title: e.target.value, url: c.url });
              }}
            />
            <input
              aria-label={"URL " + c.id}
              defaultValue={c.url}
              onBlur={(e) => {
                if (e.target.value !== c.url)
                  void action(c, "edit", {
                    title: c.title,
                    url: e.target.value,
                  });
              }}
            />
            {c.status !== "DONE" &&
              ["retry", "pause", "cancel"].map((a) => (
                <button
                  disabled={busy}
                  key={a}
                  onClick={() => void action(c, a)}
                >
                  {a === "retry"
                    ? "Thử lại"
                    : a === "pause"
                      ? "Tạm dừng"
                      : "Hủy tải"}
                </button>
              ))}
            <button disabled={busy} onClick={() => setAsk(c)}>
              Xóa chương
            </button>
          </div>
        ))}
        <button
          disabled={!offset}
          onClick={() => page(Math.max(0, offset - 200))}
        >
          200 chương trước
        </button>
        <button
          disabled={offset + 200 >= current.total}
          onClick={() => page(offset + 200)}
        >
          200 chương sau
        </button>
      </details>
      <button disabled={busy} onClick={() => guardChapterClose(done)}>
        Đóng — giữ bản nháp
      </button>
      <dialog
        ref={confirm}
        onCancel={() => setAsk(null)}
        aria-label="Xóa chương"
      >
        <p>
          Xóa chương {ask?.title}? Số hiệu các chương còn lại được giữ nguyên.
        </p>
        <button autoFocus onClick={() => setAsk(null)}>
          Hủy
        </button>
        <button disabled={busy} onClick={() => void action(ask, "delete")}>
          Xác nhận xóa chương
        </button>
      </dialog>
    </>
  );
}
function ImportForm({
  call,
  notify,
  done,
}: {
  call: Call;
  notify: Props["notify"];
  done: () => void;
}) {
  const [kind, setKind] = useState("file"),
    [name, setName] = useState(""),
    [author, setAuthor] = useState(""),
    [genres, setGenres] = useState(""),
    [folder, setFolder] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [toc, setToc] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [progress, setProgress] = useState(0);
  const controller = useRef(new AbortController());
  useEffect(() => {
    controller.current = new AbortController();
    return () => controller.current.abort();
  }, []);
  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      const request: any = {
        name,
        author,
        genres: genres
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      };
      if (kind === "folder") request.folder = folder;
      else {
        if (!file) throw Error("Chọn file truyện");
        request.upload = await uploadFile(
          call,
          file,
          "import",
          controller.current.signal,
          setProgress,
        );
        if (kind === "pair") {
          if (!toc) throw Error("Chọn file mục lục");
          request.toc = await uploadFile(
            call,
            toc,
            "toc",
            controller.current.signal,
            setProgress,
          );
        }
      }
      await call("/manage/imports", {
        method: "POST",
        body: JSON.stringify(request),
        signal: controller.current.signal,
      });
      notify("Đã nhận tác vụ nhập; tiến độ sẽ hiện trong Tác vụ nhập");
      done();
    } catch (e) {
      if (!controller.current.signal.aborted) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset>
      <legend>Thêm truyện</legend>
      <label>
        Kiểu nhập
        <select
          value={kind}
          disabled={busy}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="file">Một file</option>
          <option value="pair">Mục lục + truyện</option>
          <option value="folder">Thư mục Drive</option>
        </select>
      </label>
      <label>
        Tên truyện
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Tác giả
        <input value={author} onChange={(e) => setAuthor(e.target.value)} />
      </label>
      <label>
        Thể loại
        <input value={genres} onChange={(e) => setGenres(e.target.value)} />
      </label>
      {kind === "folder" ? (
        <label>
          Link hoặc ID thư mục
          <input value={folder} onChange={(e) => setFolder(e.target.value)} />
        </label>
      ) : (
        <>
          <label>
            File truyện
            <input
              type="file"
              accept=".txt,.md,.markdown,.csv"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </label>
          {kind === "pair" && (
            <label>
              File mục lục
              <input
                type="file"
                accept=".txt,.md,.markdown"
                onChange={(e) => setToc(e.target.files?.[0] || null)}
              />
            </label>
          )}
        </>
      )}
      <p>
        File nhập tối đa 64 MiB, truyền theo từng phần. Cặp file dùng #@, ##@,
        ###@, @ và 00.
      </p>
      {busy && <p role="status">Đang upload {progress}%</p>}
      {error && <p role="alert">{error}</p>}
      <button disabled={busy} onClick={() => void submit()}>
        Nhập truyện
      </button>
      <button disabled={busy} onClick={done}>
        Hủy
      </button>
    </fieldset>
  );
}
function AddChapter({
  book,
  call,
  notify,
  done,
  groups,
}: {
  groups: any[];
  book: ManagedBook;
  call: Call;
  notify: Props["notify"];
  done: () => void;
}) {
  const [kind, setKind] = useState("paste"),
    [order, setOrder] = useState(""),
    [title, setTitle] = useState(""),
    [part, setPart] = useState(""),
    [volume, setVolume] = useState(""),
    [newPart, setNewPart] = useState(false),
    [newVolume, setNewVolume] = useState(false),
    [text, setText] = useState(""),
    [url, setUrl] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const closeDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    leaving ? closeDialog.current?.showModal() : closeDialog.current?.close();
  }, [leaving]);
  useEffect(() => {
    const close = (e: Event) => {
      if (text || url || title || order || file) {
        e.preventDefault();
        setLeaving(() => (e as CustomEvent).detail);
      }
    };
    window.addEventListener("book:close-editor", close);
    return () => window.removeEventListener("book:close-editor", close);
  }, [text, url, title, order, file]);
  const controller = useRef(new AbortController());
  useEffect(() => {
    controller.current = new AbortController();
    return () => controller.current.abort();
  }, []);
  useEffect(() => {
    const fn = (e: BeforeUnloadEvent) => {
      if (text || url || title) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", fn);
    return () => window.removeEventListener("beforeunload", fn);
  }, [text, url, title]);
  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      const value: any = {
        version: book.version,
        kind,
        order: Number(order),
        title,
        part,
        volume,
        newPart,
        newVolume,
      };
      if (kind === "link") value.url = url;
      else if (kind === "paste") value.text = text;
      else {
        if (!file) throw Error("Chọn file chương");
        value.upload = await uploadFile(
          call,
          file,
          "chapter",
          controller.current.signal,
        );
      }
      await call("/manage/books/" + book.id + "/chapters", {
        method: "POST",
        body: JSON.stringify(value),
        signal: controller.current.signal,
      });
      notify("Đã nhận chương; tác vụ nhập sẽ tạo file");
      done();
    } catch (e) {
      if (!controller.current.signal.aborted) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset>
      <legend>Thêm chương</legend>
      <label>
        Kiểu
        <select
          aria-label="Kiểu"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="paste">Dán nội dung</option>
          <option value="file">File TXT/MD (≤ 2 MB)</option>
          {book.sourceType !== "FILE" && <option value="link">Link</option>}
        </select>
      </label>
      <label>
        Thứ tự chương
        <input
          type="number"
          min="1"
          max="99999"
          value={order}
          onChange={(e) => setOrder(e.target.value)}
        />
      </label>
      <label>
        Tiêu đề
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Phần
        <input
          list="chapter-parts"
          value={part}
          onChange={(e) => setPart(e.target.value)}
        />
        <datalist id="chapter-parts">
          {groups
            .filter((g) => g.kind === "PART")
            .map((g) => (
              <option key={g.id} value={g.name} />
            ))}
        </datalist>
      </label>
      <label>
        <input
          type="checkbox"
          checked={newPart}
          onChange={(e) => setNewPart(e.target.checked)}
        />
        Tạo Phần mới
      </label>
      <label>
        Quyển
        <input
          list="chapter-volumes"
          value={volume}
          onChange={(e) => setVolume(e.target.value)}
        />
        <datalist id="chapter-volumes">
          {groups
            .filter((g) => g.kind === "VOLUME")
            .map((g) => (
              <option key={g.id} value={g.name} />
            ))}
        </datalist>
      </label>
      <label>
        <input
          type="checkbox"
          checked={newVolume}
          onChange={(e) => setNewVolume(e.target.checked)}
        />
        Tạo Quyển mới
      </label>
      {kind === "link" ? (
        <label>
          Link chương
          <input value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
      ) : kind === "paste" ? (
        <label>
          Nội dung
          <textarea
            aria-label="Nội dung"
            maxLength={300000}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
      ) : (
        <input
          aria-label="File chương"
          type="file"
          accept=".txt,.md,.markdown"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
      )}
      <p>
        Nội dung chủ động thêm ngắn vẫn được nhận; tối đa 300000 ký tự. Chọn
        đúng Phần/Quyển của truyện.
      </p>
      {error && <p role="alert">{error}</p>}
      <button disabled={busy} onClick={() => void submit()}>
        Gửi chương
      </button>
      <button disabled={busy} onClick={() => guardChapterClose(done)}>
        Hủy thêm chương
      </button>
      <dialog
        ref={closeDialog}
        onCancel={() => setLeaving(null)}
        aria-label="Nội dung chương chưa gửi"
      >
        <p>Nội dung chương chưa được gửi. Bỏ nội dung đang nhập?</p>
        <button autoFocus onClick={() => setLeaving(null)}>
          Tiếp tục nhập
        </button>
        <button
          onClick={() => {
            const fn = leaving;
            setLeaving(null);
            fn?.();
          }}
        >
          Bỏ nội dung
        </button>
      </dialog>
    </fieldset>
  );
}
