import { useMemo, useState } from "react";
import { SongDetails } from "./SongDetails";
import {
  Play,
  Pause,
  Loader2,
  RotateCcw,
  Sparkles,
  Pencil,
  Check,
  Download,
  AlertCircle,
  Plus,
  Trash2,
  History,
  CheckCircle2,
  ShieldCheck,
  Archive,
  ArchiveRestore,
  Layers,
} from "lucide-react";
import type { SongState, SongTake, StudioSettings } from "../data/songs";
import { countLineWords, validateLyrics } from "../lib/lyricQuality";

interface SongRowProps {
  song: SongState;
  settings: StudioSettings;
  isPlaying: boolean;
  isActiveTrack: boolean;
  isGenerating: boolean;
  currentTime: number;
  duration: number;
  isBatchRunning: boolean;
  isSelected?: boolean;
  onToggleSelect?: (songId: string) => void;
  onTogglePlay: (song: SongState, take?: SongTake) => void;
  onSeek: (time: number) => void;
  onGenerate: (songNumber: number) => void;
  onDownloadSingle: (song: SongState, take?: SongTake) => void;
  onChangeAdminFeeling: (songId: string, adminFeeling: string) => Promise<void>;
  onSaveEdit: (
    songId: string,
    updates: {
      title: string;
      lines: string[];
      mood: string;
      tempo_bpm: number;
      instruments: string;
      admin_feeling: string;
    }
  ) => Promise<void>;
  onApproveLyric: (songId: string) => Promise<void>;
  onCheckVocals: (songNumber: number, takeId: string) => void;
  onApproveTake: (songId: string, takeId: string) => Promise<void>;
  onChooseTake: (songId: string, takeId: string) => Promise<void>;
  onToggleArchive: (songId: string, archive: boolean) => Promise<void>;
  onViewHistory?: (songNumber: number) => void;
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function SongRow({
  song,
  settings,
  isPlaying,
  isActiveTrack,
  isGenerating,
  currentTime,
  duration,
  isBatchRunning,
  isSelected = false,
  onToggleSelect,
  onTogglePlay,
  onSeek,
  onGenerate,
  onDownloadSingle,
  onChangeAdminFeeling,
  onSaveEdit,
  onApproveLyric,
  onCheckVocals,
  onApproveTake,
  onChooseTake,
  onToggleArchive,
  onViewHistory,
}: SongRowProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingFeeling, setSavingFeeling] = useState(false);
  const [showTakesDrawer, setShowTakesDrawer] = useState(false);

  const [draftTitle, setDraftTitle] = useState(song.title);
  const [draftLines, setDraftLines] = useState<string[]>(song.lines);
  const [draftMood, setDraftMood] = useState(song.mood);
  const [draftTempo, setDraftTempo] = useState(song.tempo_bpm);
  const [draftInstruments, setDraftInstruments] = useState(song.instruments);
  const [draftAdminFeeling, setDraftAdminFeeling] = useState<string>(song.admin_feeling);

  const savedLyricCheck = useMemo(
    () => validateLyrics(song.lines, settings),
    [song.lines, settings]
  );
  const draftLyricCheck = useMemo(
    () => validateLyrics(draftLines, settings),
    [draftLines, settings]
  );

  const takes = song.takes || [];
  const hasAudio = Boolean(song.download_url || song.storage_path);
  const canGenerate =
    song.status === "lyric_approved" ||
    song.status === "ready" ||
    song.status === "approved" ||
    song.status === "failed" || song.status === "needs_person" || song.status === "generating";

  const startEdit = () => {
    setDraftTitle(song.title);
    const padded = [...song.lines];
    while (padded.length < settings.lines_per_song) {
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
      await onSaveEdit(song.id, {
        title: draftTitle,
        lines: draftLines.filter((l) => l.trim().length > 0),
        mood: draftMood,
        tempo_bpm: draftTempo,
        instruments: draftInstruments,
        admin_feeling: draftAdminFeeling,
      });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleFeelingSelect = async (nextFeeling: string) => {
    setSavingFeeling(true);
    try {
      await onChangeAdminFeeling(song.id, nextFeeling);
    } finally {
      setSavingFeeling(false);
    }
  };

  const paddedNumber = String(song.number).padStart(2, "0");
  const isBusy = isGenerating;

  return (
    <article
      className={`border-b border-[#ECEBE6] transition-colors ${
        song.archived
          ? "bg-[#FAF9F6] opacity-75"
          : isActiveTrack
          ? "bg-[#F4F7FB]/60"
          : isSelected
          ? "bg-[#EFF6FF]/40"
          : "hover:bg-[#FCFBF8]"
      }`}
    >
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
        {/* Left Side: Checkbox, Audio Play Button, Metadata */}
        <div className="flex min-w-0 flex-1 items-start gap-3.5">
          {/* Checkbox */}
          <div className="pt-2">
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => onToggleSelect?.(song.id)}
              aria-label={`Select song ${song.number}`}
              className="h-4 w-4 cursor-pointer accent-[#1B3B6F]"
            />
          </div>

          {/* Number & Play Button */}
          <div className="flex shrink-0 flex-col items-center gap-1.5 pt-0.5">
            <span className="font-mono text-xs font-semibold text-[#706E67] tabular-nums">
              #{paddedNumber}
            </span>
            <button
              type="button"
              onClick={() => onTogglePlay(song)}
              disabled={!hasAudio}
              aria-label={isPlaying ? `Pause ${song.title}` : `Play ${song.title}`}
              className={`flex h-10 w-10 items-center justify-center rounded-lg border transition-all ${
                hasAudio
                  ? isPlaying
                    ? "border-[#1B3B6F] bg-[#1B3B6F] text-white"
                    : "border-[#D4D2CA] bg-white text-[#141413] hover:border-[#1B3B6F] hover:text-[#1B3B6F]"
                  : "cursor-not-allowed border-[#ECEBE6] bg-[#F8F8F6] text-[#B5B2A9]"
              }`}
            >
              {isBusy ? (
                <Loader2 className="h-4 w-4 animate-spin text-[#1B3B6F]" />
              ) : isPlaying ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4 translate-x-0.5" />
              )}
            </button>
          </div>

          {/* Main Info */}
          <div className="min-w-0 flex-1">
            {/* Title & Status */}
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <h3
                  dir="rtl"
                  className="font-arabic text-xl font-bold tracking-normal text-[#141413]"
                >
                  {song.title}
                </h3>
                <span className="font-mono text-xs text-[#706E67]">
                  ({song.feeling_key})
                </span>
              </div>

              {song.closest_match_pct !== undefined && <span className="text-xs text-emerald-700">New ✓ · {song.closest_match_pct}% closest match</span>}
              {/* Status Badges */}
              <div className="flex items-center gap-2 text-xs">
                {isBusy ? (
                  <span className="inline-flex items-center gap-1.5 font-semibold text-[#1B3B6F]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Generating take…
                  </span>
                ) : song.status === "approved" ? (
                  <span className="inline-flex items-center gap-1 rounded-md bg-[#DCFCE7] px-2.5 py-0.5 font-semibold text-[#15803D]">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {song.auto_approved ? "Auto-approved" : "Approved"}
                    {song.best_take_id ? ` · ${song.best_take_id}` : ""}
                  </span>
                ) : song.status === "ready" ? (
                  <span className="inline-flex items-center gap-1 font-semibold text-[#15803D]">
                    <Check className="h-3.5 w-3.5" />
                    Ready · {song.duration_seconds?.toFixed(1) ?? "30"}s
                    {takes.length > 0 ? ` (${takes.length} takes)` : ""}
                  </span>
                ) : song.status === "lyric_approved" ? (
                  <span className="inline-flex items-center gap-1 rounded-md bg-[#EFF6FF] px-2 py-0.5 font-semibold text-[#1D4ED8]">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Lyric Approved
                  </span>
                ) : song.status === "draft" ? (
                  <span className="rounded-md bg-[#FFFBEB] px-2 py-0.5 font-semibold text-[#92400E]">
                    Draft Lyric
                  </span>
                ) : song.status === "needs_person" ? (
                  <span className="inline-flex items-center gap-1 rounded-md bg-[#FFE4E6] px-2 py-0.5 font-semibold text-[#9F1239]">
                    <AlertCircle className="h-3.5 w-3.5" />
                    Needs Person
                  </span>
                ) : song.status === "failed" ? (
                  <span className="inline-flex items-center gap-1 font-semibold text-[#DC2626]">
                    <AlertCircle className="h-3.5 w-3.5" />
                    Failed
                  </span>
                ) : song.archived ? (
                  <span className="rounded-md bg-[#F3F4F6] px-2 py-0.5 text-[#6B7280]">
                    Archived
                  </span>
                ) : null}
              </div>
            </div>

            {/* Metadata Chips / Feeling selector */}
            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-[#57554F]">
              <span className="font-medium text-[#1B3B6F]">{song.theme}</span>
              <span>·</span>
              <span>{song.mood}</span>
              <span>·</span>
              <span className="font-mono tabular-nums">{song.tempo_bpm} BPM</span>
              <span>·</span>
              <span className="text-[#706E67]">{song.instruments}</span>
              <span>·</span>
              <label className="inline-flex items-center gap-1">
                <span className="font-mono text-[10px] text-[#706E67]">feeling:</span>
                <select
                  value={song.admin_feeling}
                  disabled={savingFeeling || isBusy || isBatchRunning}
                  onChange={(e) => void handleFeelingSelect(e.target.value)}
                  className="rounded border border-[#D4D2CA] bg-white px-1.5 py-0.5 font-mono text-[11px] text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
                >
                  {settings.feelings.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {/* Lyric Rule Warnings if Invalid */}
            {!savedLyricCheck.valid && !editing && (
              <div className="mt-2.5 rounded-lg border border-[#FCA5A5] bg-[#FEF2F2] p-2.5 text-xs text-[#991B1B]">
                <div className="flex items-center gap-1.5 font-semibold">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 text-[#DC2626]" />
                  <span>Lyric rules not met:</span>
                </div>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px]">
                  {savedLyricCheck.errors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Quality check summary (transcription, words heard %, voice timing) */}
            {(typeof song.words_heard_pct === "number" || typeof song.voice_start_seconds === "number") && (
              <div className="mt-2 flex flex-wrap items-center gap-3 rounded-md bg-[#FAF9F6] px-3 py-1.5 text-[11px]">
                {typeof song.words_heard_pct === "number" && (
                  <span
                    className={`font-semibold tabular-nums ${
                      song.words_heard_pct >= 90 ? "text-[#15803D]" : "text-[#B91C1C]"
                    }`}
                  >
                    Words heard: {song.words_heard_pct}%
                  </span>
                )}
                {typeof song.voice_start_seconds === "number" && (
                  <span className="text-[#6E6C66]">
                    Voice: {song.voice_start_seconds.toFixed(1)}s –{" "}
                    {song.voice_end_seconds?.toFixed(1)}s
                  </span>
                )}
                {typeof song.lufs === "number" && (
                  <span className="font-mono text-[#57554F]">
                    {song.lufs.toFixed(1)} LUFS · {song.true_peak_db?.toFixed(1)} dBTP
                  </span>
                )}
              </div>
            )}

            {/* Inline Audio Scrubber when Playing / Has Audio */}
            {hasAudio && (
              <div className="mt-3 flex items-center gap-3">
                <span className="w-8 font-mono text-[10px] text-[#706E67] tabular-nums">
                  {isActiveTrack ? formatTime(currentTime) : "0:00"}
                </span>
                <input
                  type="range"
                  min={0}
                  max={duration || song.duration_seconds || 30}
                  step={0.1}
                  value={isActiveTrack ? currentTime : 0}
                  onChange={(e) => onSeek(Number(e.target.value))}
                  aria-label={`Scrub track ${song.number}`}
                  className="h-1 flex-1 cursor-pointer accent-[#1B3B6F]"
                />
                <span className="w-8 font-mono text-[10px] text-[#706E67] tabular-nums">
                  {formatTime(song.duration_seconds || 30)}
                </span>
              </div>
            )}

            <SongDetails id={song.id} updatedAt={song.updated_at} />
            {/* Takes Drawer */}
            {takes.length > 0 && (
              <div className="mt-3 rounded-lg border border-[#ECEBE6] bg-[#FAF9F6] p-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Layers className="h-3.5 w-3.5 text-[#1B3B6F]" />
                    <span className="text-xs font-semibold text-[#141413]">
                      Takes ({takes.length}):
                    </span>
                    <span className="text-[11px] text-[#6E6C66]">
                      Best: {takes.find((take) => take.id === song.best_take_id)?.take_number ?? "unset"}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowTakesDrawer((prev) => !prev)}
                    className="font-mono text-[11px] text-[#1B3B6F] underline hover:text-[#152E57]"
                  >
                    {showTakesDrawer ? "Hide takes" : "View all takes"}
                  </button>
                </div>

                {showTakesDrawer && (
                  <div className="mt-2 space-y-1.5 border-t border-[#ECEBE6] pt-2">
                    {takes.map((take) => {
                      const isBest = song.best_take_id === take.id;
                      return (
                        <div
                          key={take.id}
                          className={`flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-xs ${
                            isBest
                              ? "border-[#BBF7D0] bg-[#F0FDF4]"
                              : "border-[#E5E4DF] bg-white"
                          }`}
                        >
                          <div className="flex flex-wrap items-center gap-2.5">
                            <span className="font-mono font-bold text-[#141413]">
                              Take #{take.take_number}
                            </span>
                            <span className="text-[#6E6C66]">{take.model}</span>
                            <span className="font-mono">
                              {take.lufs?.toFixed(1) ?? "—"} LUFS
                            </span>
                            <span
                              className={`font-semibold ${
                                take.words_heard_pct === null ? "text-[#6E6C66]" : take.words_heard_pct >= 90
                                  ? "text-[#15803D]"
                                  : "text-[#B91C1C]"
                              }`}
                            >
                              {take.words_heard_pct === null ? "Vocal score unavailable" : take.words_heard_pct + "% heard"}
                            </span>
                            {isBest && (
                              <span className="rounded bg-[#DCFCE7] px-2 py-0.5 text-[10px] font-bold text-[#15803D]">
                                Best Take
                              </span>
                            )}
                          </div>

                          <span className="text-[#6E6C66]">
                            {take.true_peak_db?.toFixed(1) ?? "—"} dBTP · Voice {take.voice_start ?? "—"}–{take.voice_end ?? "—"} s
                            {take.auto_approved ? " · Auto-approved" : take.is_approved ? " · Approved" : ""} {take.failure_reasons?.filter((reason) => reason !== "VOCAL_CHECK_PENDING" && reason !== take.failure_detail?.stage).join(", ")}
                            {take.vocal_check_pending && " · Vocal check pending"}
                          </span>
                          {take.failure_detail && (
                            <p className="basis-full break-words text-[#B91C1C]">
                              <span className="font-semibold">{take.failure_detail.stage}</span> · {take.failure_detail.message}
                            </p>
                          )}
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => onTogglePlay(song, take)}
                              disabled={!take.storage_path && !take.raw_storage_path}
                              className="rounded border border-[#D4D2CA] bg-white px-2 py-0.5 text-[11px] font-medium text-[#1B3B6F] hover:bg-[#F3F2EE]"
                            >
                              Play Take
                            </button>
                            {take.vocal_check_pending && take.storage_path && !take.is_approved && (
                              <button type="button" disabled={isBusy || isBatchRunning}
                                onClick={() => onCheckVocals(song.number, take.id)}
                                title="Runs Gemini vocal analysis using the studio budget"
                                className="rounded border border-[#D4D2CA] px-2 py-0.5 text-[11px] disabled:opacity-50">
                                Check vocals
                              </button>
                            )}
                            {take.status === "ready" && take.storage_path && !isBest && (
                              <button type="button"
                                onClick={() => void onChooseTake(song.id, take.id).catch(() => undefined)}
                                className="rounded border border-[#D4D2CA] px-2 py-0.5 text-[11px]">Choose best</button>
                            )}
                            {take.passed_all_checks && take.status === "ready" && !take.is_approved && (
                              <button
                                type="button"
                                onClick={() => void onApproveTake(song.id, take.id).catch(() => undefined)}
                                className="rounded bg-[#1B3B6F] px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-[#152E57]"
                              >
                                Approve Take
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => onDownloadSingle(song, take)}
                              disabled={!take.storage_path && !take.raw_storage_path}
                              className="rounded p-1 text-[#6E6C66] hover:text-[#141413]"
                              aria-label={"Download take " + take.take_number} title="Download take"
                            >
                              <Download className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {song.proposed_lyric && <p className="mt-2 text-xs text-[#57554F]">Lyric repair awaiting approval. {song.proposed_lyric.reason}</p>}
            {/* Lyrics Text or Edit Box */}
            {!editing ? (
              <div className="mt-3 grid gap-1.5 border-t border-[#F0EFEA] pt-2.5">
                {song.lines.map((line, idx) => {
                  const wc = countLineWords(line);
                  const isWordOk = wc >= 1 && wc <= settings.max_words_per_line;
                  return (
                    <div key={idx} className="flex items-baseline justify-between gap-4">
                      <span
                        className={`font-mono text-[10px] tabular-nums ${
                          isWordOk ? "text-[#8A877F]" : "font-bold text-[#DC2626]"
                        }`}
                      >
                        L{idx + 1} · {wc}/{settings.max_words_per_line}w
                      </span>
                      <p
                        dir="rtl"
                        className="font-arabic flex-1 text-right text-[15px] font-medium text-[#1F1E1C]"
                      >
                        {line}
                      </p>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* Inline Edit Mode */
              <div className="mt-3 space-y-3 rounded-lg border border-[#DCDAD2] bg-[#FAF9F6] p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-semibold text-[#57554F]">
                      Title (Arabic)
                    </label>
                    <input
                      type="text"
                      dir="rtl"
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      className="font-arabic mt-1 w-full rounded-md border border-[#D4D2CA] bg-white px-3 py-1.5 text-sm font-semibold text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#57554F]">
                      Mood &amp; Tempo
                    </label>
                    <div className="mt-1 flex gap-2">
                      <input
                        type="text"
                        value={draftMood}
                        onChange={(e) => setDraftMood(e.target.value)}
                        placeholder="Mood"
                        className="flex-1 rounded-md border border-[#D4D2CA] bg-white px-2.5 py-1.5 text-xs text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
                      />
                      <input
                        type="number"
                        min={70}
                        max={100}
                        value={draftTempo}
                        onChange={(e) => setDraftTempo(Number(e.target.value))}
                        className="w-18 font-mono rounded-md border border-[#D4D2CA] bg-white px-2 py-1.5 text-xs text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[#57554F]">
                      Lyric Lines ({draftLines.length} lines, max {settings.max_words_per_line}w)
                    </span>
                    <button
                      type="button"
                      onClick={() => setDraftLines((prev) => [...prev, ""])}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#1B3B6F] hover:underline"
                    >
                      <Plus className="h-3 w-3" />
                      Add line
                    </button>
                  </div>

                  {draftLines.map((line, idx) => {
                    const wc = countLineWords(line);
                    const isOk = wc >= 1 && wc <= settings.max_words_per_line;
                    return (
                      <div key={idx} className="flex items-center gap-2">
                        <span
                          className={`w-12 font-mono text-[10px] tabular-nums ${
                            isOk ? "text-[#706E67]" : "font-bold text-[#DC2626]"
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
                        {draftLines.length > settings.lines_per_song && (
                          <button
                            type="button"
                            onClick={() =>
                              setDraftLines((prev) => prev.filter((_, i) => i !== idx))
                            }
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
                  <div className="rounded-md border border-[#FCA5A5] bg-[#FEF2F2] p-2 text-xs text-[#991B1B]">
                    {draftLyricCheck.errors.join("; ")}
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="rounded-md border border-[#D4D2CA] bg-white px-3 py-1.5 text-xs font-semibold text-[#57554F]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving}
                    className="inline-flex items-center gap-1 rounded-md bg-[#1B3B6F] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#152E57]"
                  >
                    {saving ? "Saving…" : "Save & Update History"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Side: Action Buttons Column */}
        <div className="flex shrink-0 flex-row flex-wrap items-center gap-2 sm:flex-col sm:items-end">
          {/* Approve Lyric button if in draft */}
          {song.status === "draft" && (
            <button
              type="button"
              onClick={() => void onApproveLyric(song.id).catch(() => undefined)}
              disabled={!savedLyricCheck.valid}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#15803D] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#166534] disabled:opacity-50 whitespace-nowrap"
            >
              <Check className="h-3.5 w-3.5" />
              Approve Lyric
            </button>
          )}

          {/* Generate Audio button */}
          <button
            type="button"
            onClick={() => onGenerate(song.number)}
            disabled={!canGenerate || isBusy || isBatchRunning || !savedLyricCheck.valid}
            title={
              !canGenerate
                ? "Lyrics must be approved before generating audio."
                : !savedLyricCheck.valid
                ? "Fix lyric rule warnings before generating."
                : undefined
            }
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap ${
              song.status === "approved" || song.status === "ready"
                ? "border border-[#D4D2CA] bg-white text-[#141413] hover:border-[#1B3B6F] hover:text-[#1B3B6F]"
                : "bg-[#1B3B6F] text-white hover:bg-[#152E57]"
            }`}
          >
            {isBusy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Generating…
              </>
            ) : song.status === "approved" || song.status === "ready" ? (
              <>
                <RotateCcw className="h-3.5 w-3.5" />
                Generate Take
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                Generate Audio
              </>
            )}
          </button>

          {/* Secondary actions: Edit lyric, Download, History, Archive */}
          <div className="flex items-center gap-1.5">
            {!editing && (
              <button
                type="button"
                onClick={startEdit}
                disabled={isBusy}
                className="rounded-md border border-[#D4D2CA] bg-white p-1.5 text-[#57554F] hover:border-[#1B3B6F] hover:text-[#1B3B6F]"
                title="Edit lyrics"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}

            {hasAudio && (
              <button
                type="button"
                onClick={() => onDownloadSingle(song)}
                className="rounded-md border border-[#D4D2CA] bg-white p-1.5 text-[#57554F] hover:border-[#1B3B6F] hover:text-[#1B3B6F]"
                title="Download best take WAV"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
            )}

            <button
              type="button"
              onClick={() => onViewHistory?.(song.number)}
              className="rounded-md border border-[#D4D2CA] bg-white p-1.5 text-[#57554F] hover:border-[#1B3B6F] hover:text-[#1B3B6F]"
              title="View lyric history"
            >
              <History className="h-3.5 w-3.5" />
            </button>

            <button
              type="button"
              onClick={() => void onToggleArchive(song.id, !song.archived).catch(() => undefined)}
              className="rounded-md border border-[#D4D2CA] bg-white p-1.5 text-[#57554F] hover:border-[#DC2626] hover:text-[#DC2626]"
              title={song.archived ? "Restore from archive" : "Archive song"}
            >
              {song.archived ? (
                <ArchiveRestore className="h-3.5 w-3.5" />
              ) : (
                <Archive className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
