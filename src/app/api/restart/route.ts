import { spawn } from "node:child_process";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST — restart the service that's hosting this app.
 *
 * Driven entirely by the `ESPRESENSE_RESTART_COMMAND` env var. The systemd
 * unit installed by `deploy/install.sh` sets it to
 * `sudo systemctl restart espresense-hub`, paired with a sudoers.d entry
 * giving the service user passwordless permission to run exactly that
 * command. If the env var isn't set (e.g., in `npm run dev`), the endpoint
 * refuses — accidentally killing your dev server is annoying.
 *
 * Implementation note: we spawn the restart command detached and unref'd
 * so it survives our own process getting SIGTERM'd. The HTTP response is
 * returned synchronously *before* the restart actually fires, so the
 * client sees `ok` and can show "restarting…" before the connection drops.
 */
export async function POST(): Promise<Response> {
  const cmd = process.env.ESPRESENSE_RESTART_COMMAND;
  if (!cmd || cmd.trim().length === 0) {
    return NextResponse.json(
      {
        error:
          "Restart not configured — ESPRESENSE_RESTART_COMMAND env var is unset. " +
          "If you're in dev, restart the dev server manually. " +
          "In production, deploy/install.sh wires this up automatically.",
      },
      { status: 501 },
    );
  }

  // Defer the actual restart by a beat so this response gets flushed to
  // the client before systemd kills us.
  setTimeout(() => {
    try {
      // shell:true so the env var can be a full command line including
      // sudo + args. Detached + unref so the child outlives us.
      const child = spawn(cmd, {
        shell: true,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch (err) {
      console.error("[api/restart] spawn failed:", err);
    }
  }, 250);

  return NextResponse.json({
    ok: true,
    note: "Restart scheduled. Connection will drop briefly while the service comes back up.",
  });
}
