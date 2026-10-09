import { runNetlifyWorker, workerAuthorized } from "../../packages/infrastructure/src/netlify-worker";

export async function handleWorker(request: Request, env = process.env, run = runNetlifyWorker) {
  if (request.method !== "POST" || !workerAuthorized(request, env))
    return new Response(null, { status: 403 });
  try {
    console.log(JSON.stringify({ event: "library_worker", ...await run(env) }));
    return new Response(null, { status: 200 });
  } catch {
    // Never log database URLs, OAuth credentials or exception objects.
    console.error("library_worker_unavailable");
    return new Response(null, { status: 503 });
  }
}
export default (request: Request) => handleWorker(request);
