"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, RefreshCw, Trash2, UserRound } from "lucide-react";
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

// ---------------------------------------------------------------------------
// Git identity — who commits. A name and an email, resolved per repository,
// applied to the child environment as GIT_AUTHOR_*/GIT_COMMITTER_*.
//
// The "not set" state is the reason this panel spells things out. With no
// identity, `git commit` fails on git's own untranslated stderr string, so the
// absence is stated here — with the consequence — instead of being left for the
// user to decode at a terminal. That is also why nothing on this panel is a
// SecretInput: identity is personal data, not a credential, and it is sent back
// so it can be edited.
// ---------------------------------------------------------------------------

type Identity = { name: string; email: string };
type IdentityOverride = Identity & { path: string };

type IdentityResponse = {
  path?: string;
  default?: Identity | null;
  overrides?: IdentityOverride[];
  error?: string;
};

const EMPTY_IDENTITY_FORM = { project: "", name: "", email: "" };

export function GitIdentityConfig() {
  const { t } = useI18n();
  const [identityPath, setIdentityPath] = useState<string | null>(null);
  const [globalIdentity, setGlobalIdentity] = useState<Identity | null>(null);
  const [overrides, setOverrides] = useState<IdentityOverride[]>([]);
  const [form, setForm] = useState(EMPTY_IDENTITY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/git-identity");
      const data = (await response.json()) as IdentityResponse;
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      setIdentityPath(data.path ?? null);
      setGlobalIdentity(data.default ?? null);
      setOverrides(Array.isArray(data.overrides) ? data.overrides : []);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const set = <K extends keyof typeof EMPTY_IDENTITY_FORM>(key: K, value: (typeof EMPTY_IDENTITY_FORM)[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  const editGlobal = () => {
    setForm({ project: "", name: globalIdentity?.name ?? "", email: globalIdentity?.email ?? "" });
    setError(null);
  };

  const editOverride = (override: IdentityOverride) => {
    setForm({ project: override.path, name: override.name, email: override.email });
    setError(null);
  };

  const put = async (body: Record<string, unknown>) => {
    const response = await fetch("/api/git-identity", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json()) as { error?: string };
    if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const project = form.project.trim();
      await put({ ...(project ? { project } : {}), name: form.name, email: form.email });
      await load();
      setForm(EMPTY_IDENTITY_FORM);
      toast.success(t("gitIdentity.saved"), project || t("gitIdentity.scopeGlobal"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (path: string) => {
    setSaving(true);
    try {
      await put({ project: path, clear: true });
      if (form.project === path) setForm(EMPTY_IDENTITY_FORM);
      await load();
      toast.success(t("gitIdentity.cleared"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPendingRemoval(null);
      setSaving(false);
    }
  };

  const clearGlobal = async () => {
    setSaving(true);
    try {
      await put({ clear: true });
      if (!form.project) setForm(EMPTY_IDENTITY_FORM);
      await load();
      toast.success(t("gitIdentity.cleared"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  const unset = globalIdentity === null && overrides.length === 0;

  return (
    <section style={{ marginTop: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
        <UserRound size={14} aria-hidden="true" style={{ color: "var(--text-muted)", flexShrink: 0 }} />
        <strong style={{ fontSize: 12, color: "var(--text)" }}>{t("gitIdentity.title")}</strong>
        <code style={{ flex: 1, minWidth: 0, color: "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{identityPath ?? "…"}</code>
        <button
          className="ui-focus-ring"
          type="button"
          title={t("gitIdentity.refresh")}
          aria-label={t("gitIdentity.refresh")}
          onClick={() => void load()}
          disabled={loading}
          style={{ width: 24, height: 24, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: loading ? "wait" : "pointer" }}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div style={{ padding: 12, display: "grid", gap: 10 }}>
        <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>{t("gitIdentity.note")}</p>
      {error && <Alert variant="error" description={error} onDismiss={() => setError(null)} />}

        {unset ? (
          <p style={{ margin: 0, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
            <strong style={{ color: "var(--text-muted)" }}>{t("gitIdentity.notSet")}</strong>
            <br />{t("gitIdentity.notSetHint")}
          </p>
        ) : (
        <div style={{ display: "grid", gap: 5 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11 }}>
            <span style={{ color: "var(--text-muted)" }}>{t("gitIdentity.scopeGlobal")}</span>
            {globalIdentity
              ? <code style={{ color: "var(--text)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{globalIdentity.name} &lt;{globalIdentity.email}&gt;</code>
              : <span style={{ color: "var(--text-dim)" }}>{t("gitIdentity.usesDefault")}</span>}
            <button type="button" onClick={editGlobal} style={{ marginLeft: "auto", border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: 10 }}>{t("gitIdentity.edit")}</button>
            {globalIdentity && (
              <button type="button" onClick={() => void clearGlobal()} disabled={saving} style={{ border: "none", background: "transparent", color: "var(--text-muted)", cursor: saving ? "wait" : "pointer", fontSize: 10 }}>{t("gitIdentity.clear")}</button>
            )}
          </div>
          {overrides.map((override) => (
            <div key={override.path} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11 }}>
              <span style={{ minWidth: 0, flex: "0 1 40%", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={override.path}>{override.path}</span>
              <code style={{ minWidth: 0, flex: 1, color: "var(--text)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{override.name} &lt;{override.email}&gt;</code>
              <button type="button" onClick={() => editOverride(override)} style={{ border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: 10 }}>{t("gitIdentity.edit")}</button>
              <button
                type="button"
                title={t("gitIdentity.remove")}
                aria-label={t("gitIdentity.remove")}
                onClick={() => setPendingRemoval(override.path)}
                disabled={saving}
                style={{ display: "inline-flex", padding: 0, border: "none", background: "transparent", color: "var(--text-muted)", cursor: saving ? "wait" : "pointer" }}
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
        )}

        <div style={{ display: "grid", gap: 9, padding: 10, border: "1px solid var(--border)", borderRadius: "var(--radius-control)" }}>
          <Field label={t("gitIdentity.project")} hint={t("gitIdentity.projectHint")}>
            <TextInput value={form.project} onChange={(value) => set("project", value)} placeholder="/path/to/repo" mono spellCheck={false} />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 9 }}>
            <Field label={t("gitIdentity.name")}>
              <TextInput value={form.name} onChange={(value) => set("name", value)} placeholder="Octo Cat" />
            </Field>
            <Field label={t("gitIdentity.email")}>
              <TextInput value={form.email} onChange={(value) => set("email", value)} placeholder="octocat@example.com" mono spellCheck={false} />
            </Field>
          </div>
          <div>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !form.name.trim() || !form.email.trim()}
              style={{ padding: "6px 9px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: saving ? "wait" : "pointer", fontSize: 11 }}
            >
              {saving ? t("gitIdentity.saving") : t("gitIdentity.save")}
            </button>
          </div>
        </div>
        <ConfirmDialog
          open={pendingRemoval !== null}
          onOpenChange={(open) => { if (!open) setPendingRemoval(null); }}
          title={t("gitIdentity.remove")}
          description={t("gitIdentity.removeConfirm")}
          confirmLabel={t("gitIdentity.remove")}
          cancelLabel={t("gitCredentials.cancel")}
          danger
          busy={saving}
          onConfirm={() => { if (pendingRemoval !== null) void remove(pendingRemoval); }}
        />
      </div>
    </section>
  );
}

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
    <>
      {/* Identity first: who commits is a precondition for the credentials below
          it, and the card order is the only place that reads as a sequence. */}
      <GitIdentityConfig />
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
    </>
  );
}
