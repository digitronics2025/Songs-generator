import { useState } from "react";
import {
  Sparkles,
  X,
  Loader2,
  Check,
  CheckCircle2,
} from "lucide-react";
import type { StudioSettings } from "../data/songs";
import { studioApi } from "../lib/api";
import { countLineWords, validateLyrics } from "../lib/lyricQuality";

interface NewSongModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: StudioSettings;
  onAddSong: (newSong: {
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
  }) => Promise<void>;
}

interface GeneratedOption {
  title: string;
  lines: string[];
  theme: string;
  mood: string;
  tempo_bpm: number;
  instruments: string;
  vocal_tone: string;
  feeling_key: string;
  admin_feeling: string;
  closest_match_pct: number;
  validation: { valid: boolean; errors: string[] };
}

export function NewSongModal({
  isOpen,
  onClose,
  settings,
  onAddSong,
}: NewSongModalProps) {
  const [selectedFeeling, setSelectedFeeling] = useState<string>(
    settings.feelings[0] || "mothers_care"
  );
  const [idea, setIdea] = useState("");
  const [mood, setMood] = useState("");
  const [optionsCount, setOptionsCount] = useState(3);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [generatedOptions, setGeneratedOptions] = useState<GeneratedOption[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftLines, setDraftLines] = useState<string[]>([]);
  const [approveLyric, setApproveLyric] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  if (!isOpen) return null;

  const handleGenerate = async () => {
    setIsGenerating(true);
    setError(null);
    setGeneratedOptions([]);

    try {
      const data = await studioApi<{ drafts: GeneratedOption[]; failures: string[] }>("/songs/drafts", "POST", {
        feelings: [selectedFeeling], count: optionsCount, idea: [idea.trim(), mood.trim()].filter(Boolean).join(" — "),
      });
      setGeneratedOptions(data.drafts);
      setSelectedIndex(0);
      setDraftTitle(data.drafts[0].title);
      setDraftLines(data.drafts[0].lines);
      if (data.failures.length) setError(data.failures.join(" "));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate options");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSelectOption = (idx: number) => {
    setSelectedIndex(idx);
    const opt = generatedOptions[idx];
    if (opt) {
      setDraftTitle(opt.title);
      setDraftLines(opt.lines);
    }
  };

  const activeOption = generatedOptions[selectedIndex];
  const activeValidation = validateLyrics(draftLines, settings);

  const handleSaveToLibrary = async () => {
    if (!activeOption) return;
    if (!activeValidation.valid) {
      setError(
        `Lyric rules not satisfied: ${activeValidation.errors.join("; ")}`
      );
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      await onAddSong({
        title: draftTitle.trim() || activeOption.title,
        lines: draftLines.map((l) => l.trim()),
        admin_feeling: selectedFeeling,
        theme: activeOption.theme,
        mood: activeOption.mood,
        tempo_bpm: activeOption.tempo_bpm,
        instruments: activeOption.instruments,
        vocal_tone: activeOption.vocal_tone,
        feeling_key: activeOption.feeling_key,
        isApproved: approveLyric,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add song to library");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
      <div role="dialog" aria-modal="true" aria-label="Generate new song" className="relative flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl border border-[#E5E4DF] bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#ECEBE6] px-6 py-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-[#1B3B6F]" />
            <h2 className="text-lg font-bold text-[#141413]">Generate New Song</h2>
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

          {generatedOptions.length === 0 ? (
            /* Step 1: Input criteria */
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#141413]">
                  Admin Feeling Category
                </label>
                <select
                  value={selectedFeeling}
                  onChange={(e) => setSelectedFeeling(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-[#D4D2CA] bg-white px-3 py-2 text-sm text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
                >
                  {settings.feelings.map((feeling) => (
                    <option key={feeling} value={feeling}>
                      {feeling}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#141413]">
                  Specific Story or Idea (Optional)
                </label>
                <input
                  type="text"
                  value={idea}
                  onChange={(e) => setIdea(e.target.value)}
                  placeholder="e.g. A father giving his daughter the key to her new store..."
                  className="mt-1 w-full rounded-lg border border-[#D4D2CA] bg-white px-3 py-2 text-sm text-[#141413] placeholder:text-[#8A877F] focus:border-[#1B3B6F] focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#141413]">
                  Emotional Mood (Optional)
                </label>
                <input
                  type="text"
                  value={mood}
                  onChange={(e) => setMood(e.target.value)}
                  placeholder="e.g. Nostalgic, grateful, peaceful, joyful"
                  className="mt-1 w-full rounded-lg border border-[#D4D2CA] bg-white px-3 py-2 text-sm text-[#141413] placeholder:text-[#8A877F] focus:border-[#1B3B6F] focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#141413]">
                  Number of Options to Write (1–5)
                </label>
                <div className="mt-1.5 flex gap-2">
                  {[1, 2, 3, 4, 5].map((cnt) => (
                    <button
                      key={cnt}
                      type="button"
                      onClick={() => setOptionsCount(cnt)}
                      className={`flex-1 rounded-lg border py-2 text-xs font-semibold transition-all ${
                        optionsCount === cnt
                          ? "border-[#1B3B6F] bg-[#1B3B6F] text-white"
                          : "border-[#D4D2CA] bg-white text-[#57554F] hover:border-[#1B3B6F]"
                      }`}
                    >
                      {cnt} {cnt === 1 ? "Option" : "Options"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-[#E5E4DF] bg-[#FAF9F6] p-3 text-xs text-[#57554F]">
                <p className="font-semibold text-[#141413]">Writing Rules in effect:</p>
                <p className="mt-1">
                  Everyday Moroccan Darija in Arabic letters, exactly{" "}
                  <strong>{settings.lines_per_song} lines</strong>, max{" "}
                  <strong>{settings.max_words_per_line} words/line</strong>, hopeful
                  ending. Anti-collision check prevents repeating existing scenes or
                  titles.
                </p>
              </div>
            </div>
          ) : (
            /* Step 2: Review & Edit Generated Options */
            <div className="space-y-4">
              {/* Option Selector Tabs */}
              <div className="flex items-center justify-between border-b border-[#ECEBE6] pb-2">
                <div className="flex gap-1.5">
                  {generatedOptions.map((opt, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => handleSelectOption(i)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                        selectedIndex === i
                          ? "bg-[#1B3B6F] text-white"
                          : "bg-[#F3F2EE] text-[#57554F] hover:bg-[#E5E4DF]"
                      }`}
                    >
                      Option {i + 1}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setGeneratedOptions([]);
                  }}
                  className="text-xs font-medium text-[#1B3B6F] hover:underline"
                >
                  Regenerate options
                </button>
              </div>

              {/* Editable Title */}
              <div>
                <label className="block text-xs font-semibold text-[#57554F]">
                  Song Title (first words of Line 1)
                </label>
                <input
                  type="text"
                  dir="rtl"
                  aria-label="Song title"
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  className="font-arabic mt-1 w-full rounded-lg border border-[#D4D2CA] bg-white px-3 py-1.5 text-base font-semibold text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
                />
              </div>

              {/* Editable Lyrics */}
              <div className="space-y-2 rounded-xl border border-[#ECEBE6] bg-[#FAF9F6] p-3.5">
                <div className="flex items-center justify-between text-xs text-[#6E6C66]">
                  <span>Darija Lyrics (target: {settings.lines_per_song} lines)</span>
                  <span>Word count limit: {settings.max_words_per_line}w/line</span>
                </div>

                {draftLines.map((line, idx) => {
                  const wc = countLineWords(line);
                  const isWordOk = wc >= 1 && wc <= settings.max_words_per_line;
                  return (
                    <div key={idx} className="flex items-center gap-2">
                      <span
                        className={`w-12 font-mono text-[11px] tabular-nums ${
                          isWordOk ? "text-[#706E67]" : "font-bold text-[#DC2626]"
                        }`}
                      >
                        L{idx + 1}: {wc}w
                      </span>
                      <input
                        type="text"
                        dir="rtl"
                        value={line}
                        onChange={(e) => {
                          const next = [...draftLines];
                          next[idx] = e.target.value;
                          setDraftLines(next);
                        }}
                        className="font-arabic flex-1 rounded-md border border-[#D4D2CA] bg-white px-3 py-1.5 text-sm font-medium text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
                      />
                    </div>
                  );
                })}
              </div>

              {/* Validation Feedback */}
              {!activeValidation.valid ? (
                <div className="rounded-lg border border-[#FCA5A5] bg-[#FEF2F2] p-3 text-xs text-[#991B1B]">
                  <p className="font-semibold">Rule warnings:</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {activeValidation.errors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 rounded-lg border border-[#BBF7D0] bg-[#F0FDF4] px-3 py-2 text-xs font-medium text-[#166534]">
                  <CheckCircle2 className="h-4 w-4 text-[#15803D]" />
                  <span>All lyric rules passed (exact line count, word limits &amp; clean words).</span>
                </div>
              )}

              {/* Approval Checkbox */}
              <label className="flex items-center gap-2.5 rounded-lg border border-[#E5E4DF] bg-white p-3 text-xs text-[#141413]">
                <input
                  type="checkbox"
                  checked={approveLyric}
                  onChange={(e) => setApproveLyric(e.target.checked)}
                  className="h-4 w-4 accent-[#1B3B6F]"
                />
                <div>
                  <span className="font-semibold">Approve lyric immediately</span>
                  <p className="text-[11px] text-[#6E6C66]">
                    Sets status to <strong>lyric_approved</strong> so you can generate
                    audio. If unticked, saved as <strong>draft</strong>.
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

          {generatedOptions.length === 0 ? (
            <button
              type="button"
              onClick={handleGenerate}
              disabled={isGenerating}
              className="inline-flex items-center gap-2 rounded-lg bg-[#1B3B6F] px-5 py-2 text-xs font-semibold text-white hover:bg-[#152E57] disabled:opacity-60"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Generating with Gemini…
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  Generate {optionsCount} Options
                </>
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSaveToLibrary}
              disabled={isSaving || !activeValidation.valid}
              className="inline-flex items-center gap-2 rounded-lg bg-[#1B3B6F] px-5 py-2 text-xs font-semibold text-white hover:bg-[#152E57] disabled:opacity-50"
            >
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" />
                  Add to Library ({approveLyric ? "lyric_approved" : "draft"})
                </>
              )}
            </button>
          )}
        </div>
        {activeOption && <p className="px-6 pb-3 text-xs text-emerald-700">New ✓ · {activeOption.closest_match_pct}% closest match before edits</p>}
      </div>
    </div>
  );
}
