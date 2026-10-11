"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, Lock, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";
import type { ProviderEntry } from "./ModelsConfig-types";

/**
 * The encrypted half of a provider's credential.
 *
 * The literal `apiKey` field elsewhere in this editor writes the secret into
 * models.yml, where it stays in plain text on the persisted agent dir. This
 * control stores it in the encrypted secret store instead and puts only a NAME
 * in models.yml:
 *
 *   models.yml:  myprov: { envVars: ["MYPROV_API_KEY"] }
 *   store:       myprov -> MYPROV_API_KEY, AES-256-GCM
 *   spawn:       decrypted and merged into the child's environment
 *
 * envVars rather than `apiKey: MYPROV_API_KEY`: omp shipped a bug where the
 * variable's NAME was sent as the key, which made models fail to load or
 * disappear outright. envVars is what omp's own shipped catalog uses.
 *
 * The derived name is not cosmetic: models.yml has to name the same variable the
 * store writes, or the provider silently sends nothing. It is derived once from
 * the provider id and then fixed, because renaming it would orphan a stored
 * secret that the editor cannot read back to recover.
 */
export function providerEnvVarName(providerId: string): string {
  const cleaned = providerId.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  return `${cleaned || "PROVIDER"}_API_KEY`;
}

interface ProviderKeyEntry {
  providerId: string;
  envVar: string;
  hasValue: boolean;
}

export function ProviderSecretField({
  providerId,
  envVars,
  onChange,
}: {
  providerId: string;
  envVars: string[] | undefined;
  onChange: (next: ProviderEntry) => void;
}) {
  const { t } = useI18n();
  const envVar = useMemo(() => providerEnvVarName(providerId), [providerId]);
  const [known, setKnown] = useState<ProviderKeyEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // Until this resolves the control stays disabled: an editor that guessed
  // would let a user save a key this build cannot later show as stored.
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/provider-keys");
      const data = (await response.json()) as { providers?: ProviderKeyEntry[] };
      if (response.ok) setKnown(Array.isArray(data.providers) ? data.providers : []);
    } catch {
      // A store that cannot be listed is not fatal here; the field stays off.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const stored = known.find((entry) => entry.providerId === providerId && entry.envVar === envVar)?.hasValue ?? false;
  const declared = Array.isArray(envVars) ? envVars.includes(envVar) : false;

  /** Write the declaration models.yml needs. Done on save AND on clear, because
   *  a name left behind with no value is a provider omp will fail to auth. */
  const declare = (present: boolean) => {
    const rest = (envVars ?? []).filter((name) => name !== envVar);
    onChange({ envVars: present ? [...rest, envVar] : rest.length > 0 ? rest : undefined } as Partial<ProviderEntry> as ProviderEntry);
  };

  const save = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/provider-keys", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, envVar, value: draft }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      setDraft("");
      declare(true);
      await refresh();
      toast.success(t("providerSecret.saved"));
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      toast.error(t("providerSecret.saveFailed"), message);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/provider-keys?providerId=${encodeURIComponent(providerId)}&envVar=${encodeURIComponent(envVar)}`, { method: "DELETE" });
      const data = (await response.json()) as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      setDraft("");
      declare(false);
      await refresh();
      toast.success(t("providerSecret.cleared"));
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      toast.error(t("providerSecret.clearFailed"), message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", padding: "10px 12px", background: "var(--bg-subtle)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
        <Lock size={13} aria-hidden="true" style={{ color: "var(--text-muted)" }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("providerSecret.heading")}</span>
        {stored && (
          <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--accent)" }}>{t("providerSecret.stored")}</span>
        )}
      </div>
      <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 8px", lineHeight: 1.5 }}>
        {t("providerSecret.description")}
      </p>
      <code style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>
        envVars: [{envVar}]
      </code>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <input
          type="password"
          value={draft}
          disabled={busy || !loaded}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={stored ? t("providerSecret.storedPlaceholder") : ""}
          style={{
            flex: "1 1 160px",
            minWidth: 0,
            fontSize: 12,
            padding: "5px 7px",
            background: "var(--bg)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
          }}
        />
        <button
          type="button"
          disabled={busy || !loaded || draft.trim().length === 0}
          onClick={() => void save()}
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
            opacity: !busy && loaded && draft.trim() ? 1 : 0.5,
          }}
        >
          <KeyRound size={12} aria-hidden="true" />
          {busy ? t("providerSecret.saving") : t("providerSecret.store")}
        </button>
        <button
          type="button"
          disabled={busy || !loaded || (!stored && !declared)}
          onClick={() => void clear()}
          aria-label={t("providerSecret.clear")}
          style={{
            fontSize: 11,
            padding: "4px 8px",
            display: "inline-flex",
            alignItems: "center",
            background: "transparent",
            color: "var(--text-muted)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
          }}
        >
          <Trash2 size={12} aria-hidden="true" />
          {t("providerSecret.clear")}
        </button>
      </div>
    </div>
  );
}