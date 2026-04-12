/**
 * Next.js runtime hook: `register` is called once per server instance start
 * and must complete before requests are served. We use it to bring up the
 * MQTT client + state store so page handlers can read live data.
 *
 * Only runs in the Node.js runtime (skips edge and the build collector).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { bootstrap } = await import("./src/lib/bootstrap");
  await bootstrap();
}
