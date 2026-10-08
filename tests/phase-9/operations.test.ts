import { verifyPublicConfig } from "../../tools/release/public-config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { configureRoot } from "../../packages/infrastructure/src/operations";
import type { AuthServices } from "../../packages/infrastructure/src/auth";
import { validatedLegacyManifest } from "../../tools/migration/reconcile-local";
import { planLegacyDelta } from "../../tools/migration/delta-local";
import { legacyTimestamp } from "../../tools/migration/import-local";
import { handleApi } from "../../netlify/functions/api";
import { verifyArtifact } from "../../tools/release/verify-artifact.mjs";
import { verifyRun } from "../../tools/release/verify-run.mjs";
const actor = "a9000000-0000-4000-8000-000000000001",
  requestId = "a9000000-0000-4000-8000-000000000003";
const sample = async () =>
  JSON.parse(await readFile("tools/migration/sample.json", "utf8"));
const options = {
  sourceKey: "unit",
  ownerId: actor,
  ownerEmail: "owner@example.test",
  driveSubject: "owner",
};
test("legacy clock retains hour/second in Vietnam offset; invalid clock rejected", () => {
  assert.equal(
    legacyTimestamp("09/10/2026 17:23:45"),
    "2026-10-09T17:23:45+07:00",
  );
  assert.throws(() => legacyTimestamp("09/10/2026 25:00:00"));
});
test("pending FILE manifest must have unique finite orders and every pending body", () => {
  assert.equal(
    validatedLegacyManifest('[{"num":-0.5,"body":"mẫu"}]', [-0.5])[0].num,
    -0.5,
  );
  assert.throws(() =>
    validatedLegacyManifest('[{"num":1,"body":""},{"num":1,"body":""}]', [1]),
  );
  assert.throws(() => validatedLegacyManifest('[{"num":1,"body":""}]', [2]));
  assert.throws(() => validatedLegacyManifest('[{"num":1}]', [1]));
});
test("delta lists additions and metadata changes without Drive IO; owner/root changes rejected", async () => {
  const a = await sample(),
    b = structuredClone(a);
  b.BOOKS[0][10] = "Tác giả mới";
  const p = planLegacyDelta(a, b, options);
  assert.equal(p.books.changed.length, 1);
  assert.equal(p.chapters.added.length, 0);
  assert.equal(p.remoteWrites, 0);
  assert.match(p.planHash, /^[a-f0-9]{64}$/);
  assert.throws(() =>
    planLegacyDelta(a, b, {
      before: options,
      after: { ...options, driveSubject: "other" },
    }),
  );
});
test("root create checks parent and result write access and persists server-only binding", async () => {
  const calls: string[] = [];
  const service: AuthServices = {
    async verify() {
      throw Error("Unused");
    },
    async rpc(r, a) {
      calls.push(a.operation as string);
      return a.operation === "root-prepare"
        ? { repeated: false, revision: 1 }
        : { rootId: "new-root" };
    },
  };
  let checked: string[] = [];
  const value = await configureRoot(
    service,
    actor,
    { requestId, revision: 1, kind: "create", id: "parent", name: "Thư viện" },
    {},
    (env) => ({
      async checkRoot() {
        checked.push(env.DRIVE_ROOT_ID!);
        return {} as any;
      },
      async folder() {
        return "new-root";
      },
    }),
  );
  assert.deepEqual(checked, ["parent", "new-root"]);
  assert.deepEqual(calls, ["root-prepare", "root-finish"]);
  assert.deepEqual(value, { rootId: "new-root" });
});
test("repeated root receipt never creates another folder", async () => {
  const service: AuthServices = {
    async verify() {
      throw Error();
    },
    async rpc() {
      return { repeated: true, rootId: "existing" };
    },
  };
  const out = await configureRoot(
    service,
    actor,
    { requestId, revision: 1, kind: "register", id: "existing" },
    {},
    () => {
      throw Error("No Drive calls");
    },
  );
  assert.equal(out.repeated, true);
});
test("ambiguous root failure retains an uncertain receipt for explicit reconciliation", async () => {
  const calls: string[] = [];
  const service: AuthServices = {
    async verify() {
      throw Error();
    },
    async rpc(r, a) {
      calls.push(a.operation as string);
      return { repeated: false, revision: 1 };
    },
  };
  await assert.rejects(
    configureRoot(
      service,
      actor,
      { requestId, revision: 1, kind: "create", id: "parent", name: "mẫu" },
      {},
      () => ({
        async checkRoot() {
          return {} as any;
        },
        async folder() {
          throw Error("Remote create uncertain");
        },
      }),
    ),
  );
  assert.deepEqual(calls, ["root-prepare", "root-uncertain"]);
});
test("operations/root API deny reader and invalid origin before any Drive writes", async () => {
  let io = 0;
  const svc: AuthServices = {
    async verify() {
      return {
        id: actor,
        email: "owner@example.test",
        email_confirmed_at: "now",
        app_metadata: { provider: "google" },
      };
    },
    async rpc() {
      return { id: actor, name: "Reader", permissions: ["read"] };
    },
  };
  const request = new Request("https://local.test/api/drive/root", {
    method: "PUT",
    headers: {
      Authorization: "Bearer fixture",
      Origin: "https://local.test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requestId,
      revision: 1,
      kind: "register",
      id: "root",
    }),
  });
  assert.equal(
    (
      await handleApi(
        request,
        { APP_ORIGINS: "https://local.test" },
        undefined,
        svc,
        undefined,
        {
          validateUrl: async () => {},
          rootFactory: () => {
            io++;
            throw Error();
          },
        },
      )
    ).status,
    403,
  );
  assert.equal(io, 0);
  const status = await handleApi(
    new Request("https://local.test/api/admin/operations", {
      headers: { Authorization: "Bearer fixture" },
    }),
    {},
    undefined,
    svc,
  );
  assert.equal(status.status, 403);
});
test("version reports release contract without credentials or auth requirement", async () => {
  const res = await handleApi(new Request("https://local.test/api/version"), {
    RELEASE_REVISION: "a".repeat(40),
    DRIVE_CLIENT_SECRET: "DO_NOT_RETURN",
  });
  const body = await res.json();
  assert.equal(body.minimumMigration, "202610090023_operations_receipts.sql");
  assert.equal(body.revision, "a".repeat(40));
  assert(!JSON.stringify(body).includes("DO_NOT_RETURN"));
});
test("release provenance rejects PR/fork/stale or unsuccessful runs", () => {
  const sha = "a".repeat(40),
    run = {
      head_sha: sha,
      head_branch: "main",
      status: "completed",
      conclusion: "success",
      event: "push",
      path: ".github/workflows/phase-1.yml",
      repository: { full_name: "owner/repo" },
      head_repository: { full_name: "owner/repo" },
    };
  assert.equal(verifyRun(run, "owner/repo", sha), true);
  for (const override of [
    { event: "pull_request" },
    { conclusion: "failure" },
    { head_repository: { full_name: "fork/repo" } },
    { head_sha: "b".repeat(40) },
    { path: "other.yml" },
  ])
    assert.throws(() => verifyRun({ ...run, ...override }, "owner/repo", sha));
});
test("candidate artifact detects corruption, wrong commit, dirty build and symlink escape", async () => {
  const dir = await mkdtemp("/tmp/book-release-test-");
  try {
    await mkdir(dir + "/apps/web/dist/assets", { recursive: true });
    await mkdir(dir + "/dist");
    const files: Record<string, string> = {};
    for (const path of [
      "apps/web/dist/index.html",
      "apps/web/dist/assets/main.js",
      "dist/api.mjs",
      "dist/worker.mjs",
      "dist/build-record.json",
    ]) {
      await writeFile(dir + "/" + path, path);
      files[path] = createHash("sha256").update(path).digest("hex");
    }
    const manifest = {
      schemaVersion: 1,
      revision: "a".repeat(40),
      dirty: false,
      contractVersion: 1,
      files,
    };
    await writeFile(dir + "/release-manifest.json", JSON.stringify(manifest));
    await verifyArtifact(dir, manifest.revision);
    await assert.rejects(verifyArtifact(dir, "b".repeat(40)));
    await writeFile(dir + "/dist/api.mjs", "modified");
    await assert.rejects(verifyArtifact(dir, manifest.revision));
    await rm(dir + "/dist/api.mjs");
    await symlink("/etc/hostname", dir + "/dist/api.mjs");
    await assert.rejects(verifyArtifact(dir, manifest.revision));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("browser auth config rejects service credentials and accepts only public keys", () => {
  const env = {
    VITE_SUPABASE_URL: "https://fixture.supabase.co",
    VITE_SUPABASE_ANON_KEY: "sb_publishable_fixture123456",
  };
  assert.equal(verifyPublicConfig(env), true);
  assert.throws(() =>
    verifyPublicConfig({ ...env, VITE_SUPABASE_ANON_KEY: "sb_secret_private" }),
  );
  const jwt =
    "e30." +
    Buffer.from(JSON.stringify({ role: "service_role" })).toString(
      "base64url",
    ) +
    ".signature";
  assert.throws(() =>
    verifyPublicConfig({ ...env, VITE_SUPABASE_ANON_KEY: jwt }),
  );
  assert.throws(() =>
    verifyPublicConfig({
      ...env,
      VITE_SUPABASE_URL: "http://fixture.supabase.co",
    }),
  );
});
