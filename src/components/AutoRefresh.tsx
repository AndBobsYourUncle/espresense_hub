"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Invisible component that triggers `router.refresh()` on a fixed
 * interval — re-renders the enclosing Server Component tree without a
 * full navigation, so server-read store state (node status, device
 * measurements, last-seen timestamps) stays live.
 *
 * Cheaper than converting a server-rendered page to a fully client-side
 * data-fetch: initial render still ships the data inline with the HTML,
 * and refreshes only re-run the RSC payload. Pauses while the page is
 * hidden (visibility API) so a background tab doesn't pound the server.
 */
export default function AutoRefresh({
  intervalMs = 5000,
}: {
  intervalMs?: number;
}) {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer != null) return;
      timer = setInterval(() => {
        router.refresh();
      }, intervalMs);
    };

    const stop = () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    };
  }, [router, intervalMs]);

  return null;
}
