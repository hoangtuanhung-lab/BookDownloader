import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { prepareImport, sha256 } from "../../tools/migration/import-local";
import { verifyLocalFiles } from "../../tools/migration/verify-local-files";
import { convertLegacyProgress } from "../../tools/migration/progress";
import { createAuthServices } from "../../packages/infrastructure/src/auth";
import { AppError } from "../../packages/contracts/src/index";
test("migration review rejection returns a safe actionable conflict", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ code: "55000", message: "PRIVATE_DB_DETAIL" }),
      { status: 400 },
    );
  try {
    const service = createAuthServices({
      SUPABASE_URL: "https://auth.example.test",
      SUPABASE_SERVICE_ROLE_KEY: "synthetic-not-a-secret",
    });
    await assert.rejects(
      service.rpc("app_download", {}),
      (error: unknown) =>
        error instanceof AppError &&
        error.status === 409 &&
        error.code === "CONFLICT" &&
        !error.message.includes("PRIVATE_DB_DETAIL"),
    );
  } finally {
    globalThis.fetch = original;
  }
});
const sample = () =>
  JSON.parse(readFileSync("tools/migration/sample.json", "utf8"));
const options = () => ({
  sourceKey: "synthetic-v1",
  ownerId: "a8000000-0000-4000-8000-000000000001",
  ownerEmail: "owner@example.test",
  driveSubject: "synthetic-owner",
});
test("canonical checksum ignores object-key order but preserves changed content", () => {
  const a = sample(),
    b = { ...a };
  delete b.schemaVersion;
  b.schemaVersion = 1;
  assert.equal(
    prepareImport(a, options()).checksum,
    prepareImport(b, options()).checksum,
  );
  b.BOOKS[0][10] = "Khác";
  assert.notEqual(
    prepareImport(sample(), options()).checksum,
    prepareImport(b, options()).checksum,
  );
});
test("DONE without file needs explicit skipped provenance", () => {
  const a = sample();
  a.CHAPTERS[0][5] = "";
  assert.throws(() => prepareImport(a, options()));
  assert.equal(
    prepareImport(a, { ...options(), skippedChapterKeys: ["BOOK001:1"] })
      .skipped.size,
    1,
  );
  assert.throws(() =>
    prepareImport(sample(), {
      ...options(),
      skippedChapterKeys: ["BOOK001:1"],
    }),
  );
});
test("complete inventory still must prove every book under root", () => {
  const a = sample();
  a.files[1].parents = ["outside"];
  assert.throws(() => prepareImport(a, options()), /root/);
});
test("unknown state and missing/trashed files block preparation", () => {
  const a = sample();
  a.BOOKS[0][8] = "UNKNOWN";
  assert.throws(() => prepareImport(a, options()));
  a.BOOKS[0][8] = "COMPLETED";
  a.files[4].trashed = true;
  assert.throws(() => prepareImport(a, options()));
});
test("invalid date and scientific order require explicit repair", () => {
  const a = sample();
  a.BOOKS[0][9] = "31/02/2026";
  assert.throws(() => prepareImport(a, options()), /calendar/);
  a.BOOKS[0][9] = "08/10/2026";
  a.CHAPTERS[0][1] = "1e2";
  assert.throws(() => prepareImport(a, options()), /decimal/);
});
test("progress cannot target skipped, pending, other-book or duplicate rows", () => {
  const a = sample();
  for (const order of [0, 2])
    assert.throws(() =>
      prepareImport(a, {
        ...options(),
        progress: [{ book: "BOOK001", order, ratio: 0.2 }],
      }),
    );
  const progress = { book: "BOOK001", order: 1, ratio: 0.2 };
  assert.throws(() =>
    prepareImport(a, { ...options(), progress: [progress, progress] }),
  );
});
test("legacy progress converts exact c/y/p fields and reports corrupt or mixed origins", () => {
  const p = JSON.stringify({ c: -0.5, y: 100, p: 0.4, t: 1e12 });
  const out = convertLegacyProgress({
    RP_B: p,
    rdPos_B: p,
    RP_C: "broken",
    TOKEN: "secret",
  });
  assert.equal(out.progress[0].order, -0.5);
  assert.equal(out.progress[0].ratio, 0.4);
  assert.equal(out.issues.length, 2);
  assert.equal(out.ownerBindingRequired, true);
  assert(!JSON.stringify(out).includes("secret"));
});
test("all local files hash-check; corruption, missing manifest and symlink escape fail", async () => {
  const dir = await mkdtemp("/tmp/book-phase8-");
  try {
    const a = sample(),
      body = "Nội dung Unicode\n";
    a.files[4].sizeBytes = Buffer.byteLength(body);
    await writeFile(dir + "/chapter.txt", body);
    const manifest = {
      "sample-chapter": { path: "chapter.txt", sha256: sha256(body) },
    };
    assert.equal(
      (await verifyLocalFiles(a, options(), dir, manifest)).ready,
      true,
    );
    await writeFile(dir + "/chapter.txt", "damaged");
    assert.equal(
      (await verifyLocalFiles(a, options(), dir, manifest)).ready,
      false,
    );
    assert.equal((await verifyLocalFiles(a, options(), dir, {})).ready, false);
    await symlink("/etc/hostname", dir + "/escape");
    manifest["sample-chapter"].path = "escape";
    assert.equal(
      (await verifyLocalFiles(a, options(), dir, manifest)).results[0].code,
      "MISSING_OR_OUTSIDE_BACKUP",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("phase8 exporter separates private LOG/state/progress and excludes credentials", async () => {
  const data = sample();
  const props = {
    DB_ID: "private-db",
    ANA_QUEUE: '{"w":[]}',
    IMP_folder: "manifest-id",
    SITE_COOKIES: "NEVER_COPY",
    DRIVE_REFRESH_TOKEN: "NEVER_COPY",
  };
  const sheets: any = {
    BOOKS: data.BOOKS,
    CHAPTERS: data.CHAPTERS,
    CONFIG: [],
    LOG: [["private log"]],
  };
  const context = vm.createContext({
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: (name: string) => ({
          getLastRow: () => sheets[name].length + 1,
          getLastColumn: () => 1,
          getRange: () => ({ getValues: () => sheets[name] }),
        }),
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperties: () => props }),
      getUserProperties: () => ({
        getProperties: () => ({
          RP_BOOK001: '{"c":1,"y":0,"p":0,"t":1e12}',
          OTHER: "NEVER_COPY",
        }),
      }),
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => "owner@example.test" }),
    },
  });
  vm.runInContext(
    await readFile("tools/migration/export-read-only.gs", "utf8"),
    context,
  );
  vm.runInContext(
    await readFile("tools/migration/export-phase8-read-only.gs", "utf8"),
    context,
  );
  const result = JSON.parse(
    vm.runInContext("exportPhase8ReadOnly('synthetic')", context),
  );
  assert.equal(result.privateReview.scriptState.IMP_folder, "manifest-id");
  assert.equal(result.privateReview.LOG.length, 1);
  assert.equal(
    result.privateReview.userProgress.RP_BOOK001.includes("c"),
    true,
  );
  assert(!JSON.stringify(result).includes("NEVER_COPY"));
  assert(!JSON.stringify(result.metadata).includes("private-db"));
});
