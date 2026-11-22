import { useEffect, useRef, useState } from "react";
import { studioApi } from "../lib/api";

interface Client {
  id: string;
  name: string;
  revoked: boolean;
  last_used_at: string | null;
}

type RhymeMigration = { scanned: number; updated: number[]; already: number[]; user_edited: number[]; missing: number[]; locked: number[] };
function migrationSummary(result: RhymeMigration) {
  return `Scanned ${result.scanned}. Updated or eligible: ${result.updated.length}. Already current: ${result.already.length}. Edited by owner: ${result.user_edited.length} (${result.user_edited.join(", ") || "none"}). Missing: ${result.missing.length}. Locked: ${result.locked.length}.`;
}

type Migration = { scanned: number; migrated: number; skipped: number; seeded: number; legacy_takes: number };
const btn = "rounded-lg border border-[#D4D2CA] px-3 py-2 text-xs font-semibold disabled:opacity-50";
const input = "min-w-0 rounded-lg border border-[#D4D2CA] p-2 text-sm";
const errorText = (e: unknown) => e instanceof Error ? e.message : "Studio request failed.";

export function StudioAdministration({ refresh }: { refresh: () => Promise<void> }) {
  const [clients, setClients] = useState<Client[] | null>(null);
  const [name, setName] = useState("");
  const [prepared, setPrepared] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [migration, setMigration] = useState<Migration | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void studioApi<{ clients: Client[] }>("/clients", "GET", undefined, controller.signal)
      .then((result) => setClients(result.clients))
      .catch((e) => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => controller.abort();
  }, []);
  const load = async () => setClients((await studioApi<{ clients: Client[] }>("/clients")).clients);
  const run = async (action: () => Promise<void>) => {
    setError("");
    setMessage("");
    setBusy(true);
    try { await action(); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  const startKey = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const encoded = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    setSaved(false);
    setPrepared("dss_" + encoded);
  };
  const register = () => run(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prepared));
    const key_hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await studioApi("/clients", "POST", { name, key_hash, scopes: ["songs:read", "songs:audio", "songs:ack"] });
    setPrepared("");
    setSaved(false);
    setName("");
    await load();
    setMessage("Partner access registered.");
  });

  return <section className="space-y-5 rounded-xl border border-[#E5E4DF] bg-white p-5 shadow-xs">
    <div className="space-y-3">
      <h2 className="font-bold">Partner API</h2>
      <label className="flex flex-wrap items-center gap-2 text-sm">
        Client name
        <input className={input} maxLength={80} value={name} disabled={Boolean(prepared)} onChange={(e) => setName(e.target.value)} />
      </label>
      {!prepared && <button type="button" className={btn} disabled={busy || !name.trim()} onClick={startKey}>Create key</button>}
      {prepared && <div className="space-y-2 rounded-lg bg-[#EFF6FF] p-3">
        <p className="text-sm">Copy this key into MyVault and confirm it was saved.</p>
        <code className="block break-all select-all text-xs">{prepared}</code>
        <label className="block text-sm"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> Saved in MyVault</label>
        <button type="button" className={btn} disabled={!saved || busy} onClick={() => void register()}>Register key</button>
        <button type="button" className={btn + " ml-2"} disabled={busy} onClick={() => setPrepared("")}>Cancel</button>
      </div>}
      {clients === null ? <p className="text-sm">{error ? "Could not load partner keys." : "Loading partner keys…"}</p> :
        clients.length === 0 ? <p className="text-sm">No partner keys yet.</p> : <ul className="space-y-2">
          {clients.map((client) => <li key={client.id} className="flex flex-wrap items-center gap-2 text-sm">
            <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => {
              e.preventDefault();
              const value = new FormData(e.currentTarget).get("name");
              if (typeof value === "string") void run(async () => {
                await studioApi("/clients/" + client.id, "PATCH", { name: value });
                await load();
              });
            }}>
              <input className={input} name="name" aria-label={"Name for " + client.name} defaultValue={client.name} required maxLength={80} />
              <button className={btn} disabled={busy}>Save name</button>
            </form>
            {client.revoked ? <span>Revoked</span> : <button type="button" className={btn} disabled={busy} onClick={() => {
              if (window.confirm("Revoke access for " + client.name + "?")) void run(async () => {
                await studioApi("/clients/" + client.id, "PATCH", { revoked: true });
                await load();
              });
            }}>Revoke</button>}
            <small>{client.last_used_at ? "Last used " + new Date(client.last_used_at).toLocaleString() : "Never used"}</small>
          </li>)}
        </ul>}
    </div>
    <div className="space-y-3 border-t border-[#E5E4DF] pt-4">
      <h2 className="font-bold">Library maintenance</h2>
      <div className="flex flex-wrap gap-2">
        <input ref={file} hidden type="file" accept=".json,application/json" onChange={(e) => {
          const selected = e.target.files?.[0];
          e.target.value = "";
          if (!selected) return;
          void run(async () => {
            if (selected.size > 2 * 1024 * 1024) throw new Error("The JSON file is larger than 2 MiB.");
            const result = await studioApi<{ added: number; skipped: number }>("/history/import", "POST", JSON.parse(await selected.text()));
            setMessage("Imported " + result.added + " history entries. Skipped " + result.skipped + ".");
            await refresh();
          });
        }} />
        <button type="button" className={btn} disabled={busy} onClick={() => file.current?.click()}>Import history</button>
        <button type="button" className={btn} disabled={busy} onClick={() => void run(async () => {
          const result = await studioApi<Migration>("/migrations/catalog", "POST", { dry_run: true });
          setMigration(result);
          setMessage("Dry run found " + result.migrated + " songs to migrate, including " + result.seeded + " to seed and " + result.legacy_takes + " legacy takes.");
        })}>Preview catalog migration</button>
        <button type="button" className={btn} disabled={busy} onClick={() => void run(async () => {
          const path = "/owner/migrations/rhyme-lyrics";
          const preview = await studioApi<RhymeMigration>(path, "POST", { dry_run: true });
          const summary = migrationSummary(preview);
          setMessage("Preview. " + summary);
          if (!preview.updated.length || !window.confirm(summary + "\nApply rhymed lyrics and mark the updated songs for new audio?")) return;
          const result = await studioApi<RhymeMigration>(path, "POST", { dry_run: false });
          setMessage("Migration complete. " + migrationSummary(result));
          await refresh();
        })}>Apply rhymed lyrics</button>
        {migration && migration.migrated > 0 && <button type="button" className={btn} disabled={busy} onClick={() => {
          if (!window.confirm("Apply the catalog migration and keep all previous lyrics and audio?")) return;
          void run(async () => {
            const result = await studioApi<Migration>("/migrations/catalog", "POST", { dry_run: false });
            setMigration(null);
            setMessage("Migration completed for " + result.migrated + " songs.");
            await refresh();
          });
        }}>Apply catalog migration</button>}
      </div>
    </div>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {message && <p role="status" className="text-sm text-[#1B3B6F]">{message}</p>}
  </section>;
}
