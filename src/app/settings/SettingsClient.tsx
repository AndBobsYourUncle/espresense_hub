"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, FileText, Loader2, Save } from "lucide-react";

interface LoadResponse {
  configPath?: string;
  yaml?: string;
  error?: string;
  code?: string;
}

interface SaveResponse {
  ok?: boolean;
  configPath?: string;
  bytes?: number;
  liveReloadOk?: boolean;
  note?: string;
  error?: string;
  code?: string;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "saving" }
  | { kind: "saved"; bytes: number; liveReloadOk: boolean; note?: string }
  | { kind: "error"; message: string };

export default function SettingsClient() {
  const [yaml, setYaml] = useState<string>("");
  const [original, setOriginal] = useState<string>("");
  const [configPath, setConfigPath] = useState<string>("");
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/config", { cache: "no-store" });
        const data = (await res.json()) as LoadResponse;
        if (cancelled) return;
        if (!res.ok || !data.yaml) {
          setStatus({
            kind: "error",
            message: data.error ?? `Failed to load config (${res.status})`,
          });
          return;
        }
        setYaml(data.yaml);
        setOriginal(data.yaml);
        setConfigPath(data.configPath ?? "");
        setStatus({ kind: "idle" });
      } catch (err) {
        if (cancelled) return;
        setStatus({ kind: "error", message: (err as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = yaml !== original;

  const save = async () => {
    setStatus({ kind: "saving" });
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ yaml }),
      });
      const data = (await res.json()) as SaveResponse;
      if (!res.ok || !data.ok) {
        setStatus({
          kind: "error",
          message: data.error ?? `Save failed (${res.status})`,
        });
        return;
      }
      setOriginal(yaml);
      setStatus({
        kind: "saved",
        bytes: data.bytes ?? 0,
        liveReloadOk: data.liveReloadOk ?? false,
        note: data.note,
      });
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
  };

  const revert = () => {
    setYaml(original);
    setStatus({ kind: "idle" });
  };

  // Cmd/Ctrl+S to save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (dirty && status.kind !== "saving") save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-3 px-4 pb-3 border-b border-zinc-200 dark:border-zinc-800 text-xs">
        <FileText className="h-3.5 w-3.5 text-zinc-400" />
        <span className="font-mono text-zinc-500 truncate">
          {configPath || "config.yaml"}
        </span>
        <span className="ml-auto flex items-center gap-3">
          {status.kind === "saved" && (
            <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
              <Check className="h-3.5 w-3.5" />
              Saved · {status.bytes} bytes
              {status.liveReloadOk ? null : " · restart recommended"}
            </span>
          )}
          {status.kind === "error" && (
            <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400 max-w-md truncate">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {status.message}
            </span>
          )}
          {dirty && status.kind !== "saving" && (
            <button
              type="button"
              onClick={revert}
              className="h-7 px-2.5 inline-flex items-center rounded-md text-xs font-medium border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300"
            >
              Revert
            </button>
          )}
          <button
            type="button"
            onClick={save}
            disabled={!dirty || status.kind === "saving" || status.kind === "loading"}
            className="h-7 px-3 inline-flex items-center gap-1.5 rounded-md text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {status.kind === "saving" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </button>
        </span>
      </div>

      <div className="flex-1 min-h-0 px-4 py-3">
        {status.kind === "loading" ? (
          <div className="text-sm text-zinc-500 p-4">Loading config…</div>
        ) : (
          <textarea
            ref={textareaRef}
            value={yaml}
            onChange={(e) => {
              setYaml(e.target.value);
              if (status.kind === "saved" || status.kind === "error") {
                setStatus({ kind: "idle" });
              }
            }}
            spellCheck={false}
            className="w-full h-full resize-none rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        )}
      </div>

      <div className="px-4 py-2 border-t border-zinc-200 dark:border-zinc-800 text-[11px] text-zinc-500 leading-relaxed">
        Validated against the schema before writing. Atomic write — a partial
        save can&apos;t corrupt the file. Node positions and rooms apply live;
        MQTT/bootstrap settings need a service restart.{" "}
        <kbd className="font-mono text-[10px] px-1 py-px rounded border border-zinc-300 dark:border-zinc-700">
          ⌘/Ctrl+S
        </kbd>{" "}
        to save.
      </div>
    </div>
  );
}
