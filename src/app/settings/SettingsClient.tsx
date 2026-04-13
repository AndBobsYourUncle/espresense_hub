"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { parseDocument, type Document } from "yaml";
import {
  AlertCircle,
  Check,
  FileText,
  Loader2,
  RefreshCw,
  Save,
  Settings2,
  SlidersHorizontal,
  Radio,
  Code,
  Map as MapIcon,
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

type TabKey = "general" | "mqtt" | "filtering" | "map" | "advanced";

const TABS: Array<{
  key: TabKey;
  label: string;
  icon: typeof Settings2;
  hint: string;
}> = [
  { key: "general", label: "General", icon: Settings2, hint: "Timeouts, retention" },
  { key: "mqtt", label: "MQTT", icon: Radio, hint: "Broker connection" },
  { key: "filtering", label: "Filtering", icon: SlidersHorizontal, hint: "Position smoothing & Kalman tuning" },
  { key: "map", label: "Map display", icon: MapIcon, hint: "Floor plan rendering" },
  { key: "advanced", label: "Advanced", icon: Code, hint: "Raw YAML editor" },
];

export default function SettingsClient() {
  // The single source of truth on the client is a parsed YAML Document —
  // mutating via `doc.setIn(path, value)` preserves the user's comments
  // and untouched fields. We keep the *string* form alongside it so that
  // (a) Save sends raw text matching what the structured forms produced,
  // (b) the Advanced tab can edit it directly and hand it back.
  const docRef = useRef<Document | null>(null);
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
        docRef.current = parseDocument(data.yaml);
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
    const doc = docRef.current;
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

  /** Used by the Advanced tab — accepts raw text and re-parses. */
  const setRawYaml = (text: string) => {
    setYaml(text);
    try {
      docRef.current = parseDocument(text);
    } catch {
      // leave docRef pointing at the last good parse; structured forms
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
    docRef.current = parseDocument(original);
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

  const doc = docRef.current;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header bar — file path + status + actions */}
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

      {/* Tab bar */}
      <nav className="flex items-center gap-0.5 px-4 pt-3 border-b border-zinc-200 dark:border-zinc-800">
        {TABS.map((t) => {
          const active = tab === t.key;
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              title={t.hint}
              className={`inline-flex items-center gap-1.5 h-9 px-3 text-xs font-medium border-b-2 -mb-px transition-colors ${
                active
                  ? "border-blue-500 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          );
        })}
      </nav>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {status.kind === "loading" || !doc ? (
          <div className="text-sm text-zinc-500 p-6">Loading config…</div>
        ) : tab === "general" ? (
          <GeneralTab doc={doc} setField={setField} />
        ) : tab === "mqtt" ? (
          <MqttTab doc={doc} setField={setField} />
        ) : tab === "filtering" ? (
          <FilteringTab doc={doc} setField={setField} />
        ) : tab === "map" ? (
          <MapTab doc={doc} setField={setField} />
        ) : (
          <AdvancedTab yaml={yaml} setRawYaml={setRawYaml} />
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-zinc-200 dark:border-zinc-800 text-[11px] text-zinc-500 leading-relaxed">
        Validated against the schema before writing. Atomic write — a partial
        save can&apos;t corrupt the file. Comments and untouched fields are
        preserved through structured edits. Most changes apply live; MQTT and
        filtering settings need a service restart.{" "}
        <kbd className="font-mono text-[10px] px-1 py-px rounded border border-zinc-300 dark:border-zinc-700">
          ⌘/Ctrl+S
        </kbd>{" "}
        to save.
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

interface DocProps {
  doc: Document;
  setField: SetField;
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
    <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-3 items-start py-2.5 border-b border-zinc-100 dark:border-zinc-800/50">
      <div className="pt-1.5">
        <div className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
          {label}
        </div>
        {hint && (
          <div className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
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
    <section className="px-6 pt-5 pb-2 max-w-3xl">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        {title}
      </h2>
      {description && (
        <p className="text-[11px] text-zinc-500 mt-1 mb-2 leading-relaxed">
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
        <span className="text-[11px] text-zinc-500 font-mono">{unit}</span>
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
    <Section
      title="General"
      description="Timeouts and retention. Service restart not required for these — they apply on the next solve."
    >
      <Field
        label="Device timeout"
        hint="Drop measurements older than this many seconds. Devices that haven't reported recently fall out of the live tracking."
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
        hint="Mark a device as 'away' (no longer tracked) after this many seconds without a fresh fix."
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
        hint="How long to remember a device after it goes away. Format: a duration string like '30d', '12h', '2w'."
      >
        <TextInput
          value={get<string>(doc, ["device_retention"], "30d")}
          onChange={(v) => setField(["device_retention"], v)}
          placeholder="30d"
        />
      </Field>
    </Section>
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
      <p className="mt-2 text-[11px] text-zinc-500">
        Raw YAML editor for fields not exposed in the structured tabs (floors,
        rooms, nodes, devices, locator weights, etc.). Validated on save.
      </p>
    </div>
  );
}
