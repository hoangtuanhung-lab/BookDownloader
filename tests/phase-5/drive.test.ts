import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleDriveStorage } from "../../packages/infrastructure/src/drive";
import { fixture } from "../phase-3/drive-fixture";
function extended() {
  const f = fixture(),
    binary = new Map<string, Buffer>();
  let serial = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method || "GET";
    const fid = url.pathname.split("/")[4];
    if (method === "PATCH" && url.pathname.startsWith("/drive/v3/files/")) {
      const file = f.files.get(fid)!;
      Object.assign(file, JSON.parse(String(init?.body)));
      if (url.searchParams.has("addParents"))
        file.parents = [url.searchParams.get("addParents")!];
      return Response.json(file);
    }
    if (url.pathname.startsWith("/upload") && Buffer.isBuffer(init?.body)) {
      const body = init.body,
        marker = Buffer.from("\r\n\r\n"),
        start = body.indexOf(marker) + 4,
        end = body.indexOf("\r\n--", start),
        meta = JSON.parse(body.subarray(start, end).toString()),
        contentStart = body.indexOf(marker, end) + 4,
        contentEnd = body.lastIndexOf("\r\n--"),
        id = "cover-" + ++serial;
      const file = { ...meta, id, trashed: false };
      f.files.set(id, file);
      binary.set(id, body.subarray(contentStart, contentEnd));
      return Response.json(file);
    }
    if (binary.has(fid) && url.searchParams.get("alt") === "media")
      return new Response(new Uint8Array(binary.get(fid)!), {
        headers: { "Content-Type": "image/webp" },
      });
    return f.fetcher(input, init);
  };
  return {
    ...f,
    binary,
    drive: new GoogleDriveStorage({
      rootId: "root",
      token: async () => "synthetic",
      fetch: fetcher,
      pause: async () => {},
    }),
  };
}
test("Drive rename/move is root bounded and trash refuses root/outside", async () => {
  const f = extended();
  const parent = await f.drive.folder("root", "Thể loại");
  await f.drive.moveFolder("book", parent, "Tên mới");
  assert.equal(f.files.get("book")!.name, "Tên mới");
  assert.deepEqual(f.files.get("book")!.parents, [parent]);
  await assert.rejects(f.drive.moveFolder("root", parent, "Wrong"));
  await assert.rejects(f.drive.trashOwned("outside"));
  await assert.rejects(f.drive.trashOwned("root"));
  await f.drive.trashOwned("book");
  assert(f.files.get("book")!.trashed);
});
test("Drive binary cover upload replays same bytes and refuses content conflict", async () => {
  const f = extended(),
    bytes = Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBP\u00ff", "latin1");
  const id = await f.drive.putCover("book", "cover-2.webp", bytes, 2);
  assert.deepEqual(f.binary.get(id), bytes);
  assert.equal(await f.drive.putCover("book", "cover-2.webp", bytes, 2), id);
  await assert.rejects(
    f.drive.putCover("book", "cover-2.webp", Buffer.from("different"), 2),
  );
  assert.equal(f.binary.size, 1);
});
