"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Alert, Check, ConfirmDialog, Field, SecretInput, Select, TextInput } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";

type CredentialType = "pat" | "ssh";

/** Mirrors GitCredentialSummary on the server. The API never returns a secret,
 *  so this type has no field for one and cannot grow one by accident. */
type Credential = {
  id: string;
  name: string;
  host: string;
  account: string;
  type: CredentialType;
  isDefaultForHost: boolean;
  hasToken: boolean;
  hasPrivateKey: boolean;
  hasPassphrase: boolean;
};

type CredentialsResponse = {
  path?: string;
  keyPath?: string;
  credentials?: Credential[];
  error?: string;
};

const EMPTY_FORM = { name: "", host: "", account: "", token: "", privateKey: "", passphrase: "", isDefaultForHost: false };

export function GitCredentialsConfig() {
  const { t } = useI18n();
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [keyPath, setKeyPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [type, setType] = useState<CredentialType>("pat");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/git-credentials");
      const data = (await response.json()) as CredentialsResponse;
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      setCredentials(Array.isArray(data.credentials) ? data.credentials : []);
      setPath(data.path ?? null);
      setKeyPath(data.keyPath ?? null);
      setSelected((current) => (current && data.credentials?.some((credential) => credential.id === current) ? current : null));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const current = credentials.find((credential) => credential.id === selected) ?? null;
  const storedSecret = type === "pat" ? current?.hasToken : current?.hasPrivateKey;

  const choose = (credential: Credential) => {
    setSelected(credential.id);
    setType(credential.type);
    // Secrets are write-only: the fields always start empty so an untouched
    // field cannot be mistaken for an instruction to overwrite the stored one.
    setForm({
      name: credential.name,
      host: credential.host,
      account: credential.account,
      token: "",
      privateKey: "",
      passphrase: "",
      isDefaultForHost: credential.isDefaultForHost,
    });
    setError(null);
  };

  const add = () => {
    setSelected(null);
    setType("pat");
    setForm(EMPTY_FORM);
    setError(null);
  };

  const set = <K extends keyof typeof EMPTY_FORM>(key: K, value: (typeof EMPTY_FORM)[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/git-credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // An empty secret field is omitted rather than sent as "": the API reads
        // that as "keep the existing secret", which is what the placeholder says.
        body: JSON.stringify({
          ...(selected ? { id: selected } : {}),
          name: form.name,
          host: form.host,
          account: form.account,
          type,
          isDefaultForHost: form.isDefaultForHost,
          ...(type === "pat" ? { token: form.token } : { privateKey: form.privateKey, passphrase: form.passphrase }),
        }),
      });
      const data = (await response.json()) as { credential?: Credential; error?: string };
      if (!response.ok || data.error || !data.credential) throw new Error(data.error || `HTTP ${response.status}`);
      await load();
      choose(data.credential);
      toast.success(t("gitCredentials.saved"), data.credential.name);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const response = await fetch("/api/git-credentials", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selected }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      add();
      await load();
      toast.success(t("gitCredentials.removed"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setConfirmOpen(false);
      setSaving(false);
    }
  };

  const keepPlaceholder = storedSecret ? t("gitCredentials.keepExisting") : "";

  return (
    <section style={{ marginTop: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "visible", background: "var(--bg-panel)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
        <KeyRound size={14} aria-hidden="true" style={{ color: "var(--text-muted)", flexShrink: 0 }} />
        <strong style={{ fontSize: 12, color: "var(--text)" }}>{t("gitCredentials.title")}</strong>
        <code style={{ flex: 1, minWidth: 0, color: "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{path ?? "…"}</code>
        <button
          className="ui-focus-ring"
          type="button"
          title={t("gitCredentials.refresh")}
          aria-label={t("gitCredentials.refresh")}
          onClick={() => void load()}
          disabled={loading}
          style={{ width: 24, height: 24, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: loading ? "wait" : "pointer" }}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div style={{ padding: 12, display: "grid", gap: 10 }}>
        <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {t("gitCredentials.encryptionNote")}
          {keyPath ? <><br /><code style={{ fontSize: 10, color: "var(--text-dim)" }}>{keyPath}</code></> : null}
        </p>
        {error && <Alert variant="error" description={error} onDismiss={() => setError(null)} />}
        <div className="git-credentials-editor" style={{ display: "grid", gridTemplateColumns: "minmax(150px, 0.34fr) minmax(0, 1fr)", border: "1px solid var(--border)", borderRadius: "var(--radius-control)" }}>
          <div style={{ borderRight: "1px solid var(--border)", padding: 6 }}>
            {credentials.map((credential) => (
              <button
                key={credential.id}
                type="button"
                onClick={() => choose(credential)}
                aria-pressed={selected === credential.id}
                style={{ display: "block", width: "100%", padding: "7px 8px", border: "none", borderRadius: 5, background: selected === credential.id ? "var(--bg-selected)" : "transparent", color: "var(--text)", textAlign: "left", cursor: "pointer" }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 5, overflow: "hidden" }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, fontSize: 11 }}>{credential.name}</span>
                  {credential.isDefaultForHost && (
                    <span title={t("gitCredentials.defaultForHost")} aria-label={t("gitCredentials.defaultForHost")} style={{ fontSize: 10, color: "var(--accent)", flexShrink: 0 }}>★</span>
                  )}
                </span>
                <span style={{ display: "block", marginTop: 2, fontSize: 9, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {credential.host} · {credential.account} · {credential.type.toUpperCase()}
                  {" · "}{t(credential.type === "pat" ? (credential.hasToken ? "gitCredentials.secretStored" : "gitCredentials.noSecret") : (credential.hasPrivateKey ? "gitCredentials.secretStored" : "gitCredentials.noSecret"))}
                </span>
              </button>
            ))}
            {!loading && credentials.length === 0 && <div style={{ padding: "7px 8px", color: "var(--text-dim)", fontSize: 11 }}>{t("gitCredentials.empty")}</div>}
            <button type="button" onClick={add} style={{ display: "flex", alignItems: "center", gap: 4, width: "100%", marginTop: 5, padding: "6px 8px", border: "1px dashed var(--border)", borderRadius: 5, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>
              <Plus size={13} aria-hidden="true" /> {t("gitCredentials.add")}
            </button>
          </div>
          <div style={{ minWidth: 0, padding: 12, display: "grid", gap: 9 }}>
            <Field label={t("gitCredentials.name")}>
              <TextInput value={form.name} onChange={(value) => set("name", value)} placeholder="GitHub work" mono />
            </Field>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 9 }}>
              <Field label={t("gitCredentials.host")} hint={t("gitCredentials.hostHint")}>
                <TextInput value={form.host} onChange={(value) => set("host", value)} placeholder="github.com" mono spellCheck={false} />
              </Field>
              <Field label={t("gitCredentials.account")} hint={t("gitCredentials.accountHint")}>
                <TextInput value={form.account} onChange={(value) => set("account", value)} placeholder="octocat" mono spellCheck={false} />
              </Field>
              <Field label={t("gitCredentials.type")}>
                <Select
                  value={type}
                  onChange={(value) => setType(value === "ssh" ? "ssh" : "pat")}
                  options={["pat", "ssh"]}
                  required
                />
              </Field>
            </div>
            {type === "pat" ? (
              <Field label={t("gitCredentials.token")} hint={storedSecret ? keepPlaceholder : undefined}>
                <SecretInput
                  value={form.token}
                  onChange={(value) => set("token", value)}
                  placeholder={keepPlaceholder}
                  showLabel={t("gitCredentials.showToken")}
                  hideLabel={t("gitCredentials.hideToken")}
                />
              </Field>
            ) : (
              <>
                <Field label={t("gitCredentials.privateKey")} hint={storedSecret ? keepPlaceholder : undefined}>
                  <SecretInput
                    value={form.privateKey}
                    onChange={(value) => set("privateKey", value)}
                    placeholder={keepPlaceholder}
                    showLabel={t("gitCredentials.showToken")}
                    hideLabel={t("gitCredentials.hideToken")}
                  />
                </Field>
                <Field label={t("gitCredentials.passphrase")}>
                  <SecretInput
                    value={form.passphrase}
                    onChange={(value) => set("passphrase", value)}
                    placeholder={current?.hasPassphrase ? keepPlaceholder : undefined}
                    showLabel={t("gitCredentials.showToken")}
                    hideLabel={t("gitCredentials.hideToken")}
                  />
                </Field>
              </>
            )}
            <Check
              label={t("gitCredentials.defaultForHost")}
              checked={form.isDefaultForHost}
              onChange={(checked) => set("isDefaultForHost", checked)}
            />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !form.name.trim() || !form.host.trim() || !form.account.trim()}
                style={{ padding: "6px 9px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: saving ? "wait" : "pointer", fontSize: 11 }}
              >
                {saving ? t("gitCredentials.saving") : t("gitCredentials.save")}
              </button>
              {selected && (
                <button
                  type="button"
                  onClick={() => setConfirmOpen(true)}
                  disabled={saving}
                  style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "6px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", cursor: saving ? "wait" : "pointer", fontSize: 11 }}
                >
                  <Trash2 size={13} aria-hidden="true" /> {t("gitCredentials.remove")}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("gitCredentials.remove")}
        description={t("gitCredentials.removeConfirm")}
        confirmLabel={t("gitCredentials.remove")}
        cancelLabel={t("gitCredentials.cancel")}
        danger
        busy={saving}
        onConfirm={() => void remove()}
      />
    </section>
  );
}
