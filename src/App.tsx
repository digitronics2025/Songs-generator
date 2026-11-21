import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Search,
  SkipBack,
  SkipForward,
  Sparkles,
  Square,
} from "lucide-react";
import { SongRow } from "./components/SongRow";
import type { SongState, SongsJsonEntry } from "./data/songs";

type FilterMode = "all" | "ready" | "pending" | "error";
type ActiveTab = "studio" | "export" | "rules";
type LyriaModel = "lyria-3-pro-preview" | "lyria-3-clip-preview";

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function App() {
  const [songs, setSongs] = useState<SongState[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("studio");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [model, setModel] = useState<LyriaModel>("lyria-3-pro-preview");

  // Batch queue state
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [batchCurrentNumber, setBatchCurrentNumber] = useState<number | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });
  const cancelBatchRef = useRef(false);

  // Audio player state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [activeSongNumber, setActiveSongNumber] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [downloadingZip, setDownloadingZip] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetch("/api/songs")
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to load songs");
        return (await res.json()) as { songs: SongState[] };
      })
      .then((data) => {
        if (mounted) {
          setSongs(data.songs);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (mounted) {
          setGlobalError(err instanceof Error ? err.message : "Failed to load studio state");
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  const readySongs = useMemo(() => songs.filter((s) => s.status === "ready"), [songs]);
  const pendingSongs = useMemo(
    () => songs.filter((s) => s.status === "pending" || s.status === "error"),
    [songs]
  );
  const errorSongs = useMemo(() => songs.filter((s) => s.status === "error"), [songs]);

  const filteredSongs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return songs.filter((song) => {
      if (filter === "ready" && song.status !== "ready") return false;
      if (filter === "pending" && song.status !== "pending") return false;
      if (filter === "error" && song.status !== "error") return false;
      if (!q) return true;
      return (
        song.feeling_key.toLowerCase().includes(q) ||
        song.title.includes(q) ||
        song.theme.toLowerCase().includes(q) ||
        song.mood.toLowerCase().includes(q) ||
        song.lines.some((l) => l.includes(q))
      );
    });
  }, [songs, filter, searchQuery]);

  const activeSong = useMemo(
    () => songs.find((s) => s.number === activeSongNumber) || null,
    [songs, activeSongNumber]
  );

  const manifestPreview = useMemo<SongsJsonEntry[]>(() => {
    return songs.map((s) => ({
      number: s.number,
      feeling_key: s.feeling_key,
      title: s.title,
      theme: s.theme,
      lyric: s.lines.join(" / "),
      duration_seconds: s.duration_seconds ?? 0,
      mood: s.mood,
      tempo_bpm: s.tempo_bpm,
    }));
  }, [songs]);

  // Audio element handlers
  const handleTogglePlay = (song: SongState) => {
    if (song.status !== "ready" || !song.audio_url) return;
    const audio = audioRef.current;
    if (!audio) return;

    if (activeSongNumber === song.number) {
      if (audio.paused) {
        void audio.play();
      } else {
        audio.pause();
      }
      return;
    }

    setActiveSongNumber(song.number);
    setCurrentTime(0);
    setDuration(song.duration_seconds || 0);
    audio.src = song.audio_url;
    audio.load();
    void audio.play();
  };

  const handleSeek = (time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = time;
    setCurrentTime(time);
  };

  const playAdjacentReady = (dir: -1 | 1) => {
    if (readySongs.length === 0) return;
    const currentIdx = readySongs.findIndex((s) => s.number === activeSongNumber);
    const nextIdx =
      currentIdx === -1
        ? 0
        : (currentIdx + dir + readySongs.length) % readySongs.length;
    handleTogglePlay(readySongs[nextIdx]);
  };

  const generateSingleSong = async (songNumber: number): Promise<boolean> => {
    setGlobalError(null);
    setSongs((prev) =>
      prev.map((s) =>
        s.number === songNumber ? { ...s, status: "generating", error_message: null } : s
      )
    );

    try {
      const res = await fetch(`/api/songs/${songNumber}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const data = (await res.json()) as { song?: SongState; error?: string };
      if (!res.ok) {
        const msg = data.error || `Generation failed (HTTP ${res.status})`;
        setSongs((prev) =>
          prev.map((s) =>
            s.number === songNumber
              ? data.song || { ...s, status: "error", error_message: msg }
              : s
          )
        );
        if (res.status === 403 || res.status === 429) {
          setGlobalError(msg);
        }
        return false;
      }
      if (data.song) {
        setSongs((prev) =>
          prev.map((s) => (s.number === songNumber ? data.song! : s))
        );
      }
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error generating song";
      setSongs((prev) =>
        prev.map((s) =>
          s.number === songNumber ? { ...s, status: "error", error_message: msg } : s
        )
      );
      return false;
    }
  };

  const handleGenerateBatch = async (onlyPending: boolean) => {
    const targets = onlyPending ? pendingSongs : songs;
    if (targets.length === 0 || isBatchRunning) return;

    cancelBatchRef.current = false;
    setIsBatchRunning(true);
    setGlobalError(null);
    setBatchProgress({ done: 0, total: targets.length });

    let completed = 0;
    for (const target of targets) {
      if (cancelBatchRef.current) break;
      setBatchCurrentNumber(target.number);
      await generateSingleSong(target.number);
      completed += 1;
      setBatchProgress({ done: completed, total: targets.length });
    }

    setBatchCurrentNumber(null);
    setIsBatchRunning(false);
  };

  const handleStopBatch = () => {
    cancelBatchRef.current = true;
  };

  const handleSaveEdit = async (
    songNumber: number,
    updates: {
      title: string;
      lines: [string, string, string, string];
      mood: string;
      tempo_bpm: number;
      instruments: string;
    }
  ) => {
    const res = await fetch(`/api/songs/${songNumber}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    const data = (await res.json()) as { song?: SongState; error?: string };
    if (!res.ok) {
      setGlobalError(data.error || "Failed to save lyric changes");
      return;
    }
    if (data.song) {
      setSongs((prev) => prev.map((s) => (s.number === songNumber ? data.song! : s)));
    }
  };

  const handleResetLyrics = async () => {
    if (isBatchRunning) return;
    const res = await fetch("/api/songs/reset-lyrics", { method: "POST" });
    if (res.ok) {
      const data = (await res.json()) as { songs: SongState[] };
      setSongs(data.songs);
    }
  };

  const handleDownloadAll = async () => {
    if (readySongs.length === 0 || downloadingZip) return;
    setDownloadingZip(true);
    setGlobalError(null);
    try {
      const res = await fetch("/api/download-all");
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || "Failed to generate ZIP archive");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "darija-family-songs-pack.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "Failed to download ZIP");
    } finally {
      setDownloadingZip(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F8F8F6] text-[#141413]">
      {/* Hidden shared HTML5 audio element */}
      <audio
        ref={audioRef}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          setCurrentTime(0);
        }}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          if (Number.isFinite(e.currentTarget.duration)) {
            setDuration(e.currentTarget.duration);
          }
        }}
      />

      {/* Top Navigation Bar — strict 3-zone contract */}
      <header className="sticky top-0 z-30 border-b border-[#E5E4DF] bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-8 px-6 py-3.5">
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab("studio");
            }}
            className="text-lg font-bold tracking-tight text-[#141413] whitespace-nowrap shrink-0"
          >
            Darija Reel Studio
          </a>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-[#57554F]">
            <button
              type="button"
              onClick={() => setActiveTab("studio")}
              className={`border-b-2 py-1 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === "studio"
                  ? "border-[#1B3B6F] text-[#141413]"
                  : "border-transparent hover:text-[#141413]"
              }`}
            >
              20 Songs &amp; Lyrics
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("export")}
              className={`border-b-2 py-1 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === "export"
                  ? "border-[#1B3B6F] text-[#141413]"
                  : "border-transparent hover:text-[#141413]"
              }`}
            >
              songs.json &amp; Files
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("rules")}
              className={`border-b-2 py-1 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === "rules"
                  ? "border-[#1B3B6F] text-[#141413]"
                  : "border-transparent hover:text-[#141413]"
              }`}
            >
              Vocal &amp; Master Spec
            </button>
          </nav>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={handleDownloadAll}
              disabled={readySongs.length === 0 || downloadingZip}
              className="inline-flex items-center gap-2 rounded-lg bg-[#1B3B6F] px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#152E57] disabled:cursor-not-allowed disabled:bg-[#D4D2CA] disabled:text-[#6E6C66] whitespace-nowrap shrink-0"
            >
              {downloadingZip ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Archive className="h-3.5 w-3.5" />
              )}
              <span>
                {downloadingZip
                  ? "Packaging ZIP…"
                  : `Download all (${readySongs.length}/20)`}
              </span>
            </button>
          </div>
        </div>
      </header>

      <main id="top" className="mx-auto max-w-[1200px] px-6 pb-28 pt-8">
        {/* Mobile Tab Switcher */}
        <div className="mb-6 flex gap-2 border-b border-[#E5E4DF] pb-3 md:hidden">
          {(
            [
              ["studio", "20 Songs & Lyrics"],
              ["export", "songs.json & Files"],
              ["rules", "Vocal & Master Spec"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 ${
                activeTab === id
                  ? "bg-[#1B3B6F] text-white"
                  : "bg-white text-[#57554F] border border-[#E5E4DF]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Hero / Editorial Overview */}
        <section className="mb-8 border-b border-[#E5E4DF] pb-7">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <p className="text-xs font-medium tracking-wide text-[#1B3B6F]">
                Step 1: Review Darija lyrics · Step 2: Generate with Lyria · Step 3: Download WAV + songs.json ZIP
              </p>
              <h1
                style={{ textWrap: "balance" }}
                className="mt-2 text-3xl font-bold tracking-tight text-[#141413] sm:text-4xl"
              >
                20 Moroccan Darija Family Songs for Reels &amp; Shorts
              </h1>
              <p className="mt-2.5 text-[15px] leading-relaxed text-[#57554F]">
                Each track features four everyday Moroccan Darija lines (4–7 words each), a single dry solo voice, warm acoustic oud, qanun, guitar or piano at 70–100 BPM, and a 4–5 second instrumental outro mastered to -14 LUFS in 44.1 kHz WAV.
              </p>
            </div>

            {/* Clean unboxed summary stats */}
            <div className="grid grid-cols-3 gap-6 border-t border-[#E5E4DF] pt-4 lg:border-t-0 lg:border-l lg:pl-8 lg:pt-0">
              <div>
                <div className="font-mono text-2xl font-semibold text-[#141413] tabular-nums">
                  {readySongs.length}
                  <span className="text-sm font-normal text-[#706E67]">/20</span>
                </div>
                <div className="mt-0.5 text-xs text-[#6E6C66]">Mastered WAVs</div>
              </div>
              <div>
                <div className="font-mono text-2xl font-semibold text-[#141413] tabular-nums">
                  44.1<span className="text-sm font-normal text-[#706E67]">kHz</span>
                </div>
                <div className="mt-0.5 text-xs text-[#6E6C66]">16-bit PCM Stereo</div>
              </div>
              <div>
                <div className="font-mono text-2xl font-semibold text-[#141413] tabular-nums">
                  -14<span className="text-sm font-normal text-[#706E67]"> LUFS</span>
                </div>
                <div className="mt-0.5 text-xs text-[#6E6C66]">Max peak -1.0 dB</div>
              </div>
            </div>
          </div>
        </section>

        {globalError && (
          <div className="mb-6 flex items-start justify-between gap-4 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-4 py-3 text-sm text-[#991B1B]">
            <div>
              <span className="font-semibold">Audio generation notice: </span>
              {globalError}
            </div>
            <button
              type="button"
              onClick={() => setGlobalError(null)}
              className="text-xs font-medium underline whitespace-nowrap shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        {activeTab === "studio" && (
          <>
            {/* Workspace Control Bar */}
            <div className="mb-5 flex flex-col gap-3 rounded-xl border border-[#E5E4DF] bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2.5">
                  {!isBatchRunning ? (
                    <>
                      <button
                        type="button"
                        onClick={() => handleGenerateBatch(pendingSongs.length > 0 && readySongs.length > 0)}
                        disabled={loading || songs.length === 0}
                        className="inline-flex items-center gap-2 rounded-lg bg-[#1B3B6F] px-4 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-[#152E57] disabled:opacity-50 whitespace-nowrap shrink-0"
                      >
                        <Sparkles className="h-4 w-4" />
                        {readySongs.length === 20
                          ? "Regenerate all 20 songs"
                          : readySongs.length > 0
                          ? `Generate remaining (${pendingSongs.length})`
                          : "Confirm lyrics & generate all 20"}
                      </button>

                      {readySongs.length > 0 && readySongs.length < 20 && (
                        <button
                          type="button"
                          onClick={() => handleGenerateBatch(false)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-[#D4D2CA] bg-white px-3.5 py-2.5 text-xs font-medium text-[#3F3E39] hover:border-[#1B3B6F] hover:text-[#1B3B6F] whitespace-nowrap shrink-0"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          Regenerate all 20
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={handleStopBatch}
                      className="inline-flex items-center gap-2 rounded-lg border border-[#DC2626] bg-[#FEF2F2] px-4 py-2.5 text-xs font-semibold text-[#B91C1C] hover:bg-[#FEE2E2] whitespace-nowrap shrink-0"
                    >
                      <Square className="h-3.5 w-3.5 fill-current" />
                      Stop batch after current track ({batchProgress.done}/{batchProgress.total})
                    </button>
                  )}

                  {/* Lyria Model Selector */}
                  <div className="flex items-center rounded-lg bg-[#F3F2EE] p-1">
                    <button
                      type="button"
                      disabled={isBatchRunning}
                      onClick={() => setModel("lyria-3-pro-preview")}
                      className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        model === "lyria-3-pro-preview"
                          ? "bg-white text-[#141413] shadow-xs"
                          : "text-[#57554F] hover:text-[#141413]"
                      }`}
                    >
                      Lyria Pro (35–42s)
                    </button>
                    <button
                      type="button"
                      disabled={isBatchRunning}
                      onClick={() => setModel("lyria-3-clip-preview")}
                      className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        model === "lyria-3-clip-preview"
                          ? "bg-white text-[#141413] shadow-xs"
                          : "text-[#57554F] hover:text-[#141413]"
                      }`}
                    >
                      Lyria Clip (30s)
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={handleResetLyrics}
                    disabled={isBatchRunning}
                    className="rounded-md px-2.5 py-1.5 text-xs font-medium text-[#6E6C66] hover:text-[#141413] disabled:opacity-40 whitespace-nowrap shrink-0"
                  >
                    Reset default lyrics
                  </button>
                </div>
              </div>

              {/* Batch Progress Bar */}
              {isBatchRunning && (
                <div className="border-t border-[#ECEBE6] pt-3">
                  <div className="mb-1.5 flex items-center justify-between text-xs">
                    <span className="font-medium text-[#1B3B6F]">
                      {batchCurrentNumber
                        ? `Generating track #${String(batchCurrentNumber).padStart(2, "0")}…`
                        : "Preparing next track…"}
                    </span>
                    <span className="font-mono text-[#57554F] tabular-nums">
                      {batchProgress.done} / {batchProgress.total} completed
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#ECEBE6]">
                    <div
                      className="h-full bg-[#1B3B6F] transition-all duration-300"
                      style={{
                        width: `${
                          batchProgress.total > 0
                            ? Math.max(4, (batchProgress.done / batchProgress.total) * 100)
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Filter Tabs + Search */}
              <div className="flex flex-col gap-3 border-t border-[#ECEBE6] pt-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-1 rounded-lg bg-[#F3F2EE] p-1">
                  {(
                    [
                      ["all", `All (${songs.length})`],
                      ["ready", `Ready (${readySongs.length})`],
                      ["pending", `Pending (${songs.filter((s) => s.status === "pending").length})`],
                      ["error", `Errors (${errorSongs.length})`],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setFilter(key)}
                      className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        filter === key
                          ? "bg-white text-[#141413] shadow-xs"
                          : "text-[#57554F] hover:text-[#141413]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="relative w-full sm:w-72">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#706E67]" />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter by feeling, Arabic title, or mood…"
                    className="w-full rounded-lg border border-[#DCDAD2] bg-[#FAF9F6] py-1.5 pl-8 pr-3 text-xs text-[#141413] placeholder:text-[#8A877F] focus:border-[#1B3B6F] focus:bg-white focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* 20-Song List */}
            <div className="overflow-hidden rounded-xl border border-[#E5E4DF] bg-white">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-[#6E6C66]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading 20 Moroccan Darija songs…
                </div>
              ) : filteredSongs.length === 0 ? (
                <div className="py-16 text-center text-sm text-[#6E6C66]">
                  No songs match the current filter.
                </div>
              ) : (
                filteredSongs.map((song) => (
                  <SongRow
                    key={song.number}
                    song={song}
                    isPlaying={isPlaying && activeSongNumber === song.number}
                    isActiveTrack={activeSongNumber === song.number}
                    currentTime={currentTime}
                    duration={duration}
                    isBatchRunning={isBatchRunning}
                    onTogglePlay={handleTogglePlay}
                    onSeek={handleSeek}
                    onGenerate={generateSingleSong}
                    onSaveEdit={handleSaveEdit}
                  />
                ))
              )}
            </div>
          </>
        )}

        {activeTab === "export" && (
          <section className="space-y-6">
            <div className="rounded-xl border border-[#E5E4DF] bg-white p-6">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#ECEBE6] pb-4">
                <div>
                  <h2 className="text-lg font-semibold text-[#141413]">
                    ZIP Export Manifest (songs.json + 20 WAV files)
                  </h2>
                  <p className="mt-1 text-sm text-[#57554F]">
                    Included in <span className="font-mono text-xs">darija-family-songs-pack.zip</span> alongside all generated <span className="font-mono text-xs">01-…</span> to <span className="font-mono text-xs">20-…</span> 44.1 kHz WAV files.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleDownloadAll}
                  disabled={readySongs.length === 0 || downloadingZip}
                  className="inline-flex items-center gap-2 rounded-lg bg-[#1B3B6F] px-4 py-2 text-xs font-semibold text-white hover:bg-[#152E57] disabled:bg-[#D4D2CA] disabled:text-[#6E6C66] whitespace-nowrap shrink-0"
                >
                  <Archive className="h-4 w-4" />
                  Download ZIP ({readySongs.length}/20 WAVs ready)
                </button>
              </div>

              <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {songs.map((s) => (
                  <div
                    key={s.number}
                    className="flex items-center justify-between rounded-lg border border-[#ECEBE6] bg-[#FAF9F6] px-3 py-2 text-xs"
                  >
                    <span className="truncate font-mono text-[#141413]">{s.file_name}</span>
                    {s.status === "ready" ? (
                      <span className="ml-2 inline-flex items-center gap-1 font-medium text-[#15803D] shrink-0">
                        <Check className="h-3 w-3" />
                        {s.duration_seconds}s
                      </span>
                    ) : (
                      <span className="ml-2 text-[#8A877F] shrink-0">Pending</span>
                    )}
                  </div>
                ))}
              </div>

              <div className="mt-6">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-[#57554F]">
                    Live songs.json preview
                  </span>
                  <a
                    href="/api/songs.json"
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs text-[#1B3B6F] hover:underline"
                  >
                    Open raw /api/songs.json
                  </a>
                </div>
                <pre
                  dir="ltr"
                  className="max-h-[460px] overflow-auto rounded-lg border border-[#E5E4DF] bg-[#141413] p-4 font-mono text-xs leading-relaxed text-[#E7E5DF]"
                >
                  {JSON.stringify(manifestPreview, null, 2)}
                </pre>
              </div>
            </div>
          </section>
        )}

        {activeTab === "rules" && (
          <section className="grid gap-6 md:grid-cols-2">
            <div className="rounded-xl border border-[#E5E4DF] bg-white p-6">
              <h2 className="text-base font-semibold text-[#141413]">
                Moroccan Darija Lyric Standards
              </h2>
              <ul className="mt-4 space-y-2.5 text-sm leading-relaxed text-[#57554F]">
                <li>Everyday Moroccan Darija written in Arabic script only—no Modern Standard Arabic poetry, French, or English.</li>
                <li>Exactly 4 short lines per song, 4–7 words per line, verified live in the lyric editor.</li>
                <li>Each song title matches the opening words of Line 1.</li>
                <li>Warm and family-centered: hard moments resolve with hope, with zero brand names, prices, or religious chants.</li>
              </ul>
            </div>

            <div className="rounded-xl border border-[#E5E4DF] bg-white p-6">
              <h2 className="text-base font-semibold text-[#141413]">
                Vocal &amp; Broadcast Mastering Pipeline
              </h2>
              <ul className="mt-4 space-y-2.5 text-sm leading-relaxed text-[#57554F]">
                <li>Single clear solo lead voice sung slowly, upfront in the mix with softer acoustic accompaniment (no heavy echo, autotune, choir, or rap).</li>
                <li>Acoustic Moroccan instrumentation: oud, qanun, soft darbuka, nylon guitar, or felt piano at 70–100 BPM.</li>
                <li>30–45 second structure ending with 4–5 seconds of soft instrumental music for spoken tag-ons.</li>
                <li>Server-side two-pass EBU R128 mastering via FFmpeg: ~-14 LUFS integrated loudness, true peaks capped at -1.0 dBTP, exported as 44.1 kHz 16-bit PCM WAV.</li>
              </ul>
            </div>
          </section>
        )}
      </main>

      {/* Sticky Mini Player Bar when an audio track is active */}
      {activeSong && activeSong.status === "ready" && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[#DCDAD2] bg-white/95 backdrop-blur-md">
          <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-4 px-6 py-2.5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="font-mono text-xs font-medium text-[#706E67] tabular-nums">
                {String(activeSong.number).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                <div
                  dir="rtl"
                  className="font-arabic truncate text-sm font-semibold text-[#141413]"
                >
                  {activeSong.title}
                </div>
                <div className="truncate font-mono text-[11px] text-[#6E6C66]">
                  {activeSong.file_name}
                </div>
              </div>
            </div>

            <div className="flex flex-1 items-center justify-center gap-3 max-w-md">
              <button
                type="button"
                onClick={() => playAdjacentReady(-1)}
                aria-label="Previous track"
                className="rounded-md p-1.5 text-[#57554F] hover:bg-[#F3F2EE] hover:text-[#141413]"
              >
                <SkipBack className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => handleTogglePlay(activeSong)}
                aria-label={isPlaying ? "Pause" : "Play"}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-[#1B3B6F] text-white hover:bg-[#152E57]"
              >
                {isPlaying ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4 translate-x-0.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => playAdjacentReady(1)}
                aria-label="Next track"
                className="rounded-md p-1.5 text-[#57554F] hover:bg-[#F3F2EE] hover:text-[#141413]"
              >
                <SkipForward className="h-4 w-4" />
              </button>

              <div className="hidden sm:flex flex-1 items-center gap-2">
                <span className="w-8 font-mono text-[11px] text-[#6E6C66] tabular-nums">
                  {formatClock(currentTime)}
                </span>
                <input
                  type="range"
                  min={0}
                  max={duration || activeSong.duration_seconds || 40}
                  step={0.1}
                  value={currentTime}
                  onChange={(e) => handleSeek(Number(e.target.value))}
                  aria-label="Global track scrubber"
                  className="h-1.5 w-full cursor-pointer accent-[#1B3B6F]"
                />
                <span className="w-8 text-right font-mono text-[11px] text-[#6E6C66] tabular-nums">
                  {formatClock(duration || activeSong.duration_seconds || 0)}
                </span>
              </div>
            </div>

            <div className="hidden md:block font-mono text-[11px] text-[#6E6C66] tabular-nums whitespace-nowrap shrink-0">
              {activeSong.tempo_bpm} BPM · {activeSong.lufs?.toFixed(1) ?? "-14.0"} LUFS
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
