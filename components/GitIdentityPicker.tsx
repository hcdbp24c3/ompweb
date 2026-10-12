"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";

/**
 * Which git identity this workspace commits as, remembered per workspace.
 *
 * Plain `<select>` rather than a custom popup on purpose: it is a list of short
 * strings, it must work on a phone with no hover, and the browser one is
 * keyboard- and screen-reader-correct for free. A bespoke menu would have been
 * more work to make right than to avoid.
 *
 * The cwd is sent as a hint and RESOLVED SERVER-SIDE, never trusted: a client
 * that named its own path could point one repository's identity at another's.
 *
 * Choices are per workspace, which is the point: switching repos brings back
 * what you last picked for THAT repo rather than whatever you picked elsewhere.
 * A cleared choice falls back to the global default rather than to whoever was
 * selected most recently.
 */
export function GitIdentityPicker({
  cwd,
  onError,
}: {
  cwd: string | undefined;
  onError?: (message: string) => void;
}) {
  const { t } = useI18n();
  const [identities, setIdentities] = useState<Array<{ id: string; label: string; name?: string; email?: string }>>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  // Switching workspaces fast used to leave the previous workspace's answer on
  // screen: its slower request resolved last and wrote over the newer one. The
  // abort is what makes "last write wins" mean "the workspace you are IN".
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;
    try {
      const response = await fetch("/api/git-identity", { signal });
      const data = (await response.json()) as {
        identities?: Array<{ id: string; label: string; name?: string; email?: string }>;
        default?: { name: string; email: string } | null;
        path?: string;
        error?: string;
      };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      const list = Array.isArray(data.identities) ? data.identities : [];
      setIdentities(list);
      // What resolves HERE, not merely what is stored globally: the effective
      // value can still be the default or an older per-repo override.
      const effective = await effectiveSelection(cwd, signal);
      // Two awaits, so the workspace can have changed in between. Abort covers
      // the fetch; this covers a resolve that was already in flight.
      if (signal.aborted) return;
      setSelectedId(effective);
      setLoaded(true);
    } catch (failure) {
      if (signal.aborted) return;
      onError?.(failure instanceof Error ? failure.message : String(failure));
      setLoaded(true);
    }
  }, [cwd, onError]);

  useEffect(() => {
    // A fresh cwd starts blank rather than showing the previous workspace's
    // identity for the moment before the new answer arrives.
    setLoaded(false);
    void load();
    return () => { abortRef.current?.abort(); };
  }, [load]);

  const choose = async (identityId: string) => {
    const previous = selectedId;
    // A load still in flight would otherwise land after this and reset the
    // control to whatever the server answered before the save went through.
    abortRef.current?.abort();
    setSelectedId(identityId);
    setBusy(true);
    try {
      const response = await fetch("/api/git-identity", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "select", cwd, identityId: identityId || null }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
    } catch (failure) {
      setSelectedId(previous);
      onError?.(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return null;

  // Nothing to pick between yet: the install has only a global default, which is
  // already applied. An empty control would just be noise.
  if (identities.length === 0) return null;

  return (
    <label
      style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 }}
      title={t("gitIdentity.pickerTitle")}
    >
      <span aria-hidden="true" style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
        {t("gitIdentity.pickerLabel")}
      </span>
      <select
        value={selectedId}
        disabled={busy}
        aria-label={t("gitIdentity.pickerLabel")}
        onChange={(event) => void choose(event.target.value)}
        style={{
          fontSize: 11,
          maxWidth: 132,
          padding: "2px 4px",
          background: "var(--bg)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-control)",
          opacity: busy ? 0.6 : 1,
        }}
      >
        <option value="">{t("gitIdentity.pickerDefault")}</option>
        {identities.map((identity) => (
          <option key={identity.id} value={identity.id}>
            {identity.label || identity.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The identity that actually resolves for this workspace.
 *
 * Ask the server rather than reproducing its resolution here: the order is
 * selection, then a v1 per-repo override, then the default, and a second copy of
 * that order in the client is exactly the thing that drifts.
 */
async function effectiveSelection(cwd: string | undefined, signal: AbortSignal): Promise<string> {
  try {
    const response = await fetch(`/api/git-identity/resolve?cwd=${encodeURIComponent(cwd ?? "")}`, { signal });
    if (!response.ok) return "";
    const data = (await response.json()) as { via?: string; identityId?: string | null };
    return data.via === "selected" ? data.identityId ?? "" : "";
  } catch {
    return "";
  }
}