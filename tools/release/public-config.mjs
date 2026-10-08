export function verifyPublicConfig(env) {
  const url = new URL(env.VITE_SUPABASE_URL),
    key = env.VITE_SUPABASE_ANON_KEY || "";
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !url.hostname.endsWith(".supabase.co")
  )
    throw Error("Invalid public Supabase URL");
  if (key.startsWith("sb_publishable_") && key.length > 20) return true;
  try {
    if (
      JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString())
        .role === "anon"
    )
      return true;
  } catch {}
  throw Error("Only an anon/publishable key may enter the browser build");
}
if (process.argv[1]?.endsWith("public-config.mjs")) {
  try {
    verifyPublicConfig(process.env);
    console.log("Public auth configuration verified");
  } catch {
    console.error("Public auth configuration rejected");
    process.exitCode = 1;
  }
}
