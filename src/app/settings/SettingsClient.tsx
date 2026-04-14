"use client";

import { useEffect, useReducer, useState } from "react";
import { parseDocument, type Document } from "yaml";
import {
  AlertCircle,
  Check,
  FileText,
  Loader2,
  MapPin,
  Plus,
  RefreshCw,
  Router,
  Save,
  Settings2,
  Smartphone,
  SlidersHorizontal,
  Square,
  Radio,
  Code,
  Map as MapIcon,
  Trash2,
} from "lucide-react";

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
  | { kind: "restarting" }
  | { kind: "error"; message: string };

type TabKey =
  | "general"
  | "mqtt"
  | "filtering"
  | "map"
  | "devices"
  | "nodes"
  | "rooms"
  | "presence"
  | "advanced";

const TABS: Array<{
  key: TabKey;
  label: string;
  icon: typeof Settings2;
  hint: string;
}> = [
  { key: "general", label: "General", icon: Settings2, hint: "Timeouts and retention" },
  { key: "mqtt", label: "MQTT", icon: Radio, hint: "Broker connection" },
  { key: "filtering", label: "Filtering", icon: SlidersHorizontal, hint: "Position smoothing, Kalman, optimization" },
  { key: "map", label: "Map display", icon: MapIcon, hint: "Floor plan rendering" },
  { key: "devices", label: "Devices", icon: Smartphone, hint: "Tracked + excluded device matchers" },
  { key: "nodes", label: "Nodes", icon: Router, hint: "Per-node metadata (positions: edit on map)" },
  { key: "rooms", label: "Rooms", icon: Square, hint: "Room adjacency (polygons: edit in YAML)" },
  { key: "presence", label: "Presence", icon: MapPin, hint: "Home Assistant presence zones" },
  { key: "advanced", label: "Advanced", icon: Code, hint: "Raw YAML editor" },
];

export default function SettingsClient() {
  // The single source of truth on the client is a parsed YAML Document —
  // mutating via `doc.setIn(path, value)` preserves the user's comments
  // and untouched fields. The Document object is intentionally mutable;
  // useState holds the (stable) reference so render-time reads are
  // legitimate state reads, and `forceRender` propagates mutations.
  // We keep the *string* form alongside it so that (a) Save sends raw
  // text matching what the structured forms produced, (b) the Advanced
  // tab can edit it directly and hand it back.
  const [doc, setDoc] = useState<Document | null>(null);
  const [yaml, setYaml] = useState<string>("");
  const [original, setOriginal] = useState<string>("");
  const [configPath, setConfigPath] = useState<string>("");
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [tab, setTab] = useState<TabKey>("general");
  // Force re-render after in-place doc mutations.
  const [, forceRender] = useReducer((x: number) => x + 1, 0);

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
        setDoc(parseDocument(data.yaml));
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

  /**
   * Mutate the parsed YAML document at `path` and re-serialize. Empty
   * string and null collapse to "delete the field" so toggling something
   * back to its default doesn't leave a stale `field: ` line.
   */
  const setField = (path: ReadonlyArray<string | number>, value: unknown) => {
    if (!doc) return;
    if (value === "" || value === null || value === undefined) {
      doc.deleteIn(path);
    } else {
      doc.setIn(path, value);
    }
    setYaml(doc.toString());
    if (status.kind === "saved" || status.kind === "error") {
      setStatus({ kind: "idle" });
    }
    forceRender();
  };

  /** Append a new item to a sequence at `path`. Used by list-based tabs. */
  const addToList = (path: ReadonlyArray<string | number>, value: unknown) => {
    if (!doc) return;
    // If the sequence doesn't exist yet, set it as a new array.
    if (!doc.hasIn(path)) {
      doc.setIn(path, [value]);
    } else {
      doc.addIn(path, value);
    }
    setYaml(doc.toString());
    if (status.kind === "saved" || status.kind === "error") {
      setStatus({ kind: "idle" });
    }
    forceRender();
  };

  /** Delete a sequence element at `path` (last segment is the index). */
  const deleteAt = (path: ReadonlyArray<string | number>) => {
    if (!doc) return;
    doc.deleteIn(path);
    setYaml(doc.toString());
    if (status.kind === "saved" || status.kind === "error") {
      setStatus({ kind: "idle" });
    }
    forceRender();
  };

  /** Used by the Advanced tab — accepts raw text and re-parses. */
  const setRawYaml = (text: string) => {
    setYaml(text);
    try {
      setDoc(parseDocument(text));
    } catch {
      // leave doc pointing at the last good parse; structured forms
      // would just see stale values. Save will still send `text`.
    }
    if (status.kind === "saved" || status.kind === "error") {
      setStatus({ kind: "idle" });
    }
  };

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
    setDoc(parseDocument(original));
    setYaml(original);
    setStatus({ kind: "idle" });
    forceRender();
  };

  const restart = async () => {
    if (
      !confirm(
        "Restart the service? This will briefly drop the connection while it comes back up.",
      )
    ) {
      return;
    }
    setStatus({ kind: "restarting" });
    try {
      const res = await fetch("/api/restart", { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setStatus({
          kind: "error",
          message: data.error ?? `Restart failed (${res.status})`,
        });
        return;
      }
      const start = Date.now();
      const poll = async (): Promise<void> => {
        if (Date.now() - start > 30_000) {
          setStatus({
            kind: "error",
            message: "Service didn't come back within 30 s — check journalctl.",
          });
          return;
        }
        try {
          const ping = await fetch("/api/config", { cache: "no-store" });
          if (ping.ok) {
            window.location.reload();
            return;
          }
        } catch {
          // server is down — keep polling.
        }
        setTimeout(poll, 500);
      };
      setTimeout(poll, 1500);
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
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
      {/* Header bar — file path + status + actions */}
      <div className="flex items-center gap-3 px-4 pb-3 border-b border-zinc-200 dark:border-zinc-800 text-xs">
        <FileText className="h-3.5 w-3.5 text-zinc-400" />
        <span className="font-mono text-zinc-500 dark:text-zinc-400 truncate">
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
            onClick={restart}
            disabled={
              status.kind === "saving" ||
              status.kind === "loading" ||
              status.kind === "restarting"
            }
            className="h-7 px-2.5 inline-flex items-center gap-1.5 rounded-md text-xs font-medium border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Restart the service (required for MQTT/bootstrap config changes)"
          >
            {status.kind === "restarting" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Restart
          </button>
          <button
            type="button"
            onClick={save}
            disabled={
              !dirty || status.kind === "saving" || status.kind === "loading"
            }
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

      {/* Tab bar — horizontally scrollable on narrow widths so all tabs
          remain reachable without wrapping to a second row. Labels hide
          on the smallest viewports leaving icon-only buttons. */}
      <nav className="flex items-center gap-0.5 px-2 sm:px-4 pt-3 border-b border-zinc-200 dark:border-zinc-800 overflow-x-auto whitespace-nowrap">
        {TABS.map((t) => {
          const active = tab === t.key;
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              title={t.hint}
              className={`inline-flex items-center gap-1.5 h-9 px-2 sm:px-3 text-xs font-medium border-b-2 -mb-px transition-colors shrink-0 ${
                active
                  ? "border-blue-500 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {status.kind === "loading" || !doc ? (
          <div className="text-sm text-zinc-500 dark:text-zinc-400 p-6">Loading config…</div>
        ) : tab === "general" ? (
          <GeneralTab doc={doc} setField={setField} />
        ) : tab === "mqtt" ? (
          <MqttTab doc={doc} setField={setField} />
        ) : tab === "filtering" ? (
          <FilteringTab doc={doc} setField={setField} />
        ) : tab === "map" ? (
          <MapTab doc={doc} setField={setField} />
        ) : tab === "devices" ? (
          <DevicesTab doc={doc} setField={setField} addToList={addToList} deleteAt={deleteAt} />
        ) : tab === "nodes" ? (
          <NodesTab doc={doc} setField={setField} addToList={addToList} deleteAt={deleteAt} />
        ) : tab === "rooms" ? (
          <RoomsTab doc={doc} setField={setField} addToList={addToList} deleteAt={deleteAt} />
        ) : tab === "presence" ? (
          <PresenceTab doc={doc} setField={setField} addToList={addToList} deleteAt={deleteAt} />
        ) : (
          <AdvancedTab yaml={yaml} setRawYaml={setRawYaml} />
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-3 text-xs text-zinc-600 dark:text-zinc-400">
        <span className="truncate">
          Atomic save with schema validation. Restart needed for MQTT and
          filtering changes.
        </span>
        <span className="shrink-0 inline-flex items-center gap-1.5">
          <kbd className="font-mono px-1.5 py-px rounded border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300">
            ⌘/Ctrl+S
          </kbd>
          <span>to save</span>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared form primitives
// ---------------------------------------------------------------------------

interface SetField {
  (path: ReadonlyArray<string | number>, value: unknown): void;
}

interface AddToList {
  (path: ReadonlyArray<string | number>, value: unknown): void;
}

interface DeleteAt {
  (path: ReadonlyArray<string | number>): void;
}

interface DocProps {
  doc: Document;
  setField: SetField;
}

interface DocListProps extends DocProps {
  addToList: AddToList;
  deleteAt: DeleteAt;
}

/** Helper: read a scalar from the doc, returning a fallback if missing. */
function get<T>(doc: Document, path: ReadonlyArray<string | number>, fallback: T): T {
  const v = doc.getIn(path) as unknown;
  return v == null ? fallback : (v as T);
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 @md:grid-cols-[220px_1fr] gap-3 items-start py-2.5 border-b border-zinc-100 dark:border-zinc-800/50">
      <div className="pt-1.5">
        <div className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
          {label}
        </div>
        {hint && (
          <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 leading-relaxed">
            {hint}
          </div>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="@container px-4 sm:px-6 pt-5 pb-2 max-w-3xl">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        {title}
      </h2>
      {description && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 mb-2 leading-relaxed">
          {description}
        </p>
      )}
      <div className="mt-2">{children}</div>
    </section>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "password";
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full max-w-md h-8 px-2.5 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
    />
  );
}

function NumberInput({
  value,
  onChange,
  step = 1,
  min,
  max,
  unit,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
}) {
  return (
    <div className="inline-flex items-center gap-2">
      <input
        type="number"
        value={value ?? ""}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return onChange(undefined);
          const n = Number(raw);
          if (Number.isFinite(n)) onChange(n);
        }}
        className="w-32 h-8 px-2.5 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-xs font-mono tabular-nums focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      {unit && (
        <span className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">{unit}</span>
      )}
    </div>
  );
}

function Toggle({
  value,
  onChange,
  label,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none">
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`relative inline-flex items-center h-5 w-9 rounded-full transition-colors ${
          value ? "bg-blue-600" : "bg-zinc-300 dark:bg-zinc-700"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform ${
            value ? "translate-x-5" : "translate-x-1"
          }`}
        />
      </button>
      {label && (
        <span className="text-xs text-zinc-700 dark:text-zinc-300">{label}</span>
      )}
    </label>
  );
}

function Select<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; hint?: string }>;
}) {
  return (
    <div className="inline-flex flex-wrap gap-1.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            title={o.hint}
            className={`h-8 px-3 inline-flex items-center rounded-md text-xs font-medium border transition-colors ${
              active
                ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300"
                : "border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function GeneralTab({ doc, setField }: DocProps) {
  return (
    <>
      <Section
        title="HA presence publishing"
        description="Disable to run the hub locally without pushing state to Home Assistant. Solving, calibration, and the local UI all keep running — only the outbound MQTT state/attributes/discovery messages are suppressed."
      >
        <Field
          label="Publish presence"
          hint="Turn off when running a local dev instance alongside a production hub. No restart needed — takes effect on the next position update."
        >
          <Toggle
            value={get<boolean>(doc, ["publish_presence"], true)}
            onChange={(v) => setField(["publish_presence"], v)}
            label={get<boolean>(doc, ["publish_presence"], true) ? "On" : "Off (dry-run mode)"}
          />
        </Field>
      </Section>

      <Section
        title="Timeouts and retention"
        description="Restart not required — applied on the next solve / cleanup tick."
      >
        <Field
          label="Device timeout"
          hint="Drop measurements older than this many seconds. Devices that haven't reported recently fall out of live tracking."
        >
          <NumberInput
            value={get<number>(doc, ["timeout"], 30)}
            onChange={(v) => setField(["timeout"], v)}
            min={5}
            step={5}
            unit="seconds"
          />
        </Field>
        <Field
          label="Away timeout"
          hint="Mark a device as 'away' after this many seconds without a fresh fix."
        >
          <NumberInput
            value={get<number>(doc, ["away_timeout"], 120)}
            onChange={(v) => setField(["away_timeout"], v)}
            min={10}
            step={10}
            unit="seconds"
          />
        </Field>
        <Field
          label="Device retention"
          hint="How long to remember a device after it goes away. Duration string like '30d', '12h', '2w'."
        >
          <TextInput
            value={get<string>(doc, ["device_retention"], "30d")}
            onChange={(v) => setField(["device_retention"], v)}
            placeholder="30d"
          />
        </Field>
      </Section>

    </>
  );
}

function MqttTab({ doc, setField }: DocProps) {
  return (
    <Section
      title="MQTT broker"
      description="Connection to the MQTT broker your ESPresense nodes publish to. Service restart required after any change here — the connection is opened once at boot."
    >
      <Field label="Host" hint="MQTT broker hostname or IP address.">
        <TextInput
          value={get<string>(doc, ["mqtt", "host"], "")}
          onChange={(v) => setField(["mqtt", "host"], v)}
          placeholder="192.168.1.51"
        />
      </Field>
      <Field label="Port" hint="Default 1883 for plain, 8883 for TLS.">
        <NumberInput
          value={get<number>(doc, ["mqtt", "port"], 1883)}
          onChange={(v) => setField(["mqtt", "port"], v)}
          min={1}
          max={65535}
        />
      </Field>
      <Field label="TLS" hint="Use SSL/TLS for the broker connection.">
        <Toggle
          value={get<boolean>(doc, ["mqtt", "ssl"], false)}
          onChange={(v) => setField(["mqtt", "ssl"], v)}
        />
      </Field>
      <Field label="Username" hint="Leave empty for anonymous brokers.">
        <TextInput
          value={get<string>(doc, ["mqtt", "username"], "")}
          onChange={(v) => setField(["mqtt", "username"], v)}
        />
      </Field>
      <Field label="Password">
        <TextInput
          type="password"
          value={get<string>(doc, ["mqtt", "password"], "")}
          onChange={(v) => setField(["mqtt", "password"], v)}
        />
      </Field>
      <Field
        label="Client ID"
        hint="MQTT client identifier. Should be unique on the broker."
      >
        <TextInput
          value={get<string>(doc, ["mqtt", "client_id"], "espresense-hub")}
          onChange={(v) => setField(["mqtt", "client_id"], v)}
        />
      </Field>
      <Field
        label="HA discovery topic"
        hint="Home Assistant discovery topic prefix. Defaults to 'homeassistant'."
      >
        <TextInput
          value={get<string>(doc, ["mqtt", "discovery_topic"], "homeassistant")}
          onChange={(v) => setField(["mqtt", "discovery_topic"], v)}
        />
      </Field>
    </Section>
  );
}

function FilteringTab({ doc, setField }: DocProps) {
  const filter = get<string>(doc, ["filtering", "position_filter"], "kalman");
  return (
    <>
      <Section
        title="Position filter"
        description="Smooths the locator's per-message output. Service restart required."
      >
        <Field
          label="Algorithm"
          hint="Kalman tracks position AND velocity — best for moving devices. EMA is a simple time-weighted average. None passes raw locator output through unfiltered."
        >
          <Select<"kalman" | "ema" | "none">
            value={filter as "kalman" | "ema" | "none"}
            onChange={(v) => setField(["filtering", "position_filter"], v)}
            options={[
              { value: "kalman", label: "Kalman", hint: "Velocity-aware (default)" },
              { value: "ema", label: "EMA", hint: "Simple smoothing" },
              { value: "none", label: "None", hint: "Raw passthrough" },
            ]}
          />
        </Field>
      </Section>

      {filter === "kalman" && (
        <Section
          title="Kalman tuning"
          description="Knobs for the Kalman filter. Defaults are good for indoor walking; tweak only if you see specific issues."
        >
          <Field
            label="Process noise (σ_a)"
            hint="Std dev of expected acceleration in m/s². Higher = more responsive to direction changes, more jitter. 0.5 ≈ walking; 1.5+ ≈ phone being waved around."
          >
            <NumberInput
              value={get<number>(doc, ["filtering", "kalman_process_noise"], 0.5)}
              onChange={(v) => setField(["filtering", "kalman_process_noise"], v)}
              step={0.1}
              min={0.001}
              max={5}
              unit="m/s²"
            />
          </Field>
          <Field
            label="Measurement noise (σ_m)"
            hint="Base std dev of locator output position error, in meters. Scaled per-update by 1/confidence. 0.5 m matches our locator's typical accuracy well."
          >
            <NumberInput
              value={get<number>(doc, ["filtering", "kalman_measurement_noise"], 0.5)}
              onChange={(v) =>
                setField(["filtering", "kalman_measurement_noise"], v)
              }
              step={0.1}
              min={0.001}
              max={5}
              unit="m"
            />
          </Field>
        </Section>
      )}

      {filter === "ema" && (
        <Section
          title="EMA tuning"
          description="Output-side smoothing weight for the simple EMA filter."
        >
          <Field
            label="Smoothing weight (output)"
            hint="0 = no smoothing, 1 = very heavy. The same value also drives the input-side per-node EMA below."
          >
            <NumberInput
              value={get<number>(doc, ["filtering", "smoothing_weight"], 0.4)}
              onChange={(v) => setField(["filtering", "smoothing_weight"], v)}
              step={0.05}
              min={0}
              max={1}
            />
          </Field>
        </Section>
      )}

      <Section
        title="Input smoothing"
        description="Per-node distance EMA applied before the locator runs. Reduces RSSI jitter so the solver sees cleaner inputs. Affects both Kalman and EMA pipelines."
      >
        <Field
          label="Smoothing weight (input)"
          hint="0 = raw RSSI distances. 0.4 (default) ≈ 1.5 s τ. 0.7 (upstream default) ≈ 3.5 s τ — heavy, adds noticeable lag before the solver."
        >
          <NumberInput
            value={get<number>(doc, ["filtering", "smoothing_weight"], 0.4)}
            onChange={(v) => setField(["filtering", "smoothing_weight"], v)}
            step={0.05}
            min={0}
            max={1}
          />
        </Field>
      </Section>

      <Section
        title="Room hysteresis"
        description="Smooths HA room-tracker flicker when a device wobbles at a wall boundary. Only affects published state — the map still shows the raw position. Service restart required."
      >
        <Field
          label="Room stability window"
          hint="Require a device to register in a new room for at least this many milliseconds before the HA state flips. 0 = off. Try 1000–2000 ms for a balanced value; higher to be stricter at the cost of slower transitions."
        >
          <NumberInput
            value={get<number>(doc, ["filtering", "room_stability_ms"], 0)}
            onChange={(v) => setField(["filtering", "room_stability_ms"], v)}
            step={100}
            min={0}
            unit="ms"
          />
        </Field>
      </Section>

      <Section
        title="Auto-apply"
        description="Background loop that pushes small streaming-per-pair calibration deltas to firmware over MQTT. Per-node rate limit (10 min) and minimum delta gate every push."
      >
        <Field
          label="Enabled"
          hint="Master switch. When off, the loop never runs. You can still manually preview + apply via the calibration page."
        >
          <Toggle
            value={get<boolean>(doc, ["optimization", "enabled"], true)}
            onChange={(v) => setField(["optimization", "enabled"], v)}
          />
        </Field>
        <Field
          label="Cycle interval"
          hint="How often the loop wakes up to consider pushes. Default 300 s (5 min). The 10-min per-node rate limit caps re-pushes to once per node regardless of cycle frequency, so dropping this below ~120 s only matters across many nodes."
        >
          <NumberInput
            value={get<number>(doc, ["optimization", "interval_secs"], 300)}
            onChange={(v) => setField(["optimization", "interval_secs"], v)}
            min={60}
            step={60}
            unit="seconds"
          />
        </Field>
        <Field
          label="Minimum delta"
          hint="Smallest change in path-loss exponent that triggers an MQTT push. Default 0.10. Lower values (e.g. 0.05) track every tiny drift in the audit log but churn NVS flash writes on the ESP32; higher (0.15–0.20) keeps logs and flash writes quieter at the cost of slightly slower convergence. A 0.05 shift in exponent moves distance estimates only ~2–4% at typical ranges."
        >
          <NumberInput
            value={get<number>(doc, ["optimization", "min_delta"], 0.1)}
            onChange={(v) => setField(["optimization", "min_delta"], v)}
            min={0.01}
            step={0.01}
          />
        </Field>
      </Section>
    </>
  );
}

function MapTab({ doc, setField }: DocProps) {
  return (
    <Section
      title="Map display"
      description="How the floor plan is rendered. Changes apply on the next page load."
    >
      <Field label="Flip X axis" hint="Mirror the map left/right.">
        <Toggle
          value={get<boolean>(doc, ["map", "flip_x"], false)}
          onChange={(v) => setField(["map", "flip_x"], v)}
        />
      </Field>
      <Field
        label="Flip Y axis"
        hint="Mirror the map top/bottom. Default true matches typical floorplan-up conventions."
      >
        <Toggle
          value={get<boolean>(doc, ["map", "flip_y"], true)}
          onChange={(v) => setField(["map", "flip_y"], v)}
        />
      </Field>
      <Field
        label="Wall thickness"
        hint="Visual stroke width for room walls, in meters."
      >
        <NumberInput
          value={get<number>(doc, ["map", "wall_thickness"], 0.1)}
          onChange={(v) => setField(["map", "wall_thickness"], v)}
          step={0.05}
          min={0}
          unit="m"
        />
      </Field>
      <Field
        label="Wall color"
        hint="CSS color for walls. Leave empty to use the default theme color."
      >
        <TextInput
          value={get<string>(doc, ["map", "wall_color"], "")}
          onChange={(v) => setField(["map", "wall_color"], v)}
          placeholder="#94a3b8"
        />
      </Field>
      <Field
        label="Wall opacity"
        hint="0 = invisible, 1 = solid. 0.35 default."
      >
        <NumberInput
          value={get<number>(doc, ["map", "wall_opacity"], 0.35)}
          onChange={(v) => setField(["map", "wall_opacity"], v)}
          step={0.05}
          min={0}
          max={1}
        />
      </Field>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// List-based tabs (Devices, Nodes, Rooms)
// ---------------------------------------------------------------------------

/**
 * Generic row container used by Devices / Nodes / Rooms. Renders the
 * supplied children in a card-like row with a delete button on the
 * right. Caller composes the actual fields inside.
 */
function ListRow({
  onDelete,
  children,
}: {
  onDelete: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="@container flex items-start gap-3 p-3 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 mb-2">
      <div className="flex-1 min-w-0 grid grid-cols-1 @md:grid-cols-2 @xl:grid-cols-3 gap-x-4 gap-y-2">
        {children}
      </div>
      <button
        type="button"
        onClick={onDelete}
        className="shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-md text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
        title="Delete this entry"
        aria-label="Delete"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * Compact label + control for use inside a ListRow. The list-tab grid
 * is denser than the Field component — labels go on top, not to the side.
 */
function MiniField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block min-w-0">
      <span
        className="block text-xs uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-0.5"
        title={hint}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

/** Empty-state message for a list with no entries. */
function EmptyList({ message }: { message: string }) {
  return (
    <div className="text-xs text-zinc-500 dark:text-zinc-400 italic px-3 py-4 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-md">
      {message}
    </div>
  );
}

/** Add-button for list tabs. */
function AddButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-3 inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300"
    >
      <Plus className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

interface DeviceMatch {
  id?: string;
  name?: string;
}

function DevicesTab({ doc, setField, addToList, deleteAt }: DocListProps) {
  const data = doc.toJS() as { devices?: DeviceMatch[]; exclude_devices?: DeviceMatch[] };
  const tracked = data.devices ?? [];
  const excluded = data.exclude_devices ?? [];
  return (
    <>
      <Section
        title="Tracked devices"
        description="Allowlist for devices the hub should track. Each entry can specify an ID (BLE MAC, IRK, alias) and/or a name; a device matches if EITHER pattern matches (not AND). Both fields support `*` wildcards. Leave this list empty to track every device the hub hears (the typical default — let the hub auto-discover, then add noisy entries to Excluded below). Service restart required."
      >
        {tracked.length === 0 ? (
          <EmptyList message="No tracked-device rules. With this list empty, every device the hub hears gets tracked." />
        ) : (
          tracked.map((d, i) => (
            <ListRow
              key={`t-${i}`}
              onDelete={() => deleteAt(["devices", i])}
            >
              <MiniField label="ID" hint="BLE MAC, IRK, or alias">
                <TextInput
                  value={d.id ?? ""}
                  onChange={(v) => setField(["devices", i, "id"], v)}
                  placeholder="irk:..."
                />
              </MiniField>
              <MiniField label="Name">
                <TextInput
                  value={d.name ?? ""}
                  onChange={(v) => setField(["devices", i, "name"], v)}
                  placeholder="Nick's Watch"
                />
              </MiniField>
            </ListRow>
          ))
        )}
        <AddButton
          label="Add tracked-device rule"
          onClick={() => addToList(["devices"], { id: "", name: "" })}
        />
      </Section>

      <Section
        title="Excluded devices"
        description="Denylist — matches here are dropped before the include check, so a device in both lists is excluded. Same OR-match-with-`*`-wildcards semantics as the tracked list. Useful for filtering BLE noise from passing phones, beacons, neighbors' devices."
      >
        {excluded.length === 0 ? (
          <EmptyList message="No exclusion rules." />
        ) : (
          excluded.map((d, i) => (
            <ListRow
              key={`x-${i}`}
              onDelete={() => deleteAt(["exclude_devices", i])}
            >
              <MiniField label="ID">
                <TextInput
                  value={d.id ?? ""}
                  onChange={(v) =>
                    setField(["exclude_devices", i, "id"], v)
                  }
                />
              </MiniField>
              <MiniField label="Name">
                <TextInput
                  value={d.name ?? ""}
                  onChange={(v) =>
                    setField(["exclude_devices", i, "name"], v)
                  }
                />
              </MiniField>
            </ListRow>
          ))
        )}
        <AddButton
          label="Add exclusion rule"
          onClick={() => addToList(["exclude_devices"], { id: "", name: "" })}
        />
      </Section>
    </>
  );
}

interface NodeData {
  id?: string;
  name?: string;
  point?: [number, number, number];
  room?: string;
  enabled?: boolean;
  stationary?: boolean;
  floors?: string[];
}

function NodesTab({ doc, setField, addToList, deleteAt }: DocListProps) {
  const data = doc.toJS() as { nodes?: NodeData[] };
  const nodes = data.nodes ?? [];
  return (
    <Section
      title="Nodes"
      description="ESPresense node metadata. Position (x,y,z) is editable on the map — click a node and use the editor panel. Enabled/stationary/room-override live here. Service restart required for some changes."
    >
      {nodes.length === 0 ? (
        <EmptyList message="No nodes configured. Add one here, then drag it into position on the map." />
      ) : (
        nodes.map((n, i) => {
          const point = n.point;
          const ptStr = point
            ? `(${point[0].toFixed(2)}, ${point[1].toFixed(2)}, ${point[2].toFixed(2)})`
            : "—";
          return (
            <ListRow key={`n-${i}`} onDelete={() => deleteAt(["nodes", i])}>
              <MiniField label="Name" hint="Display name; ID is auto-derived if absent">
                <TextInput
                  value={n.name ?? ""}
                  onChange={(v) => setField(["nodes", i, "name"], v)}
                  placeholder="living_room"
                />
              </MiniField>
              <MiniField
                label="Room override"
                hint="Optional. Skip the polygon point-in-room check; force this room. Useful for nodes mounted on a boundary."
              >
                <TextInput
                  value={n.room ?? ""}
                  onChange={(v) => setField(["nodes", i, "room"], v)}
                  placeholder="(auto)"
                />
              </MiniField>
              <MiniField
                label="Position"
                hint="Edit on the map: click the node, then use the position editor"
              >
                <span className="inline-block h-8 px-2.5 leading-8 rounded-md border border-dashed border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 text-xs font-mono text-zinc-500 dark:text-zinc-400 max-w-md truncate">
                  {ptStr}
                </span>
              </MiniField>
              <MiniField
                label="Enabled"
                hint="Disabled nodes don't participate in the mesh or solves"
              >
                <Toggle
                  value={n.enabled ?? true}
                  onChange={(v) => setField(["nodes", i, "enabled"], v)}
                />
              </MiniField>
              <MiniField
                label="Stationary"
                hint="Whether this node's own position is fixed (true) or could move (false)"
              >
                <Toggle
                  value={n.stationary ?? true}
                  onChange={(v) => setField(["nodes", i, "stationary"], v)}
                />
              </MiniField>
            </ListRow>
          );
        })
      )}
      <AddButton
        label="Add node"
        onClick={() =>
          addToList(["nodes"], {
            name: "new_node",
            point: [0, 0, 1],
            enabled: true,
            stationary: true,
          })
        }
      />
    </Section>
  );
}

type OpenToEntry = string | { id: string; door?: [number, number] };

interface RoomData {
  id?: string;
  name?: string;
  points?: Array<[number, number]>;
  open_to?: OpenToEntry[];
  floor_area?: string;
}

function openToEntryId(e: OpenToEntry): string {
  return typeof e === "string" ? e : e.id;
}

function RoomsTab({ doc, setField, addToList, deleteAt }: DocListProps) {
  const data = doc.toJS() as { floors?: Array<{ rooms?: RoomData[] }> };
  const floors = data.floors ?? [];
  // Most homes have a single floor. We surface rooms across all floors,
  // labeled with their floor index when there's more than one. Polygon
  // edits stay in the YAML / map UI; this tab is just adjacency.
  if (floors.length === 0) {
    return (
      <Section
        title="Rooms"
        description="No floors configured. Add a floor and rooms via the Advanced YAML tab first; once defined, adjacency is editable here."
      >
        <EmptyList message="No floors defined." />
      </Section>
    );
  }
  return (
    <>
      {floors.map((floor, fi) => {
        const rooms = floor.rooms ?? [];
        const sectionTitle =
          floors.length === 1
            ? "Rooms"
            : `Rooms · floor ${fi + 1}`;
        return (
          <Section
            key={`floor-${fi}`}
            title={sectionTitle}
            description={
              fi === 0
                ? "Adjacency settings only — polygon vertices stay in the YAML editor or the map. `floor_area` groups rooms into a mutually-adjacent clique (open-plan zones). `open_to` declares per-pair doorways."
                : undefined
            }
          >
            {rooms.length === 0 ? (
              <EmptyList message="No rooms on this floor." />
            ) : (
              rooms.map((r, ri) => {
                const ptCount = r.points?.length ?? 0;
                const rawOpenTo = r.open_to ?? [];
                // Extract plain ids for display; preserve object entries (door
                // positions) when writing back so map-edited door data isn't lost.
                const openToIds = rawOpenTo.map(openToEntryId);
                const objsByid = new Map(
                  rawOpenTo
                    .filter((e): e is { id: string; door?: [number, number] } => typeof e === "object" && e !== null)
                    .map((e) => [e.id, e]),
                );
                return (
                  <ListRow
                    key={`r-${fi}-${ri}`}
                    onDelete={() =>
                      deleteAt(["floors", fi, "rooms", ri])
                    }
                  >
                    <MiniField label="Name">
                      <TextInput
                        value={r.name ?? ""}
                        onChange={(v) =>
                          setField(["floors", fi, "rooms", ri, "name"], v)
                        }
                        placeholder="Living Room"
                      />
                    </MiniField>
                    <MiniField
                      label="Floor area"
                      hint="Tag for an open-plan zone. All rooms sharing this string become mutually adjacent."
                    >
                      <TextInput
                        value={r.floor_area ?? ""}
                        onChange={(v) =>
                          setField(
                            ["floors", fi, "rooms", ri, "floor_area"],
                            v,
                          )
                        }
                        placeholder="(none)"
                      />
                    </MiniField>
                    <MiniField
                      label={`Polygon (${ptCount} pts)`}
                      hint="Edit polygon vertices in the Advanced YAML tab"
                    >
                      <span className="inline-block h-8 px-2.5 leading-8 rounded-md border border-dashed border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 text-xs font-mono text-zinc-500 dark:text-zinc-400">
                        {ptCount} vertices
                      </span>
                    </MiniField>
                    <MiniField
                      label="Open to"
                      hint="Comma-separated list of room names this room has a doorway to. Bidirectional. Door positions are set via the map tool."
                    >
                      <CommaList
                        value={openToIds}
                        onChange={(arr) => {
                          // Re-attach any existing door objects for ids still present.
                          const merged = (arr ?? []).map((id) => objsByid.get(id) ?? id);
                          setField(["floors", fi, "rooms", ri, "open_to"], merged.length > 0 ? merged : null);
                        }}
                        placeholder="Hallway, Kitchen"
                      />
                      {/* Door position editor per connection. Editing x/y
                          directly here is a pragmatic shortcut — spatial
                          click-to-place on the map tool is still available,
                          but typing coords is faster for tweaks. */}
                      {objsByid.size > 0 && (
                        <div className="mt-2 space-y-1">
                          {[...objsByid.values()].map((e) => {
                            const [dx, dy] = e.door ?? [0, 0];
                            const updateDoor = (newX: number | undefined, newY: number | undefined) => {
                              const x = newX ?? dx;
                              const y = newY ?? dy;
                              // Rebuild open_to preserving order; swap this
                              // entry's door while leaving everything else alone.
                              const next = rawOpenTo.map((entry) => {
                                if (typeof entry === "string") return entry;
                                if (entry.id !== e.id) return entry;
                                return { ...entry, door: [x, y] as [number, number] };
                              });
                              setField(["floors", fi, "rooms", ri, "open_to"], next);
                            };
                            const clearDoor = () => {
                              const next = rawOpenTo.map((entry) => {
                                if (typeof entry === "string") return entry;
                                if (entry.id !== e.id) return entry;
                                return entry.id; // downgrade to plain string
                              });
                              setField(["floors", fi, "rooms", ri, "open_to"], next);
                            };
                            return (
                              <div key={e.id} className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs text-zinc-700 dark:text-zinc-300 w-24 truncate">
                                  {e.id}
                                </span>
                                <span className="text-[11px] text-zinc-400">x</span>
                                <input
                                  type="number"
                                  step={0.01}
                                  value={dx}
                                  onChange={(ev) => {
                                    const v = Number(ev.target.value);
                                    if (Number.isFinite(v)) updateDoor(v, undefined);
                                  }}
                                  className="w-20 h-7 px-1.5 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-xs font-mono tabular-nums focus:outline-none focus:ring-1 focus:ring-blue-500"
                                />
                                <span className="text-[11px] text-zinc-400">y</span>
                                <input
                                  type="number"
                                  step={0.01}
                                  value={dy}
                                  onChange={(ev) => {
                                    const v = Number(ev.target.value);
                                    if (Number.isFinite(v)) updateDoor(undefined, v);
                                  }}
                                  className="w-20 h-7 px-1.5 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-xs font-mono tabular-nums focus:outline-none focus:ring-1 focus:ring-blue-500"
                                />
                                <button
                                  type="button"
                                  onClick={clearDoor}
                                  className="h-6 w-6 inline-flex items-center justify-center rounded text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                                  title="Clear door position (keep connection)"
                                  aria-label="Clear door"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </MiniField>
                  </ListRow>
                );
              })
            )}
            <AddButton
              label="Add room"
              onClick={() =>
                addToList(["floors", fi, "rooms"], {
                  name: "New Room",
                  points: [[0, 0], [1, 0], [1, 1], [0, 1]],
                })
              }
            />
          </Section>
        );
      })}
    </>
  );
}

interface PresenceZoneData {
  id?: string;
  label?: string;
  rooms?: string[];
}

function PresenceTab({ doc, setField, addToList, deleteAt }: DocListProps) {
  const data = doc.toJS() as { presence?: { zones?: PresenceZoneData[] } };
  const zones = data.presence?.zones ?? [];

  return (
    <>
      <Section
        title="Presence zones"
        description="Extra Home Assistant device_tracker entities published alongside the default room-level tracker. Each zone maps a set of rooms to a coarser label so automations can target an area (e.g. 'Master Suite') without OR conditions across multiple rooms. Changes apply on the next position update — no restart required."
      >
        {zones.length === 0 ? (
          <EmptyList message="No zones configured. By default the hub publishes one tracker per device at room → floor → not_home granularity (espresense/hub/{deviceId})." />
        ) : (
          zones.map((z, i) => (
            <ListRow
              key={`z-${i}`}
              onDelete={() => deleteAt(["presence", "zones", i])}
            >
              <MiniField label="ID" hint="Slug used in the MQTT topic and HA unique_id. No spaces.">
                <TextInput
                  value={z.id ?? ""}
                  onChange={(v) => setField(["presence", "zones", i, "id"], v)}
                  placeholder="master_suite"
                />
              </MiniField>
              <MiniField label="Label" hint="Human-readable HA entity name. Defaults to id if blank.">
                <TextInput
                  value={z.label ?? ""}
                  onChange={(v) =>
                    setField(["presence", "zones", i, "label"], v || undefined)
                  }
                  placeholder="Master Suite"
                />
              </MiniField>
              <MiniField
                label="Rooms"
                hint="Comma-separated room ids/names. Device is 'in zone' when it's in any of these rooms."
              >
                <CommaList
                  value={z.rooms ?? []}
                  onChange={(v) =>
                    setField(["presence", "zones", i, "rooms"], v ?? [])
                  }
                  placeholder="master_bedroom, master_bathroom, master_closet"
                />
              </MiniField>
            </ListRow>
          ))
        )}
        <AddButton
          label="Add zone"
          onClick={() =>
            addToList(["presence", "zones"], {
              id: "new_zone",
              label: "New Zone",
              rooms: [],
            })
          }
        />
      </Section>
    </>
  );
}

/** Comma-separated list editor — one input, splits on commas. */
function CommaList({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[] | undefined) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      value={value.join(", ")}
      onChange={(e) => {
        const parts = e.target.value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        onChange(parts.length > 0 ? parts : undefined);
      }}
      placeholder={placeholder}
      className="w-full max-w-md h-8 px-2.5 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
    />
  );
}

function AdvancedTab({
  yaml,
  setRawYaml,
}: {
  yaml: string;
  setRawYaml: (text: string) => void;
}) {
  return (
    <div className="h-full p-4">
      <textarea
        value={yaml}
        onChange={(e) => setRawYaml(e.target.value)}
        spellCheck={false}
        className="w-full h-full min-h-[400px] resize-none rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        Raw YAML editor for fields not exposed in the structured tabs (floors,
        rooms, nodes, devices, locator weights, etc.). Validated on save.
      </p>
    </div>
  );
}
