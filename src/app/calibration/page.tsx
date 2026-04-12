import { Suspense } from "react";
import CalibrationPageClient from "./CalibrationPageClient";

// This page is dynamic because the client component uses useSearchParams
// (to read `?node=` for auto-expanding a row). The route segment config
// must live in a server component to take effect.
export const dynamic = "force-dynamic";

export default function CalibrationPage() {
  // Suspense boundary required by Next 15+ for any client component using
  // useSearchParams; force-dynamic above prevents stale prerendered HTML
  // from causing hydration mismatches.
  return (
    <Suspense fallback={null}>
      <CalibrationPageClient />
    </Suspense>
  );
}
