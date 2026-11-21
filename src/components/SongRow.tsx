import { useState } from "react";
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
} from "lucide-react";
import { countArabicWords, type SongState } from "../data/songs";

interface SongRowProps {
  song: SongState;
  isPlaying: boolean;
  isActiveTrack: boolean;
  currentTime: number;
  duration: number;
  isBatchRunning: boolean;
  onTogglePlay: (song: SongState) => void;
  onSeek: (time: number) => void;
  onGenerate: (songNumber: number) => void;
  onSaveEdit: (
    songNumber: number,
    updates: {
      title: string;
      lines: [string, string, string, string];
      mood: string;
      tempo_bpm: number;
      instruments: string;
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
  currentTime,
  duration,
  isBatchRunning,
  onTogglePlay,
  onSeek,
  onGenerate,
  onSaveEdit,
}: SongRowProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftTitle, setDraftTitle] = useState(song.title);
  const [draftLines, setDraftLines] = useState<[string, string, string, string]>(song.lines);
  const [draftMood, setDraftMood] = useState(song.mood);
  const [draftTempo, setDraftTempo] = useState(song.tempo_bpm);
  const [draftInstruments, setDraftInstruments] = useState(song.instruments);

  const startEdit = () => {
    setDraftTitle(song.title);
    setDraftLines([...song.lines] as [string, string, string, string]);
    setDraftMood(song.mood);
    setDraftTempo(song.tempo_bpm);
    setDraftInstruments(song.instruments);
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSaveEdit(song.number, {
        title: draftTitle,
        lines: draftLines,
        mood: draftMood,
        tempo_bpm: Math.min(100, Math.max(70, Number(draftTempo) || 80)),
        instruments: draftInstruments,
      });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const trackDuration = isActiveTrack && duration > 0 ? duration : song.duration_seconds || 0;
  const trackProgress = isActiveTrack && trackDuration > 0 ? (currentTime / trackDuration) * 100 : 0;
  const paddedNumber = String(song.number).padStart(2, "0");

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
              disabled={song.status !== "ready" || !song.audio_url}
              aria-label={isPlaying ? `Pause ${song.feeling_key}` : `Play ${song.feeling_key}`}
              className={`flex h-10 w-10 items-center justify-center rounded-lg border transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1B3B6F] ${
                song.status === "ready"
                  ? isPlaying
                    ? "border-[#1B3B6F] bg-[#1B3B6F] text-white"
                    : "border-[#D4D2CA] bg-white text-[#141413] hover:border-[#1B3B6F] hover:text-[#1B3B6F]"
                  : "cursor-not-allowed border-[#ECEBE6] bg-[#F8F8F6] text-[#B5B2A9]"
              }`}
            >
              {song.status === "generating" ? (
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
                {song.status === "pending" && (
                  <span className="text-[#6E6C66]">Pending review</span>
                )}
                {song.status === "generating" && (
                  <span className="inline-flex items-center gap-1.5 font-medium text-[#1B3B6F]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Generating &amp; mastering…
                  </span>
                )}
                {song.status === "ready" && (
                  <span className="inline-flex items-center gap-1.5 font-medium text-[#15803D] tabular-nums">
                    <Check className="h-3.5 w-3.5" />
                    Ready · {song.duration_seconds?.toFixed(1)}s · {song.lufs?.toFixed(1) ?? "-14.0"} LUFS
                  </span>
                )}
                {song.status === "error" && (
                  <span className="inline-flex items-center gap-1.5 font-medium text-[#B91C1C]">
                    <AlertCircle className="h-3.5 w-3.5" />
                    Generation failed
                  </span>
                )}
              </div>
            </div>

            {/* Clean unboxed metadata row */}
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-[#57554F]">
              <span>{song.theme}</span>
              <span aria-hidden="true">·</span>
              <span>{song.mood}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-xs tabular-nums">{song.tempo_bpm} BPM</span>
              <span aria-hidden="true">·</span>
              <span className="text-[#706E67]">{song.instruments}</span>
            </p>

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
                  const wc = countArabicWords(line);
                  const wcOk = wc >= 4 && wc <= 7;
                  return (
                    <div
                      key={index}
                      className="flex items-baseline justify-between gap-4"
                    >
                      <span
                        className={`font-mono text-[11px] tabular-nums ${
                          wcOk ? "text-[#8A877F]" : "font-medium text-[#B45309]"
                        }`}
                      >
                        L{index + 1} · {wc}w
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
                  <div className="grid grid-cols-2 gap-2">
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
                        Tempo (70–100 BPM)
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
                  <span className="block text-xs font-medium text-[#57554F]">
                    4 Moroccan Darija Lines (4–7 words per line)
                  </span>
                  {draftLines.map((line, idx) => {
                    const wc = countArabicWords(line);
                    return (
                      <div key={idx} className="flex items-center gap-2">
                        <span
                          className={`w-12 shrink-0 font-mono text-[11px] tabular-nums ${
                            wc >= 4 && wc <= 7 ? "text-[#6E6C66]" : "font-semibold text-[#B45309]"
                          }`}
                        >
                          L{idx + 1}: {wc}w
                        </span>
                        <input
                          type="text"
                          dir="rtl"
                          value={line}
                          onChange={(e) => {
                            const next = [...draftLines] as [string, string, string, string];
                            next[idx] = e.target.value;
                            setDraftLines(next);
                          }}
                          className="font-arabic w-full rounded-md border border-[#D4D2CA] bg-white px-3 py-1.5 text-sm text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
                        />
                      </div>
                    );
                  })}
                </div>

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
                disabled={song.status === "generating"}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#D4D2CA] bg-white px-3 py-2 text-xs font-medium text-[#3F3E39] transition-colors hover:border-[#A8A59B] hover:text-[#141413] disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit lyric
              </button>
            )}

            <button
              type="button"
              onClick={() => onGenerate(song.number)}
              disabled={song.status === "generating" || isBatchRunning}
              className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-2 text-xs font-medium transition-colors disabled:opacity-50 whitespace-nowrap shrink-0 ${
                song.status === "ready"
                  ? "border border-[#D4D2CA] bg-white text-[#141413] hover:border-[#1B3B6F] hover:text-[#1B3B6F]"
                  : "bg-[#1B3B6F] text-white hover:bg-[#152E57]"
              }`}
            >
              {song.status === "generating" ? (
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

          {song.status === "ready" && song.audio_url && (
            <a
              href={song.audio_url}
              download={song.file_name}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#D4D2CA] bg-[#FAF9F6] px-3 py-1.5 font-mono text-[11px] font-medium text-[#3F3E39] transition-colors hover:border-[#1B3B6F] hover:text-[#1B3B6F] whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" />
              Download WAV
            </a>
          )}
        </div>
      </div>
    </article>
  );
}
