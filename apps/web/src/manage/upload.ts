export type Call = (path: string, init?: RequestInit) => Promise<any>;
export async function uploadFile(
  call: Call,
  file: File,
  purpose: "import" | "toc" | "chapter" | "cover",
  signal: AbortSignal,
  progress: (n: number) => void = () => {},
) {
  const start = await call("/manage/uploads", {
    method: "POST",
    body: JSON.stringify({ purpose, name: file.name, size: file.size }),
    signal,
  });
  try {
    for (
      let offset = 0, index = 0;
      offset < file.size;
      offset += 262144, index++
    ) {
      signal.throwIfAborted();
      const bytes = new Uint8Array(
        await file.slice(offset, offset + 262144).arrayBuffer(),
      );
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await call("/manage/uploads/" + start.id, {
        method: "PUT",
        body: JSON.stringify({ index, data: btoa(binary) }),
        signal,
      });
      progress(
        Math.min(100, Math.round(((offset + bytes.length) / file.size) * 100)),
      );
    }
    await call("/manage/uploads/" + start.id + "/complete", {
      method: "POST",
      signal,
    });
    return start.id as string;
  } catch (e) {
    if (!signal.aborted)
      await call("/manage/uploads/" + start.id, { method: "DELETE" }).catch(
        () => {},
      );
    throw e;
  }
}
