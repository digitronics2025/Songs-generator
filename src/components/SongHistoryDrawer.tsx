import { useState } from "react";
import { History, X, Search, FileText, Calendar } from "lucide-react";
import type { SongHistoryItem } from "../data/songs";

interface SongHistoryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  historyItems: SongHistoryItem[];
  selectedSongNumber?: number | null;
}

export function SongHistoryDrawer({
  isOpen,
  onClose,
  historyItems,
  selectedSongNumber,
}: SongHistoryDrawerProps) {
  const [filterSongNumber, setFilterSongNumber] = useState<string>(
    selectedSongNumber ? String(selectedSongNumber) : ""
  );
  const [actionFilter, setActionFilter] = useState<string>("all");

  if (!isOpen) return null;

  const filtered = historyItems.filter((item) => {
    if (filterSongNumber.trim()) {
      const target = Number(filterSongNumber.trim());
      if (item.song_number !== target) return false;
    }
    if (actionFilter !== "all" && item.action !== actionFilter) {
      return false;
    }
    return true;
  });

  const getActionBadge = (action: string) => {
    switch (action) {
      case "created":
        return "bg-[#EFF6FF] text-[#1E40AF] border-[#BFDBFE]";
      case "lyric_approved":
        return "bg-[#F0FDF4] text-[#166534] border-[#BBF7D0]";
      case "edited":
        return "bg-[#FFFBEB] text-[#92400E] border-[#FDE68A]";
      case "archived":
        return "bg-[#F3F4F6] text-[#4B5563] border-[#E5E7EB]";
      case "restored":
        return "bg-[#FAF5FF] text-[#6B21A8] border-[#E9D5FF]";
      case "migrated":
        return "bg-[#F8F8F6] text-[#57554F] border-[#E5E4DF]";
      default:
        return "bg-gray-100 text-gray-700 border-gray-200";
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-end bg-black/40 backdrop-blur-xs">
      <div className="relative flex h-full w-full max-w-xl flex-col bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#ECEBE6] px-6 py-4">
          <div className="flex items-center gap-2">
            <History className="h-5 w-5 text-[#1B3B6F]" />
            <div>
              <h2 className="text-lg font-bold text-[#141413]">Song Lyric History</h2>
              <p className="text-xs text-[#6E6C66]">
                Permanent audit trail of every lyric creation, revision &amp; approval.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[#706E67] hover:bg-[#F3F2EE] hover:text-[#141413]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-3 border-b border-[#ECEBE6] bg-[#FAF9F6] px-6 py-3">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-[#57554F]">Song #:</span>
            <input
              type="number"
              min={1}
              value={filterSongNumber}
              onChange={(e) => setFilterSongNumber(e.target.value)}
              placeholder="All"
              className="font-mono w-20 rounded-md border border-[#D4D2CA] bg-white px-2 py-1 text-xs text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-[#57554F]">Action:</span>
            <select
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              className="rounded-md border border-[#D4D2CA] bg-white px-2.5 py-1 text-xs text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
            >
              <option value="all">All actions ({historyItems.length})</option>
              <option value="created">created</option>
              <option value="lyric_approved">lyric_approved</option>
              <option value="edited">edited</option>
              <option value="archived">archived</option>
              <option value="restored">restored</option>
              <option value="migrated">migrated</option>
            </select>
          </div>

          {filterSongNumber && (
            <button
              type="button"
              onClick={() => setFilterSongNumber("")}
              className="text-xs text-[#1B3B6F] underline"
            >
              Clear filter
            </button>
          )}
        </div>

        {/* List of history entries */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {filtered.length === 0 ? (
            <div className="py-16 text-center text-sm text-[#706E67]">
              No history entries match your filter.
            </div>
          ) : (
            filtered.map((item) => (
              <div
                key={item.id}
                className="rounded-xl border border-[#E5E4DF] bg-white p-4 shadow-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#ECEBE6] pb-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-bold text-[#141413]">
                      Song #{item.song_number}
                    </span>
                    <span
                      className={`rounded-md border px-2 py-0.5 font-mono text-[11px] font-semibold ${getActionBadge(
                        item.action
                      )}`}
                    >
                      {item.action}
                    </span>
                    <span className="rounded bg-[#F3F2EE] px-2 py-0.5 text-[11px] text-[#57554F]">
                      {item.admin_feeling}
                    </span>
                  </div>

                  <span className="flex items-center gap-1 font-mono text-[11px] text-[#706E67]">
                    <Calendar className="h-3 w-3" />
                    {new Date(item.timestamp).toLocaleString()}
                  </span>
                </div>

                <div className="mt-2.5">
                  <h4
                    dir="rtl"
                    className="font-arabic text-base font-bold text-[#141413]"
                  >
                    {item.title}
                  </h4>
                  <div className="mt-2 space-y-1 rounded-lg border border-[#F0EFEA] bg-[#FAF9F6] p-2.5">
                    {item.lines.map((line, i) => (
                      <p
                        key={i}
                        dir="rtl"
                        className="font-arabic text-right text-xs text-[#2A2926]"
                      >
                        {line}
                      </p>
                    ))}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
