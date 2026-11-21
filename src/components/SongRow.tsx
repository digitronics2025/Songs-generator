import { useMemo, useState } from "react";
import {
  Play,
  Pause,
  Loader2,
  RotateCcw,
  Sparkles,
  Pencil,
  Check,
  X,
  Download,
  AlertCircle,
  AlertTriangle,
  Plus,
  Trash2,
} from "lucide-react";
import { type SongState } from "../data/songs";
import {
  ADMIN_FEELINGS,
  countLineWords,
  validateLyrics,
  type AdminFeeling,
} from "../lib/lyricQuality";

interface SongRowProps {
  song: SongState;
  isPlaying: boolean;
  isActiveTrack: boolean;
  isGenerating: boolean;
  currentTime: number;
  duration: number;
  isBatchRunning: boolean;
  onTogglePlay: (song: SongState) => void;
  onSeek: (time: number) => void;
  onGenerate: (songNumber: number) => void;
  onDownloadSingle: (song: SongState) => void;
  onChangeAdminFeeling: (songNumber: number, adminFeeling: AdminFeeling) => Promise<void>;
  onSaveEdit: (
    songNumber: number,
    updates: {
      title: string;
      lines: string[];
      mood: string;
      tempo_bpm: number;
      instruments: string;
      admin_feeling: AdminFeeling;
    }
  ) => Promise<void>;
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function SongRow({
  song,
  isPlaying,
  isActiveTrack,
  isGenerating,
  currentTime,
  duration,
  isBatchRunning,
  onTogglePlay,
  onSeek,
  onGenerate,
  onDownloadSingle,
  onChangeAdminFeeling,
  onSaveEdit,
}: SongRowProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingFeeling, setSavingFeeling] = useState(false);
  const [draftTitle, setDraftTitle] = useState(song.title);
  const [draftLines, setDraftLines] = useState<string[]>(song.lines);
  const [draftMood, setDraftMood] = useState(song.mood);
  const [draftTempo, setDraftTempo] = useState(song.tempo_bpm);
  const [draftInstruments, setDraftInstruments] = useState(song.instruments);
  const [draftAdminFeeling, setDraftAdminFeeling] = useState<AdminFeeling>(song.admin_feeling);

  const savedLyricCheck = useMemo(() => validateLyrics(song.lines), [song.lines]);
  const draftLyricCheck = useMemo(() => validateLyrics(draftLines), [draftLines]);

  const startEdit = () => {
    setDraftTitle(song.title);
    const padded = [...song.lines];
    while (padded.length < 6) {
      padded.push("");
    }
    setDraftLines(padded);
    setDraftMood(song.mood);
    setDraftTempo(song.tempo_bpm);
    setDraftInstruments(song.instruments);
    setDraftAdminFeeling(song.admin_feeling);
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const cleanedLines = draftLines.map((l) => l.trim()).filter((l, idx) => l.length > 0 || idx < 6);
      await onSaveEdit(song.number, {
        title: draftTitle,
        lines: cleanedLines.slice(0, 8),
        mood: draftMood,
        tempo_bpm: Math.min(100, Math.max(70, Number(draftTempo) || 80)),
        instruments: draftInstruments,
        admin_feeling: draftAdminFeeling,
      });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleFeelingSelect = async (next: AdminFeeling) => {
    setSavingFeeling(true);
    try {
      await onChangeAdminFeeling(song.number, next);
    } finally {
      setSavingFeeling(false);
    }
  };

  const trackDuration = isActiveTrack && duration > 0 ? duration : song.duration_seconds || 0;
  const trackProgress = isActiveTrack && trackDuration > 0 ? (currentTime / trackDuration) * 100 : 0;
  const paddedNumber = String(song.number).padStart(2, "0");

  const hasWordsCheck = typeof song.words_heard_pct === "number";
  const wordsWarning = hasWordsCheck && (song.words_heard_pct ?? 0) < 90;
  const hasVoiceStart = typeof song.voice_start_seconds === "number";
  const hasVoiceEnd = typeof song.voice_end_seconds === "number";
  const voiceStartWarning = hasVoiceStart && (song.voice_start_seconds ?? 0) > 1;
  const voiceEndWarning = hasVoiceEnd && (song.voice_end_seconds ?? 0) > 27;

  return (
    <article className="border-b border-[#E5E4DF] bg-white px-5 py-5 transition-colors hover:bg-[#FCFBF9] sm:px-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        {/* Left: Number, Play Control, Metadata & Title */}
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <div className="flex shrink-0 flex-col items-center gap-2 pt-0.5">
            <span className="font-mono text-xs font-medium text-[#706E67] tabular-nums">
              {paddedNumber}
            </span>
            <button
              type="button"
              onClick={() => onTogglePlay(song)}
              disabled={song.status !== "ready" || (!song.download_url && !song.storage_path)}
              aria-label={isPlaying ? `Pause ${song.feeling_key}` : `Play ${song.feeling_key}`}
              className={`flex h-10 w-10 items-center justify-center rounded-lg border transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1B3B6F] ${
                song.status === "ready"
                  ? isPlaying
                    ? "border-[#1B3B6F] bg-[#1B3B6F] text-white"
                    : "border-[#D4D2CA] bg-white text-[#141413] hover:border-[#1B3B6F] hover:text-[#1B3B6F]"
                  : "cursor-not-allowed border-[#ECEBE6] bg-[#F8F8F6] text-[#B5B2A9]"
              }`}
            >
              {isGenerating || song.status === "generating" ? (
                <Loader2 className="h-4 w-4 animate-spin text-[#1B3B6F]" />
              ) : isPlaying ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4 translate-x-0.5" />
              )}
            </button>
          </div>

          <div className="min-w-0 flex-1">
            {/* Title + Theme Row */}
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3
                  dir="rtl"
                  className="font-arabic text-xl font-semibold tracking-normal text-[#141413]"
                >
                  {song.title}
                </h3>
                <span className="font-mono text-xs text-[#6E6C66] tabular-nums">
                  {song.file_name}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                {isGenerating || song.status === "generating" ? (
                  <span className="inline-flex items-center gap-1.5 font-medium text-[#1B3B6F]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Generating, checking voice &amp; uploading…
                  </span>
                ) : song.status === "pending" ? (
                  <span className="text-[#6E6C66]">Pending review</span>
                ) : song.status === "ready" ? (
                  <span className="inline-flex items-center gap-1.5 font-medium text-[#15803D] tabular-nums">
                    <Check className="h-3.5 w-3.5" />
                    Ready · {song.duration_seconds?.toFixed(1)}s · {song.lufs?.toFixed(1) ?? "-14.0"} LUFS
                    {song.model_used ? ` · ${song.model_used}` : ""}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 font-medium text-[#B91C1C]">
                    <AlertCircle className="h-3.5 w-3.5" />
                    Generation failed
                  </span>
                )}
              </div>
            </div>

            {/* Metadata + admin_feeling dropdown */}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] text-[#57554F]">
              <span>{song.theme}</span>
              <span aria-hidden="true">·</span>
              <span>{song.mood}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-xs tabular-nums">{song.tempo_bpm} BPM</span>
              <span aria-hidden="true">·</span>
              <span className="text-[#706E67]">{song.instruments}</span>
              <span aria-hidden="true">·</span>
              <label className="inline-flex items-center gap-1.5">
                <span className="font-mono text-[11px] font-medium text-[#3F3E39]">
                  admin_feeling:
                </span>
                <select
                  value={song.admin_feeling}
                  disabled={savingFeeling || isGenerating || isBatchRunning}
                  onChange={(e) => {
                    void handleFeelingSelect(e.target.value as AdminFeeling);
                  }}
                  aria-label={`admin_feeling for song ${song.number}`}
                  className="rounded-md border border-[#D4D2CA] bg-[#FAF9F6] px-2 py-0.5 font-mono text-[11px] text-[#141413] focus:border-[#1B3B6F] focus:bg-white focus:outline-none disabled:opacity-60"
                >
                  {ADMIN_FEELINGS.map((feeling) => (
                    <option key={feeling} value={feeling}>
                      {feeling}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {/* Red Lyric Rule Warnings (always shown if song breaks admin lyric rules) */}
            {!savedLyricCheck.valid && !editing && (
              <div className="mt-2.5 rounded-lg border border-[#FCA5A5] bg-[#FEF2F2] px-3.5 py-2.5 text-xs text-[#991B1B]">
                <div className="flex items-center gap-1.5 font-semibold">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 text-[#DC2626]" />
                  <span>Lyric rules not met — generation blocked until fixed:</span>
                </div>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
                  {savedLyricCheck.errors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Post-Generation Gemini Transcription & Voice Timing Quality Checks */}
            {(hasWordsCheck || hasVoiceStart || hasVoiceEnd) && (
              <div className="mt-2.5 rounded-lg border border-[#E5E4DF] bg-[#FAF9F6] px-3.5 py-2.5 text-xs">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  {hasWordsCheck && (
                    <span
                      className={`inline-flex items-center gap-1.5 font-medium tabular-nums ${
                        wordsWarning ? "text-[#B91C1C]" : "text-[#15803D]"
                      }`}
                    >
                      {wordsWarning ? (
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <Check className="h-3.5 w-3.5 shrink-0" />
                      )}
                      Words heard: {song.words_heard_pct}%
                      {wordsWarning ? " (Warning: under 90%)" : ""}
                    </span>
                  )}

                  {(hasVoiceStart || hasVoiceEnd) && (
                    <span
                      className={`inline-flex items-center gap-1.5 font-mono text-[11px] font-medium tabular-nums ${
                        voiceStartWarning || voiceEndWarning ? "text-[#B91C1C]" : "text-[#15803D]"
                      }`}
                    >
                      {voiceStartWarning || voiceEndWarning ? (
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <Check className="h-3.5 w-3.5 shrink-0" />
                      )}
                      Voice start:{" "}
                      {hasVoiceStart ? `${song.voice_start_seconds?.toFixed(1)}s` : "—"}
                      {voiceStartWarning ? " (> 1s!)" : ""} · Voice end:{" "}
                      {hasVoiceEnd ? `${song.voice_end_seconds?.toFixed(1)}s` : "—"}
                      {voiceEndWarning ? " (> 27s!)" : ""}
                    </span>
                  )}
                </div>

                {song.transcribed_text && (
                  <p dir="rtl" className="font-arabic mt-1.5 text-right text-[13px] text-[#3F3E39]">
                    <span dir="ltr" className="ml-2 font-sans text-[11px] font-medium text-[#6E6C66]">
                      Gemini heard:
                    </span>
                    {song.transcribed_text}
                  </p>
                )}

                {((song.missing_words && song.missing_words.length > 0) ||
                  (song.extra_words && song.extra_words.length > 0)) && (
                  <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 border-t border-[#ECEBE6] pt-1.5 text-[11px]">
                    {song.missing_words && song.missing_words.length > 0 && (
                      <div className="text-[#991B1B]">
                        <span className="font-semibold">Missing ({song.missing_words.length}): </span>
                        <span dir="rtl" className="font-arabic">
                          {song.missing_words.join(" ، ")}
                        </span>
                      </div>
                    )}
                    {song.extra_words && song.extra_words.length > 0 && (
                      <div className="text-[#92400E]">
                        <span className="font-semibold">Extra ({song.extra_words.length}): </span>
                        <span dir="rtl" className="font-arabic">
                          {song.extra_words.join(" ، ")}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Error details if failed */}
            {song.status === "error" && song.error_message && (
              <p className="mt-2 rounded-md border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-xs text-[#991B1B]">
                {song.error_message}
              </p>
            )}

            {/* Inline Audio Scrubber when Ready */}
            {song.status === "ready" && (
              <div className="mt-3 flex items-center gap-3">
                <span className="w-9 font-mono text-[11px] text-[#6E6C66] tabular-nums">
                  {isActiveTrack ? formatTime(currentTime) : "0:00"}
                </span>
                <input
                  type="range"
                  min={0}
                  max={trackDuration || 40}
                  step={0.1}
                  value={isActiveTrack ? currentTime : 0}
                  disabled={!isActiveTrack}
                  onChange={(e) => onSeek(Number(e.target.value))}
                  aria-label={`Seek ${song.feeling_key}`}
                  style={{
                    background: `linear-gradient(to right, #1B3B6F ${trackProgress}%, #E5E4DF ${trackProgress}%)`,
                  }}
                  className="h-1.5 w-full max-w-md cursor-pointer appearance-none rounded-full accent-[#1B3B6F] disabled:cursor-default"
                />
                <span className="w-9 text-right font-mono text-[11px] text-[#6E6C66] tabular-nums">
                  {formatTime(trackDuration)}
                </span>
              </div>
            )}

            {/* Lyrics View or Edit Form */}
            {!editing ? (
              <div className="mt-3.5 grid gap-1.5 border-t border-[#F0EFEA] pt-3">
                {song.lines.map((line, index) => {
                  const wc = countLineWords(line);
                  const wcOk = wc >= 1 && wc <= 5;
                  return (
                    <div key={index} className="flex items-baseline justify-between gap-4">
                      <span
                        className={`font-mono text-[11px] tabular-nums ${
                          wcOk ? "text-[#8A877F]" : "font-semibold text-[#DC2626]"
                        }`}
                      >
                        L{index + 1} · {wc}/5w
                      </span>
                      <p
                        dir="rtl"
                        className="font-arabic flex-1 text-right text-[15px] leading-[1.7] font-medium text-[#1F1E1C]"
                      >
                        {line}
                      </p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="mt-3.5 space-y-3 rounded-lg border border-[#DCDAD2] bg-[#FAF9F6] p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-[#57554F]">
                      Arabic Title (first words of Line 1)
                    </span>
                    <input
                      type="text"
                      dir="rtl"
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      className="font-arabic w-full rounded-md border border-[#D4D2CA] bg-white px-3 py-1.5 text-sm text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
                    />
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-[#57554F]">
                        admin_feeling
                      </span>
                      <select
                        value={draftAdminFeeling}
                        onChange={(e) => setDraftAdminFeeling(e.target.value as AdminFeeling)}
                        className="w-full rounded-md border border-[#D4D2CA] bg-white px-2 py-1.5 font-mono text-xs text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
                      >
                        {ADMIN_FEELINGS.map((f) => (
                          <option key={f} value={f}>
                            {f}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-[#57554F]">Mood</span>
                      <input
                        type="text"
                        value={draftMood}
                        onChange={(e) => setDraftMood(e.target.value)}
                        className="w-full rounded-md border border-[#D4D2CA] bg-white px-2.5 py-1.5 text-sm text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-[#57554F]">
                        Tempo (70–100)
                      </span>
                      <input
                        type="number"
                        min={70}
                        max={100}
                        value={draftTempo}
                        onChange={(e) => setDraftTempo(Number(e.target.value))}
                        className="font-mono w-full rounded-md border border-[#D4D2CA] bg-white px-2.5 py-1.5 text-sm text-[#141413] tabular-nums focus:border-[#1B3B6F] focus:outline-none"
                      />
                    </label>
                  </div>
                </div>

                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-[#57554F]">
                    Instrumentation
                  </span>
                  <input
                    type="text"
                    value={draftInstruments}
                    onChange={(e) => setDraftInstruments(e.target.value)}
                    className="w-full rounded-md border border-[#D4D2CA] bg-white px-3 py-1.5 text-sm text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
                  />
                </label>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="block text-xs font-medium text-[#57554F]">
                      Exactly 6 Moroccan Darija Lines (max 5 words per line)
                    </span>
                    {draftLines.length < 6 && (
                      <button
                        type="button"
                        onClick={() => setDraftLines((prev) => [...prev, ""])}
                        className="inline-flex items-center gap-1 rounded border border-[#D4D2CA] bg-white px-2 py-0.5 text-[11px] font-medium text-[#1B3B6F] hover:border-[#1B3B6F]"
                      >
                        <Plus className="h-3 w-3" />
                        Add line
                      </button>
                    )}
                  </div>
                  {draftLines.map((line, idx) => {
                    const wc = countLineWords(line);
                    return (
                      <div key={idx} className="flex items-center gap-2">
                        <span
                          className={`w-14 shrink-0 font-mono text-[11px] tabular-nums ${
                            wc >= 1 && wc <= 5 ? "text-[#6E6C66]" : "font-semibold text-[#DC2626]"
                          }`}
                        >
                          L{idx + 1}: {wc}/5w
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
                          className="font-arabic w-full rounded-md border border-[#D4D2CA] bg-white px-3 py-1.5 text-sm text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
                        />
                        {draftLines.length > 6 && (
                          <button
                            type="button"
                            onClick={() =>
                              setDraftLines((prev) => prev.filter((_, i) => i !== idx))
                            }
                            aria-label={`Remove line ${idx + 1}`}
                            className="rounded p-1 text-[#8A877F] hover:text-[#DC2626]"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {!draftLyricCheck.valid && (
                  <div className="rounded-md border border-[#FCA5A5] bg-[#FEF2F2] px-3 py-2 text-xs text-[#991B1B]">
                    <p className="font-semibold">Rule warnings in draft:</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {draftLyricCheck.errors.map((err, i) => (
                        <li key={i}>{err}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[#D4D2CA] bg-white px-3 py-1.5 text-xs font-medium text-[#3F3E39] hover:bg-[#F3F2EE] whitespace-nowrap shrink-0"
                  >
                    <X className="h-3.5 w-3.5" />
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={handleSave}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[#1B3B6F] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#152E57] disabled:opacity-60 whitespace-nowrap shrink-0"
                  >
                    <Check className="h-3.5 w-3.5" />
                    {saving ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: Action Buttons */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 lg:flex-col lg:items-end">
          <div className="flex items-center gap-2">
            {!editing && (
              <button
                type="button"
                onClick={startEdit}
                disabled={isGenerating || song.status === "generating"}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#D4D2CA] bg-white px-3 py-2 text-xs font-medium text-[#3F3E39] transition-colors hover:border-[#A8A59B] hover:text-[#141413] disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit lyric
              </button>
            )}

            <button
              type="button"
              onClick={() => onGenerate(song.number)}
              disabled={
                !savedLyricCheck.valid ||
                isGenerating ||
                song.status === "generating" ||
                isBatchRunning
              }
              title={
                !savedLyricCheck.valid
                  ? "Fix red lyric rule warnings before generating"
                  : undefined
              }
              className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap shrink-0 ${
                song.status === "ready"
                  ? "border border-[#D4D2CA] bg-white text-[#141413] hover:border-[#1B3B6F] hover:text-[#1B3B6F]"
                  : "bg-[#1B3B6F] text-white hover:bg-[#152E57]"
              }`}
            >
              {isGenerating || song.status === "generating" ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Generating…
                </>
              ) : song.status === "ready" ? (
                <>
                  <RotateCcw className="h-3.5 w-3.5" />
                  Regenerate
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  Generate
                </>
              )}
            </button>
          </div>

          {!savedLyricCheck.valid && (
            <span className="text-[11px] font-medium text-[#DC2626]">
              Fix lyric rules to generate
            </span>
          )}

          {song.status === "ready" && (song.download_url || song.storage_path) && (
            <button
              type="button"
              onClick={() => onDownloadSingle(song)}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#D4D2CA] bg-[#FAF9F6] px-3 py-1.5 font-mono text-[11px] font-medium text-[#3F3E39] transition-colors hover:border-[#1B3B6F] hover:text-[#1B3B6F] whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" />
              Download WAV
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
