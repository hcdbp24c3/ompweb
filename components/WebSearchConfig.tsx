"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Globe, KeyRound, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";

/**
 * Web-search credentials, rendered from the server's schema.
 *
 * The field list is NOT written here. `/api/web-search-keys` returns the same
 * backend definitions omp is driven by (label, env var, kind, required-ness), so
 * a backend added to omp shows up with a correct editor instead of needing a
 * matching change in this file — which is the mistake a hardcoded key form
 * always eventually makes.
 *
 * Two behaviours are load-bearing rather than cosmetic:
 *
 *  - The schema is fetched, so on a surface where it has not loaded every field
 *    is disabled. An editor that guessed the shape would let someone save a key
 *    omp never reads, and the failure would surface as an opaque 401 later.
 *  - A stored value is never fetched back, so a configured field renders as a
 *    masked placeholder with a Clear action. Saving an untouched field keeps the
 *    stored value: the server only writes what the browser sent, and the browser
 *    never had the old one to send.
 */

interface FieldSchema {
  env: string;
  label: string;
  kind: "apiKey" | "url" | "text";
  optional?: boolean;
}

interface BackendSchema {
  id: string;
  label: string;
  fields: FieldSchema[];
}

interface BackendStatus {
  id: string;
  label: string;
  fields: Array<FieldSchema & { hasValue: boolean }>;
  configured: boolean;
}

interface Listing {
  backends: BackendStatus[];
  backendsSchema: BackendSchema[];
}

export function WebSearchConfig() {
  const { t } = useI18n();
  const [schema, setSchema] = useState<BackendSchema[] | null>(null);
  const [status, setStatus] = useState<BackendStatus[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/web-search-keys");
      const data = (await response.json()) as Listing & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      setSchema(data.backendsSchema ?? []);
      setStatus(Array.isArray(data.backends) ? data.backends : []);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const byId = useMemo(() => new Map(status.map((entry) => [entry.id, entry])), [status]);
  const configuredCount = status.filter((entry) => entry.configured).length;

  const save = async (backendId: string, values: Record<string, string>) => {
    setBusy(backendId);
    setError(null);
    try {
      const response = await fetch("/api/web-search-keys", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: backendId, values }),
      });
      const data = (await response.json()) as Listing & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      setStatus(Array.isArray(data.backends) ? data.backends : []);
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[backendId];
        return next;
      });
      toast.success(t("webSearch.saved"));
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      setError(message);
      toast.error(t("webSearch.saveFailed"), message);
    } finally {
      setBusy(null);
    }
  };

  const clear = async (backendId: string) => {
    setBusy(backendId);
    setError(null);
    try {
      const response = await fetch(`/api/web-search-keys?backend=${encodeURIComponent(backendId)}`, { method: "DELETE" });
      const data = (await response.json()) as Listing & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      setStatus(Array.isArray(data.backends) ? data.backends : []);
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[backendId];
        return next;
      });
      toast.success(t("webSearch.cleared"));
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      setError(message);
      toast.error(t("webSearch.clearFailed"), message);
    } finally {
      setBusy(null);
    }
  };

  const cardStyle: React.CSSProperties = {
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-card)",
    background: "var(--bg-panel)",
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  };

  return (
    <section aria-label={t("webSearch.heading")} style={{ marginTop: 24 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <h3 className="display-serif" style={{ fontSize: 16, fontWeight: 600, margin: 0, color: "var(--text)" }}>
          <Globe size={15} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 6 }} />
          {t("webSearch.heading")}
        </h3>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {schema === null ? t("webSearch.loading") : tn(t, configuredCount, status.length)}
        </span>
      </div>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "4px 0 12px", lineHeight: 1.5 }}>
        {t("webSearch.description")}
      </p>

      {error && (
        <div role="alert" style={{ fontSize: 12, color: "var(--text)", background: "var(--bg-subtle)", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", padding: "8px 10px", marginBottom: 12 }}>
          {error}
        </div>
      )}

      {schema === null ? (
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("webSearch.loading")}</div>
      ) : (
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
          {schema.map((backend) => {
            const current = byId.get(backend.id);
            const draft = drafts[backend.id] ?? {};
            const saving = busy === backend.id;

            const values: Record<string, string> = {};
            for (const field of backend.fields) {
              // An untouched field sends nothing, so the stored value survives.
              if (draft[field.env] !== undefined) values[field.env] = draft[field.env];
            }
            const dirty = Object.keys(values).length > 0;

            const canSave = backend.fields.some((field) => {
              if (values[field.env] !== undefined) return values[field.env].trim().length > 0;
              const stored = current?.fields.find((f) => f.env === field.env)?.hasValue;
              return field.optional ? true : Boolean(stored);
            });

            return (
              <div key={backend.id} style={cardStyle}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                    {backend.label}
                  </div>
                  {current?.configured ? (
                    <span title={t("webSearch.configured")} aria-label={t("webSearch.configured")} style={{ color: "var(--accent)", display: "flex" }}>
                      <Check size={14} aria-hidden="true" />
                    </span>
                  ) : null}
                </div>

                {backend.fields.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("webSearch.noCredential")}</div>
                ) : (
                  backend.fields.map((field) => {
                    const stored = current?.fields.find((f) => f.env === field.env)?.hasValue ?? false;
                    return (
                      <label key={field.env} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          {field.label}
                          {field.optional ? "" : " *"}
                        </span>
                        <input
                          type={field.kind === "apiKey" ? "password" : "text"}
                          value={draft[field.env] ?? ""}
                          disabled={saving}
                          placeholder={stored ? t("webSearch.storedPlaceholder") : ""}
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(event) => setDrafts((previous) => ({
                            ...previous,
                            [backend.id]: { ...(previous[backend.id] ?? {}), [field.env]: event.target.value },
                          }))}
                          style={{
                            fontSize: 12,
                            padding: "5px 7px",
                            background: "var(--bg)",
                            color: "var(--text)",
                            border: "1px solid var(--border)",
                            borderRadius: "var(--radius-control)",
                            fontFamily: field.kind === "url" ? "var(--font-mono)" : "inherit",
                          }}
                        />
                      </label>
                    );
                  })
                )}

                {backend.fields.length > 0 && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      disabled={saving || !dirty || !canSave}
                      onClick={() => void save(backend.id, values)}
                      style={{
                        fontSize: 11,
                        padding: "4px 10px",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 5,
                        background: "var(--accent)",
                        color: "var(--bg)",
                        border: "1px solid var(--accent)",
                        borderRadius: "var(--radius-control)",
                        cursor: dirty && canSave && !saving ? "pointer" : "default",
                        opacity: dirty && canSave && !saving ? 1 : 0.5,
                      }}
                    >
                      <KeyRound size={12} aria-hidden="true" />
                      {saving ? t("webSearch.saving") : t("webSearch.save")}
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void clear(backend.id)}
                      title={t("webSearch.clear")}
                      aria-label={t("webSearch.clear")}
                      style={{
                        fontSize: 11,
                        padding: "4px 8px",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 5,
                        background: "transparent",
                        color: "var(--text-muted)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-control)",
                        cursor: saving ? "default" : "pointer",
                      }}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                      {t("webSearch.clear")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 10, lineHeight: 1.5 }}>
        {t("webSearch.deliveryNote")}
      </p>
    </section>
  );
}

/** "{n} of {total} configured" without pulling a second i18n dependency in. */
function tn(t: (key: string) => string, configured: number, total: number): string {
  return `${configured} / ${total} ${t("webSearch.configured")}`;
}