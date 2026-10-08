import React, { useEffect, useRef, useState } from "react";
import { Operations } from "./Operations";
import {
  AdminUser,
  hasPermission,
  type Account,
  type Permission,
} from "../../../packages/contracts/src/index";
const permissions: Permission[] = ["read", "download", "manage", "admin"];
const labels = {
  read: "Đọc sách",
  download: "Tải sách",
  manage: "Quản lý sách",
  admin: "Quản trị",
};
export function Admin({
  account,
  call,
  notify,
}: {
  account: Account;
  call: (path: string, init?: RequestInit) => Promise<unknown>;
  notify: (message: string) => void;
}) {
  const alive = useRef(true);
  const [operations, setOperations] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  async function load(after: string | null = null) {
    setBusy(true);
    try {
      const value = AdminUser.array().parse(
        await call("/admin/users" + (after ? "?after=" + after : "")),
      );
      if (alive.current) {
        setUsers(value);
        setCursor(value.length === 50 ? value.at(-1)!.id : null);
      }
    } catch (e) {
      if (alive.current)
        notify(e instanceof Error ? e.message : "Không tải được tài khoản");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, []);
  async function save(user: AdminUser) {
    setBusy(true);
    try {
      await call("/admin/users/" + user.id, {
        method: "PUT",
        body: JSON.stringify({
          permissions: user.permissions,
          status: user.status,
        }),
      });
      if (alive.current) {
        notify("Đã cập nhật tài khoản");
        await load();
      }
    } catch (e) {
      if (alive.current)
        notify(e instanceof Error ? e.message : "Không lưu được tài khoản");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  if (!hasPermission(account, "admin")) return null;
  return (
    <>
      <h1>Quản trị</h1>
      <button
        aria-expanded={operations}
        onClick={() => setOperations((v) => !v)}
      >
        Vận hành
      </button>
      {operations && <Operations call={call} notify={notify} />}
      <p>
        Cấp quyền độc lập cho từng tài khoản. Không thể khóa hoặc bỏ quyền của
        quản trị viên cuối cùng.
      </p>
      <div className="accounts">
        {users.map((user) => (
          <fieldset key={user.id} disabled={busy}>
            <legend>{user.name || user.email || user.id}</legend>
            <p>{user.email}</p>
            <div className="permissions">
              {permissions.map((permission) => (
                <label key={permission}>
                  <input
                    type="checkbox"
                    checked={user.permissions.includes(permission)}
                    onChange={(e) =>
                      setUsers((prev) =>
                        prev.map((u) =>
                          u.id === user.id
                            ? {
                                ...u,
                                permissions: e.target.checked
                                  ? [...u.permissions, permission]
                                  : u.permissions.filter(
                                      (p) => p !== permission,
                                    ),
                              }
                            : u,
                        ),
                      )
                    }
                  />
                  {labels[permission]}
                </label>
              ))}
            </div>
            <label>
              Trạng thái{" "}
              <select
                value={user.status}
                onChange={(e) =>
                  setUsers((prev) =>
                    prev.map((u) =>
                      u.id === user.id
                        ? {
                            ...u,
                            status: e.target.value as "active" | "blocked",
                          }
                        : u,
                    ),
                  )
                }
              >
                <option value="active">Hoạt động</option>
                <option value="blocked">Đã khóa</option>
              </select>
            </label>
            <button onClick={() => void save(user)}>Lưu quyền</button>
          </fieldset>
        ))}
      </div>
      <button disabled={busy} onClick={() => void load()}>
        Làm mới
      </button>
      {cursor && (
        <button disabled={busy} onClick={() => void load(cursor)}>
          Trang tiếp
        </button>
      )}
    </>
  );
}
