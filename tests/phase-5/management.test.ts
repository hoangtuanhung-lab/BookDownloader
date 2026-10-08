import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { normalizeCover } from "../../packages/infrastructure/src/cover";
import {
  ChapterAdd,
  UploadStart,
  UploadChunk,
  MetadataEdit,
} from "../../packages/contracts/src/management";
test("cover decode rotates/resizes and strips metadata", async () => {
  const image = await sharp({
    create: { width: 1600, height: 900, channels: 3, background: "red" },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const out = await normalizeCover(image),
    meta = await sharp(out).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.height, 1200);
  assert.equal(meta.width, 675);
  assert(!meta.exif);
  assert(!meta.orientation);
});
test("cover rejects SVG, fake PNG and oversize", async () => {
  for (const bytes of [
    Buffer.from("<svg/>"),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.alloc(5000001),
  ])
    await assert.rejects(normalizeCover(bytes));
});
test("upload validates extensions, sizes and chunks", () => {
  assert(
    UploadStart.safeParse({
      purpose: "import",
      name: "truyện.markdown",
      size: 67108864,
    }).success,
  );
  for (const v of [
    { purpose: "chapter", name: "a.txt", size: 2000001 },
    { purpose: "cover", name: "a.svg", size: 10 },
    { purpose: "import", name: "a.exe", size: 10 },
  ])
    assert(!UploadStart.safeParse(v).success);
  assert(!UploadChunk.safeParse({ index: 256, data: "YQ==" }).success);
  assert(!UploadChunk.safeParse({ index: 0, data: "A!AA" }).success);
});
test("chapter paste accepts short text and exact 300000 limit", () => {
  const base = {
    version: 1,
    order: 1,
    title: "",
    part: "",
    volume: "",
    kind: "paste",
  };
  assert(ChapterAdd.safeParse({ ...base, text: "ngắn" }).success);
  assert(ChapterAdd.safeParse({ ...base, text: "a".repeat(300000) }).success);
  assert(!ChapterAdd.safeParse({ ...base, text: "a".repeat(300001) }).success);
  assert(!ChapterAdd.safeParse({ ...base, order: 0, text: "a" }).success);
});
test("metadata edit cannot carry foreign actor, source or arbitrary Drive ID", () => {
  const b = {
    id: "a1000000-0000-4000-8000-000000000001",
    version: 1,
    name: "Truyện",
    author: "",
    genres: ["Kiếm hiệp", "Lịch sử"],
    visibility: "hidden",
  };
  assert(MetadataEdit.safeParse(b).success);
  for (const field of ["actor", "fileId", "sourceUrl"])
    assert(!MetadataEdit.safeParse({ ...b, [field]: "foreign" }).success);
});
