import { test } from "node:test";
import https from "node:https";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { analyze, manualChapters } from "../../packages/domain/src/analysis";
import {
  SourceHttp,
  publicAddress,
  validateSource,
} from "../../packages/infrastructure/src/source-http";
const cfg = { SITE_RULES: "", JUNK_WORDS: "", DELAY_MS: 0 };
test("source SSRF blocks private, mapped IPv6, metadata and reserved addresses", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.2.3.4",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::ffff:8.8.8.8",
    "fc00::1",
    "2001:db8::1",
  ])
    assert(!publicAddress(ip), ip);
  assert(publicAddress("8.8.8.8"));
  assert(publicAddress("2606:4700:4700::1111"));
  for (const url of [
    "file:///etc/passwd",
    "http://user:secret@source.test",
    "http://localhost",
    "http://[::1]",
    "http://source.test:8080",
  ])
    await assert.rejects(validateSource(url));
});
test("DNS rejects a mix of public and private answers", async () => {
  await assert.rejects(
    validateSource(
      "https://source.test",
      async () =>
        [
          { address: "8.8.8.8", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ] as any,
    ),
  );
});
test("source fetch never sends a request to loopback", async () => {
  await assert.rejects(
    new SourceHttp().get("http://127.0.0.1", new AbortController().signal),
  );
});
test("discovery keeps mixed order/range and metadata over paging", async () => {
  const pages: Record<string, string> = {
    "https://source.test/book/":
      '<h1>Tên truyện</h1><a href="/book/quyen-1-chuong-1-2">Chương 1-2</a><a href="/book/chuong-1">Chương 1</a><a rel="next" href="?page=2">Tiếp</a>',
    "https://source.test/book/?page=2": '<a href="/book/chuong-2">Chương 2</a>',
  };
  const result = await analyze(
    "https://source.test/book/",
    {
      async get(url) {
        assert(pages[url]);
        return { body: pages[url], finalUrl: url };
      },
    },
    cfg,
    new AbortController().signal,
  );
  assert.equal(result.chapters.length, 3);
  assert.equal(result.chapters[0].dnum, "1-2");
  assert.equal(result.chapters[0].vol, "Quyển 1");
  assert(result.chapters[0].num < 0);
});
test("discovery does not manufacture 2950 links from one observation", async () => {
  const result = await analyze(
    "https://source.test/book/",
    {
      async get(url) {
        return {
          body: '<h1>Mẫu</h1><a href="/book/chuong-2950-slug">Chương 2950</a>',
          finalUrl: url,
        };
      },
    },
    cfg,
    new AbortController().signal,
  );
  assert.equal(result.chapters.length, 1);
});
test("template fills gaps only if observed URLs actually match", async () => {
  for (const [links, count] of [
    ['<a href="/book/chuong-1-a">1</a><a href="/book/chuong-3-c">3</a>', 2],
    ['<a href="/book/chuong-1">1</a><a href="/book/chuong-3">3</a>', 3],
  ] as const) {
    const result = await analyze(
      "https://source.test/book/",
      {
        async get(url) {
          return { body: "<h1>Mẫu</h1>" + links, finalUrl: url };
        },
      },
      cfg,
      new AbortController().signal,
    );
    assert.equal(result.chapters.length, count);
    assert(result.notes.length);
  }
});
test("discovery rejects unknown pagination, CAPTCHA and escaped prefix", async () => {
  for (const html of [
    '<div class="pagination">Pages</div>',
    "<div>captcha</div>",
    '<a href="/book-other/chuong-1">1</a>',
  ])
    await assert.rejects(
      analyze(
        "https://source.test/book/",
        {
          async get(url) {
            return { body: html, finalUrl: url };
          },
        },
        cfg,
        new AbortController().signal,
      ),
    );
});
test("manual sample covers exact 1–20000 bounds and preserves query", () => {
  const result = manualChapters(
    "https://source.test/book/chuong-9.html?view=1",
    20000,
  );
  assert.equal(result[0].url, "https://source.test/book/chuong-1.html?view=1");
  assert.equal(result.at(-1)?.num, 20000);
  assert.throws(() => manualChapters("https://source.test/no-number", 10));
  for (const n of [0, 20001, 1.2])
    assert.throws(() => manualChapters("https://source.test/chuong-1", n));
});
test("finite analysis checkpoints page and resumes without refetching old pages", async () => {
  const calls: string[] = [];
  let state: any;
  const http = {
    async get(url: string) {
      calls.push(url);
      return {
        body: url.includes("page=2")
          ? '<a href="/book/chuong-2">2</a>'
          : '<h1>Mẫu</h1><a href="/book/chuong-1">1</a><a rel="next" href="?page=2">Tiếp</a>',
        finalUrl: url,
      };
    },
  };
  const partial = await analyze(
    "https://source.test/book/",
    http,
    cfg,
    new AbortController().signal,
    {
      checkpoint: async (s) => {
        state = structuredClone(s);
      },
      shouldYield: () => true,
    },
  );
  assert("pending" in partial);
  assert.equal(calls.length, 1);
  const result = await analyze(
    "https://source.test/book/",
    http,
    cfg,
    new AbortController().signal,
    { resume: state, checkpoint: async () => {}, shouldYield: () => false },
  );
  assert(!("pending" in result));
  assert.equal(result.chapters.length, 2);
  assert.deepEqual(calls, [
    "https://source.test/book/",
    "https://source.test/book/?page=2",
  ]);
});

test("connection pins verified DNS and cookie stays within hostname boundary", async (t) => {
  const requests: { url: URL; options: any }[] = [];
  t.mock.method(https, "get", (url: URL, options: any, callback: any) => {
    requests.push({ url, options });
    const request = new EventEmitter();
    queueMicrotask(() => {
      const response = Object.assign(new EventEmitter(), {
        statusCode: requests.length === 1 ? 302 : 200,
        headers:
          requests.length === 1 ? { location: "https://other.test/final" } : {},
      });
      callback(response);
      response.emit("data", Buffer.from("HTML"));
      response.emit("end");
    });
    return request;
  });
  let lookups = 0;
  const resolver = async () => {
    lookups++;
    return [{ address: "8.8.8.8", family: 4 }] as any;
  };
  const result = await new SourceHttp(
    { "source.test": "synthetic-cookie" },
    resolver as any,
  ).get("https://source.test/book/", new AbortController().signal);
  assert.equal(result.finalUrl, "https://other.test/final");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.Cookie, "synthetic-cookie");
  assert.equal(requests[1].options.headers.Cookie, undefined);
  for (const r of requests)
    r.options.lookup(
      "source.test",
      {},
      (e: any, address: string, family: number) => {
        assert.equal(e, null);
        assert.equal(address, "8.8.8.8");
        assert.equal(family, 4);
      },
    );
  assert.equal(lookups, 2);
});
test("redirect to private DNS answer is rejected before the second connection", async (t) => {
  let connections = 0;
  t.mock.method(https, "get", (_url: URL, _options: any, callback: any) => {
    connections++;
    const request = new EventEmitter();
    queueMicrotask(() => {
      const response = Object.assign(new EventEmitter(), {
        statusCode: 302,
        headers: { location: "https://private.test/" },
      });
      callback(response);
      response.emit("end");
    });
    return request;
  });
  const resolver = async (host: string) =>
    [
      { address: host === "private.test" ? "127.0.0.1" : "8.8.8.8", family: 4 },
    ] as any;
  await assert.rejects(
    new SourceHttp({}, resolver as any).get(
      "https://source.test/book/",
      new AbortController().signal,
    ),
  );
  assert.equal(connections, 1);
});
