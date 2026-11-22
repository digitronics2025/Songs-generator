import { useMemo, useState } from "react";
import {
  Sparkles,
  X,
  Loader2,
  Check,
  CheckCircle2,
  Layers,
  Wand2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { MAX_DRAFT_BATCH, type SongState, type StudioSettings } from "../data/songs";
import { studioApi } from "../lib/api";
import { RhymeSummary, RhymeTag } from "./RhymeTag";
import { checkRhyme, countLineWords, validateLyrics } from "../lib/lyricQuality";

interface BatchGeneratorModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: StudioSettings;
  existingSongs: SongState[];
  onAddBatch: (
    songs: Array<{
      title: string;
      lines: string[];
      admin_feeling: string;
      theme: string;
      mood: string;
      tempo_bpm: number;
      instruments: string;
      vocal_tone: string;
      feeling_key: string;
      isApproved: boolean;
    }>
  ) => Promise<void>;
}

interface DraftItem {
  closest_match_pct: number;
  id: string;
  selected: boolean;
  expanded: boolean;
  title: string;
  lines: string[];
  theme: string;
  mood: string;
  tempo_bpm: number;
  instruments: string;
  vocal_tone: string;
  feeling_key: string;
  admin_feeling: string;
}

export function BatchGeneratorModal({
  isOpen,
  onClose,
  settings,
  existingSongs,
  onAddBatch,
}: BatchGeneratorModalProps) {
  const [count, setCount] = useState(5);
  const [selectedFeelings, setSelectedFeelings] = useState<Set<string>>(
    () => new Set(settings.feelings.slice(0, 4))
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [approveAll, setApproveAll] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Compute approved/ready song counts per feeling for "Fill the gaps"
  const feelingApprovedCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const f of settings.feelings) {
      counts[f] = 0;
    }
    for (const song of existingSongs) {
      if (
        !song.archived &&
        (song.status === "approved" || song.status === "ready")
      ) {
        if (typeof counts[song.admin_feeling] === "number") {
          counts[song.admin_feeling] += 1;
        }
      }
    }
    return counts;
  }, [settings.feelings, existingSongs]);

  if (!isOpen) return null;

  // "Fill the gaps": Select the feelings with the fewest approved songs
  const handleFillTheGaps = () => {
    const sorted = [...settings.feelings].sort((a, b) => {
      const ca = feelingApprovedCounts[a] || 0;
      const cb = feelingApprovedCounts[b] || 0;
      return ca - cb;
    });
    // Pick the top 4 lowest feelings
    const gapFeelings = new Set(sorted.slice(0, Math.min(4, sorted.length)));
    setSelectedFeelings(gapFeelings);
  };

  const toggleFeeling = (feeling: string) => {
    setSelectedFeelings((prev) => {
      const next = new Set(prev);
      if (next.has(feeling)) {
        if (next.size > 1) next.delete(feeling);
      } else {
        next.add(feeling);
      }
      return next;
    });
  };

  const handleGenerateBatch = async () => {
    if (selectedFeelings.size === 0) {
      setError("Please select at least one feeling category.");
      return;
    }

    setIsGenerating(true);
    setError(null);
    setDrafts([]);

    try {
      type GeneratedDraft = Omit<DraftItem, "id" | "selected" | "expanded">;
      const data = await studioApi<{ drafts: GeneratedDraft[]; failures: string[] }>("/songs/drafts", "POST", {
        count, feelings: [...selectedFeelings],
      });
      setDrafts(data.drafts.map((draft, i) => ({
        ...draft, id: "draft_" + i, selected: true, expanded: i === 0,
      })));
      if (data.failures.length) setError(data.failures.join(" "));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate batch");
    } finally {
      setIsGenerating(false);
    }
  };

  const selectedDraftsCount = drafts.filter((d) => d.selected).length;

  const handleSaveSelected = async () => {
    const toSave = drafts.filter((d) => d.selected);
    if (toSave.length === 0) {
      setError("Please select at least one draft to add.");
      return;
    }

    // Check validity of all selected drafts
    for (let i = 0; i < toSave.length; i++) {
      const d = toSave[i];
      const check = validateLyrics(d.lines, settings);
      if (!check.valid) {
        setError(`Draft #${i + 1} ("${d.title}") has rule errors: ${check.errors.join("; ")}`);
        return;
      }
    }

    setIsSaving(true);
    setError(null);
    try {
      await onAddBatch(
        toSave.map((d) => ({
          title: d.title.trim(),
          lines: d.lines.map((l) => l.trim()),
          admin_feeling: d.admin_feeling,
          theme: d.theme,
          mood: d.mood,
          tempo_bpm: d.tempo_bpm,
          instruments: d.instruments,
          vocal_tone: d.vocal_tone,
          feeling_key: d.feeling_key,
          isApproved: approveAll,
        }))
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add batch to library");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
      <div role="dialog" aria-modal="true" aria-label="Batch Song Generator" className="relative flex max-h-[92vh] w-full max-w-3xl flex-col rounded-2xl border border-[#E5E4DF] bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#ECEBE6] px-6 py-4">
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-[#1B3B6F]" />
            <h2 className="text-lg font-bold text-[#141413]">
              Batch Song Generator
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[#706E67] hover:bg-[#F3F2EE] hover:text-[#141413]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="overflow-y-auto px-6 py-5">
          {error && (
            <div className="mb-4 rounded-lg border border-[#FCA5A5] bg-[#FEF2F2] p-3 text-xs text-[#991B1B]">
              <span className="font-semibold">Notice: </span>
              {error}
            </div>
          )}

          {drafts.length === 0 ? (
            /* Setup Parameters */
            <div className="space-y-5">
              {/* Count selector */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-[#141413]">
                    Number of Songs to Generate ({count})
                  </label>
                  <span className="font-mono text-xs text-[#6E6C66]">1 to {MAX_DRAFT_BATCH}</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={MAX_DRAFT_BATCH}
                  step={1}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                  className="mt-2 w-full cursor-pointer accent-[#1B3B6F]"
                />
                <div className="mt-1 flex justify-between text-[11px] text-[#8A877F]">
                  <span>1 song</span>
                  <span>5 songs</span>
                  <span>10 songs</span>
                  <span>15 songs</span>
                  <span>{MAX_DRAFT_BATCH} songs</span>
                </div>
              </div>

              {/* Feelings selection with "Fill the gaps" */}
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="text-xs font-semibold text-[#141413]">
                    Categories to Include ({selectedFeelings.size} selected)
                  </label>
                  <button
                    type="button"
                    onClick={handleFillTheGaps}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[#1B3B6F] bg-[#EFF6FF] px-2.5 py-1 text-xs font-semibold text-[#1B3B6F] hover:bg-[#DBEAFE]"
                  >
                    <Wand2 className="h-3.5 w-3.5" />
                    Fill the gaps (fewest approved)
                  </button>
                </div>

                <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {settings.feelings.map((feeling) => {
                    const isChecked = selectedFeelings.has(feeling);
                    const approvedCount = feelingApprovedCounts[feeling] || 0;
                    return (
                      <button
                        key={feeling}
                        type="button"
                        onClick={() => toggleFeeling(feeling)}
                        className={`flex flex-col items-start rounded-lg border p-2.5 text-left text-xs transition-all ${
                          isChecked
                            ? "border-[#1B3B6F] bg-[#F4F7FB] text-[#141413]"
                            : "border-[#E5E4DF] bg-white text-[#6E6C66] hover:border-[#D4D2CA]"
                        }`}
                      >
                        <div className="flex w-full items-center justify-between">
                          <span className="font-medium">{feeling}</span>
                          <span
                            className={`h-3.5 w-3.5 rounded border flex items-center justify-center ${
                              isChecked
                                ? "border-[#1B3B6F] bg-[#1B3B6F] text-white"
                                : "border-[#D4D2CA]"
                            }`}
                          >
                            {isChecked && <Check className="h-2.5 w-2.5" />}
                          </span>
                        </div>
                        <span className="mt-1 font-mono text-[10px] text-[#706E67]">
                          {approvedCount} ready/approved
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-lg border border-[#E5E4DF] bg-[#FAF9F6] p-3 text-xs text-[#57554F]">
                <p className="font-semibold text-[#141413]">Review before saving:</p>
                <p className="mt-1">
                  Gemini will draft all {count} songs following your settings ({settings.lines_per_song} lines, max {settings.max_words_per_line} words/line). You can review, adjust, uncheck, or edit any draft before anything is written to the library.
                </p>
              </div>
            </div>
          ) : (
            /* Step 2: Review all generated drafts */
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#ECEBE6] pb-3">
                <div>
                  <h3 className="text-sm font-bold text-[#141413]">
                    Review Generated Drafts ({selectedDraftsCount}/{drafts.length} selected)
                  </h3>
                  <p className="text-xs text-[#6E6C66]">
                    Inspect, adjust lyrics, or uncheck any song before saving.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setDrafts((prev) =>
                        prev.map((d) => ({
                          ...d,
                          selected: selectedDraftsCount !== drafts.length,
                        }))
                      )
                    }
                    className="text-xs font-medium text-[#1B3B6F] hover:underline"
                  >
                    {selectedDraftsCount === drafts.length
                      ? "Deselect all"
                      : "Select all"}
                  </button>
                  <span className="text-[#D4D2CA]">|</span>
                  <button
                    type="button"
                    onClick={() => setDrafts([])}
                    className="text-xs font-medium text-[#706E67] hover:underline"
                  >
                    Start over
                  </button>
                </div>
              </div>

              {/* Drafts List */}
              <div className="space-y-3">
                {drafts.map((draft, idx) => {
                  const rhyme = checkRhyme(draft.lines, settings.rhyme_scheme);
                  const check = validateLyrics(draft.lines, settings);
                  return (
                    <div
                      key={draft.id}
                      className={`rounded-xl border transition-all ${
                        draft.selected
                          ? "border-[#D4D2CA] bg-white shadow-xs"
                          : "border-[#ECEBE6] bg-[#FAF9F6] opacity-60"
                      }`}
                    >
                      {/* Top Header Row */}
                      <div className="flex items-center justify-between p-3">
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            checked={draft.selected}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setDrafts((prev) =>
                                prev.map((d) =>
                                  d.id === draft.id ? { ...d, selected: checked } : d
                                )
                              );
                            }}
                            className="h-4 w-4 accent-[#1B3B6F]"
                          />
                          <span className="font-mono text-xs font-semibold text-[#706E67]">
                            #{String(idx + 1).padStart(2, "0")}
                          </span>
                          <span dir="rtl" className="font-arabic font-bold text-[#141413]">
                            {draft.title}
                          </span>
                          <span className="rounded-full bg-[#F3F2EE] px-2 py-0.5 text-[11px] font-medium text-[#57554F]">
                            {draft.admin_feeling}
                          </span>
                        </div>

                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-emerald-700">New ✓ · {draft.closest_match_pct}% closest match</span>
                          {check.valid ? (
                            <span className="inline-flex items-center gap-1 font-mono text-[11px] font-medium text-[#15803D]">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Valid
                            </span>
                          ) : (
                            <span className="rounded bg-[#FEF2F2] px-2 py-0.5 text-[10px] font-semibold text-[#B91C1C]">
                              {check.errors.length} warnings
                            </span>
                          )}

                          <button
                            type="button"
                            onClick={() => {
                              setDrafts((prev) =>
                                prev.map((d) =>
                                  d.id === draft.id ? { ...d, expanded: !d.expanded } : d
                                )
                              );
                            }}
                            className="rounded p-1 text-[#6E6C66] hover:bg-[#F3F2EE]"
                          >
                            {draft.expanded ? (
                              <ChevronUp className="h-4 w-4" />
                            ) : (
                              <ChevronDown className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                      </div>

                      {/* Expanded Edit Form */}
                      {draft.expanded && (
                        <div className="border-t border-[#ECEBE6] p-3.5 space-y-3 bg-[#FAF9F6] rounded-b-xl">
                          <div>
                            <label className="block text-[11px] font-semibold text-[#57554F]">
                              Title
                            </label>
                            <input
                              type="text"
                              dir="rtl"
                              value={draft.title}
                              onChange={(e) => {
                                const val = e.target.value;
                                setDrafts((prev) =>
                                  prev.map((d) =>
                                    d.id === draft.id ? { ...d, title: val } : d
                                  )
                                );
                              }}
                              className="font-arabic mt-0.5 w-full rounded-md border border-[#D4D2CA] bg-white px-2.5 py-1 text-sm font-semibold text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
                            />
                          </div>

                          <div className="space-y-1.5">
                            <label className="block text-[11px] font-semibold text-[#57554F]">
                              <RhymeSummary result={rhyme} scheme={settings.rhyme_scheme} /> Lyrics ({draft.lines.length} lines, max {settings.max_words_per_line}w/line)
                            </label>
                            {draft.lines.map((line, lineIdx) => {
                              const wc = countLineWords(line);
                              const isOk = wc >= 1 && wc <= settings.max_words_per_line;
                              return (
                                <div key={lineIdx} className="flex items-center gap-2">
                                  <span
                                    className={`shrink-0 font-mono text-[10px] tabular-nums ${
                                      isOk ? "text-[#706E67]" : "font-bold text-[#DC2626]"
                                    }`}
                                  >
                                    L{lineIdx + 1} · {wc}/{settings.max_words_per_line}w<RhymeTag result={rhyme} index={lineIdx} />
                                  </span>
                                  <input
                                    type="text"
                                    dir="rtl"
                                    value={line}
                                    onChange={(e) => {
                                      const text = e.target.value;
                                      setDrafts((prev) =>
                                        prev.map((d) => {
                                          if (d.id !== draft.id) return d;
                                          const nextLines = [...d.lines];
                                          nextLines[lineIdx] = text;
                                          return { ...d, lines: nextLines };
                                        })
                                      );
                                    }}
                                    className="font-arabic flex-1 rounded-md border border-[#D4D2CA] bg-white px-2.5 py-1 text-xs font-medium text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
                                  />
                                </div>
                              );
                            })}
                          </div>

                          {!check.valid && (
                            <div className="rounded-md border border-[#FCA5A5] bg-[#FEF2F2] p-2 text-[11px] text-[#991B1B]">
                              {check.errors.join("; ")}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Approval Checkbox */}
              <label className="flex items-center gap-2.5 rounded-lg border border-[#E5E4DF] bg-white p-3 text-xs text-[#141413]">
                <input
                  type="checkbox"
                  checked={approveAll}
                  onChange={(e) => setApproveAll(e.target.checked)}
                  className="h-4 w-4 accent-[#1B3B6F]"
                />
                <div>
                  <span className="font-semibold">Approve lyrics immediately</span>
                  <p className="text-[11px] text-[#6E6C66]">
                    Sets status to <strong>lyric_approved</strong> for all selected
                    songs so they are ready for audio generation.
                  </p>
                </div>
              </label>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-end gap-3 border-t border-[#ECEBE6] px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[#D4D2CA] bg-white px-4 py-2 text-xs font-semibold text-[#57554F] hover:bg-[#F3F2EE]"
          >
            Cancel
          </button>

          {drafts.length === 0 ? (
            <button
              type="button"
              onClick={handleGenerateBatch}
              disabled={isGenerating || selectedFeelings.size === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-[#1B3B6F] px-5 py-2 text-xs font-semibold text-white hover:bg-[#152E57] disabled:opacity-60"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Drafting {count} songs with Gemini…
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  Generate {count} Drafts
                </>
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSaveSelected}
              disabled={isSaving || selectedDraftsCount === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-[#1B3B6F] px-5 py-2 text-xs font-semibold text-white hover:bg-[#152E57] disabled:opacity-50"
            >
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Adding to library…
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" />
                  Add {selectedDraftsCount} Songs to Library
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
