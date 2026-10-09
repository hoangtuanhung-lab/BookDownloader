import { kickWorker } from "../../packages/infrastructure/src/netlify-worker";

export default async function () {
  if (process.env.NETLIFY_WORKER_ENABLED !== "true") return new Response(null, { status: 204 });
  try { await kickWorker(process.env); return new Response(null, { status: 200 }); }
  catch { console.error("library_worker_schedule_unavailable"); return new Response(null, { status: 503 }); }
}
// Continues checkpoints and jobs even after the browser has closed.
export const config = { schedule: "*/5 * * * *" };
