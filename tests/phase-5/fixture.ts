import { AppError } from "../../packages/contracts/src/index";
import type { DriveFile } from "../../packages/infrastructure/src/drive";
import type { WorkflowDrive } from "../../packages/infrastructure/src/workflows";
export function memoryDrive() {
  let serial = 100000;
  const files = new Map<string, DriveFile>([
      [
        "root",
        {
          id: "root",
          name: "Fixture root",
          mimeType: "application/vnd.google-apps.folder",
          parents: [],
          trashed: false,
          appProperties: {},
          capabilities: { canAddChildren: true },
        },
      ],
    ]),
    bodies = new Map<string, Buffer>();
  let failAfterWrite = false;
  const drive: WorkflowDrive = {
    async checkRoot() {
      return files.get("root");
    },
    async assertUnderRoot(id) {
      const f = files.get(id);
      if (!f || f.trashed)
        throw new AppError("DRIVE_NOT_FOUND", 404, "File không còn tồn tại");
      let x = f;
      const seen = new Set<string>();
      while (x.id !== "root") {
        if (
          seen.has(x.id) ||
          x.parents.length !== 1 ||
          !files.has(x.parents[0])
        )
          throw new AppError("DRIVE_OUTSIDE_ROOT", 403, "Ngoài thư viện");
        seen.add(x.id);
        x = files.get(x.parents[0])!;
      }
      return f;
    },
    async list(parent, name) {
      await this.assertUnderRoot(parent);
      return [...files.values()].filter(
        (f) =>
          !f.trashed &&
          f.parents.includes(parent) &&
          (name === undefined || f.name === name),
      );
    },
    async folder(parent, name) {
      const old = (await this.list(parent, name))[0];
      if (old) return old.id;
      const id = "fake-" + ++serial;
      files.set(id, {
        id,
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parent],
        trashed: false,
        appProperties: {},
        capabilities: { canAddChildren: true },
      });
      return id;
    },
    async putText(parent, name, text, version) {
      const old = (await this.list(parent, name))[0];
      const id = old?.id || "fake-" + ++serial;
      files.set(id, {
        id,
        name,
        mimeType: "text/plain",
        parents: [parent],
        trashed: false,
        appProperties: { metadataVersion: String(version) },
      });
      bodies.set(id, Buffer.from(text));
      if (failAfterWrite) {
        failAfterWrite = false;
        throw new AppError("CRASH", 503, "Gián đoạn sau khi tạo file");
      }
      return id;
    },
    async readText(id) {
      await this.assertUnderRoot(id);
      return bodies.get(id)!.toString();
    },
    async moveFolder(id, parent, name) {
      const f = await this.assertUnderRoot(id);
      await this.assertUnderRoot(parent);
      f.parents = [parent];
      f.name = name;
    },
    async trashOwned(id) {
      const f = await this.assertUnderRoot(id);
      f.trashed = true;
    },
    async putCover(parent, name, bytes, version) {
      const id = await this.putText(parent, name, "", version);
      files.get(id)!.mimeType = "image/webp";
      bodies.set(id, Buffer.from(bytes));
      return id;
    },
  };
  return {
    drive,
    files,
    bodies,
    crashAfterWrite: () => {
      failAfterWrite = true;
    },
  };
}
