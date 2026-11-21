import { useEffect, useState } from "react";
import { songPath, studioApi } from "../lib/api";
import type { RepairLogEntry } from "../lib/songRepair";

interface Ack {
  system: string;
  result: string;
  external_id: string;
  reason: string;
  received_at: string;
}
export function SongDetails({ id, updatedAt }: { id: string; updatedAt: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ repairs: RepairLogEntry[]; acks: Ack[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    studioApi<NonNullable<typeof data>>(songPath(id) + "/details", "GET", undefined, controller.signal)
      .then(setData)
      .catch(() => { if (!controller.signal.aborted) setError("Could not load song details."); });
    return () => controller.abort();
  }, [id, open, updatedAt]);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)} className="pt-2 text-xs text-[#57554F]">
    <summary className="cursor-pointer font-medium">Repair log and partner acknowledgements</summary>
    {open && (error ? <p role="alert">{error}</p> : !data ? <p role="status">Loading details…</p> : <div className="space-y-2 pl-2 pt-2">
      <p className="font-semibold">Repair log</p>
      {data.repairs.length ? <ul className="space-y-1">{data.repairs.map((entry) => <li key={entry.id} className="break-words">
        {new Date(entry.timestamp).toLocaleString()} · {entry.what_was_changed} · {entry.check_failed} · {entry.result}
      </li>)}</ul> : <p>No repairs recorded.</p>}
      <p className="font-semibold">Partner acknowledgements</p>
      {data.acks.length ? <ul className="space-y-1">{data.acks.map((ack, i) => <li key={ack.received_at + i} className="break-words">
        {ack.system} · {ack.external_id} · {ack.result}{ack.reason && " · " + ack.reason}
      </li>)}</ul> : <p>No partner acknowledgements.</p>}
    </div>)}
  </details>;
}
