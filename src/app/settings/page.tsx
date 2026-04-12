import PageHeader from "@/components/PageHeader";

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="MQTT, map, and locator configuration"
      />
      <main className="flex-1 p-6">
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-8 text-center text-sm text-zinc-500">
          Settings editor coming soon
        </div>
      </main>
    </>
  );
}
