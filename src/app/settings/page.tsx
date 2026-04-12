import PageHeader from "@/components/PageHeader";
import SettingsClient from "./SettingsClient";

// Force dynamic rendering — this page reads/writes config.yaml at request
// time, so static optimization would be wrong here. (Note: the directive
// must live on a server component, not on the client child.)
export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Edit config.yaml directly — validated and atomically written"
      />
      <main className="flex-1 flex flex-col min-h-0 p-4">
        <SettingsClient />
      </main>
    </>
  );
}
