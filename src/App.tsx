import { useMemo, useRef, useState } from "react";
import {
  Archive,
  Download,
  Loader2,
  LogIn,
  LogOut,
  Pause,
  Play,
  Search,
  SkipBack,
  SkipForward,
  Sparkles,
  Wrench,
  Plus,
  Layers,
  History,
} from "lucide-react";
import { SongRow } from "./components/SongRow";
import { NewSongModal } from "./components/NewSongModal";
import { BatchGeneratorModal } from "./components/BatchGeneratorModal";
import { SettingsView } from "./components/SettingsView";
import { SongHistoryDrawer } from "./components/SongHistoryDrawer";
import {
  formatSongFilename,
  type SongState,
  type SongsJsonEntry,
} from "./data/songs";
import { checkRhyme, validateLyrics } from "./lib/lyricQuality";
import { ApiError, songPath, studioApi, studioAudio } from "./lib/api";
import { countStatuses, filterStatus, type StatusFilter } from "./lib/catalogState";
import { useStudio } from "./hooks/useStudio";
import { useStudioAudio, saveBlob } from "./hooks/useStudioAudio";
import { useSongActions } from "./hooks/useSongActions";
import { StudioAdministration } from "./components/StudioAdministration";

type ActiveTab = "library" | "settings" | "export";
type DateFilter = "all" | "today" | "week" | "newest" | "oldest";

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function App() {
  const { user, authReady, authLoading, handleSignIn, handleSignOut, songs, historyItems, settings,
    loading, libraryLoaded, libraryError, globalError, setGlobalError, refresh } = useStudio();
  const { audioRef, activeSongNumber, isPlaying, currentTime, duration, setIsPlaying, setCurrentTime,
    setDuration, handleTogglePlay, handleSeek, handleDownloadSingle } = useStudioAudio(setGlobalError, Boolean(user));
  const { generatingNumbers, handleGenerateSong, handleAddNewSong, handleAddBatchSongs, handleApproveLyric,
    handleApproveTake, handleChooseTake, handleSaveEdit, handleChangeAdminFeeling, handleToggleArchive, handleSaveSettings } =
    useSongActions(songs, refresh, setGlobalError);

  // UI state
  const [activeTab, setActiveTab] = useState<ActiveTab>("library");
  const [rhymeFilter, setRhymeFilter] = useState("All");
  const [rhymeProgress, setRhymeProgress] = useState("");
  const [proposals, setProposals] = useState<Array<{id: string; title: string; before: string[]; lines: string[]}>>([]);
  const [applying, setApplying] = useState(false);

  async function fixRhymes(selected: SongState[]) {
    for (const [index, song] of selected.entries()) {
      setRhymeProgress(`Checking rhyme ${index + 1} of ${selected.length}`);
      try {
        const proposal = await studioApi<{before: string[]; lines: string[]}>(songPath(song.id) + "/rhyme-fix", "POST");
        setProposals(current => [...current.filter(p => p.id !== song.id), { ...proposal, id: song.id, title: song.title }]);
      } catch (error) {
        setGlobalError(error instanceof Error ? error.message : "Rhyme fix failed.");
        if (!(error instanceof ApiError) || error.status !== 422) break;
      }
    }
    setRhymeProgress("");
  }

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [feelingFilter, setFeelingFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Modals & Drawers
  const [isNewSongModalOpen, setIsNewSongModalOpen] = useState(false);
  const [isBatchModalOpen, setIsBatchModalOpen] = useState(false);
  const [isHistoryDrawerOpen, setIsHistoryDrawerOpen] = useState(false);
  const [historySongNumber, setHistorySongNumber] = useState<number | null>(null);

  // Multi-selection state
  const [selectedSongIds, setSelectedSongIds] = useState<Set<string>>(new Set());

  // Generation state
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });
  const cancelBatchRef = useRef(false);

  const [downloadingZip, setDownloadingZip] = useState(false);
  const [zipProgress, setZipProgress] = useState<string | null>(null);

  // Filtered and searched songs
  const filteredSongs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let result = songs.filter((song) => {
      // Archived filter
      if (statusFilter === "archived") {
        if (filterStatus(song) !== "archived") return false;
      } else {
        if (filterStatus(song) === "archived") return false;
        if (statusFilter !== "all" && filterStatus(song) !== statusFilter) return false;
      }

      if (settings.rhyme_scheme !== "OFF" && rhymeFilter !== "All" &&
          checkRhyme(song.lines, settings.rhyme_scheme).ok !== (rhymeFilter === "Rhymes")) return false;
      // Feeling filter
      if (feelingFilter !== "all" && song.admin_feeling !== feelingFilter) {
        return false;
      }

      // Date filter
      if (dateFilter === "today") {
        const todayStr = new Date().toISOString().slice(0, 10);
        if (!song.created_at.startsWith(todayStr)) return false;
      } else if (dateFilter === "week") {
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        if (new Date(song.created_at).getTime() < weekAgo) return false;
      }

      // Search query
      if (!q) return true;
      return (
        song.title.includes(q) ||
        song.feeling_key.toLowerCase().includes(q) ||
        song.admin_feeling.toLowerCase().includes(q) ||
        song.theme.toLowerCase().includes(q) ||
        song.mood.toLowerCase().includes(q) ||
        String(song.number) === q ||
        song.lines.some((l) => l.includes(q))
      );
    });

    if (dateFilter === "newest") {
      result = [...result].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    } else if (dateFilter === "oldest") {
      result = [...result].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
    }

    return result;
  }, [songs, settings.rhyme_scheme, rhymeFilter, statusFilter, feelingFilter, dateFilter, searchQuery]);

  const activeSongs = useMemo(() => songs.filter((song) => filterStatus(song) !== "archived"), [songs]);
  const statusCounts = useMemo(() => countStatuses(songs), [songs]);

  // Counts per feeling
  const feelingCounts = useMemo(() => {
    const counts: Record<string, number> = Object.create(null);
    for (const f of settings.feelings) {
      counts[f] = 0;
    }
    activeSongs.forEach((s) => {
      if (Object.hasOwn(counts, s.admin_feeling)) {
        counts[s.admin_feeling] += 1;
      } else {
        counts[s.admin_feeling] = 1;
      }
    });
    return counts;
  }, [activeSongs, settings.feelings]);

  const activeSong = useMemo(
    () => songs.find((s) => s.number === activeSongNumber) || null,
    [songs, activeSongNumber]
  );

  const manifestPreview = useMemo<SongsJsonEntry[]>(() => {
    return filteredSongs.map((s) => ({
      id: s.id,
      number: s.number,
      feeling_key: s.feeling_key,
      admin_feeling: s.admin_feeling,
      title: s.title,
      theme: s.theme,
      lyric: s.lines.join(" / "),
      duration_seconds: s.duration_seconds ?? 0,
      mood: s.mood,
      tempo_bpm: s.tempo_bpm,
      words_heard_pct: s.words_heard_pct ?? null,
      transcribed_text: s.transcribed_text ?? null,
      missing_words: s.missing_words ?? [],
      extra_words: s.extra_words ?? [],
      voice_start_seconds: s.voice_start_seconds ?? null,
      voice_end_seconds: s.voice_end_seconds ?? null,
    }));
  }, [filteredSongs]);

  const playAdjacentReady = (dir: -1 | 1) => {
    const readyList = filteredSongs.filter((s) => s.download_url || s.storage_path);
    if (readyList.length === 0) return;
    const currentIdx = readyList.findIndex((s) => s.number === activeSongNumber);
    const nextIdx =
      currentIdx === -1 ? 0 : (currentIdx + dir + readyList.length) % readyList.length;
    void handleTogglePlay(readyList[nextIdx]);
  };

  // Multi-selection handlers
  const handleToggleSelect = (songId: string) => {
    setSelectedSongIds((prev) => {
      const next = new Set(prev);
      if (next.has(songId)) next.delete(songId);
      else next.add(songId);
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedSongIds.size === filteredSongs.length) {
      setSelectedSongIds(new Set());
    } else {
      setSelectedSongIds(new Set(filteredSongs.map((s) => s.id)));
    }
  };

  // Multi-selection: Generate selected
  const handleGenerateSelected = async (repair = false) => {
    const selected = songs.filter(
      (s) =>
        !s.archived && (repair ? s.status === "failed" || s.status === "generating" : selectedSongIds.has(s.id)) &&
        (repair || s.status === "lyric_approved" || s.status === "ready" || s.status === "approved" || s.status === "failed") &&
        (repair || validateLyrics(s.lines, settings).valid)
    );

    if (selected.length === 0) {
      setGlobalError(repair ? "There are no failed songs to repair." : "Select songs with approved lyrics and no rule errors.");
      return;
    }

    cancelBatchRef.current = false;
    setIsBatchRunning(true);
    setBatchProgress({ done: 0, total: selected.length });

    let completed = 0;
    for (const target of selected) {
      if (cancelBatchRef.current) break;
      const res = await handleGenerateSong(target.number, repair);
      if (res.stopBatch) break;
      completed += 1;
      setBatchProgress({ done: completed, total: selected.length });
    }

    setIsBatchRunning(false);
  };


  const handleArchiveSelected = async () => {
    for (const id of selectedSongIds) {
      try { await handleToggleArchive(id, true); }
      catch { break; }
    }
    setSelectedSongIds(new Set());
  };

  // Export functions (Requirement 6)
  const handleExportZip = async (targetSongs: SongState[], zipTitle: string) => {
    const readyToExport = targetSongs.filter(
      (s) => (s.status === "ready" || s.status === "approved") && (s.storage_path || s.download_url)
    );

    if (readyToExport.length === 0) {
      setGlobalError("No ready or approved songs available with audio to export.");
      return;
    }

    setDownloadingZip(true);
    setZipProgress(`0/${readyToExport.length}`);
    setGlobalError(null);

    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();

      // Build songs.json manifest with new fields: id, admin_feeling, words_heard_pct
      const manifest = readyToExport.map((s) => ({
        id: s.id,
        number: s.number,
        feeling_key: s.feeling_key,
        admin_feeling: s.admin_feeling,
        title: s.title,
        theme: s.theme,
        lyric: s.lines.join(" / "),
        duration_seconds: s.duration_seconds ?? 30,
        mood: s.mood,
        tempo_bpm: s.tempo_bpm,
        words_heard_pct: s.words_heard_pct ?? null,
        transcribed_text: s.transcribed_text ?? null,
        missing_words: s.missing_words ?? [],
        extra_words: s.extra_words ?? [],
        voice_start_seconds: s.voice_start_seconds ?? null,
        voice_end_seconds: s.voice_end_seconds ?? null,
      }));

      zip.file("songs.json", JSON.stringify(manifest, null, 2), {
        compression: "DEFLATE",
      });

      let fetched = 0;
      const concurrency = 4;
      for (let i = 0; i < readyToExport.length; i += concurrency) {
        const chunk = readyToExport.slice(i, i + concurrency);
        await Promise.all(
          chunk.map(async (song) => {
            const wavBlob = await studioAudio(song.storage_path);
            const buf = await wavBlob.arrayBuffer();
            const fileName = song.file_name ?? formatSongFilename(song.number, song.feeling_key, "wav");
            zip.file(fileName, buf, { compression: "STORE" });
            fetched += 1;
            setZipProgress(`${fetched}/${readyToExport.length}`);
          })
        );
      }

      setZipProgress("Building ZIP…");
      const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      saveBlob(blob, zipTitle + ".zip");
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "Failed to package ZIP archive");
    } finally {
      setDownloadingZip(false);
      setZipProgress(null);
    }
  };

  const historyLabel = libraryLoaded ? "History (" + historyItems.length + ")" : "History";

  if (!authReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F8F8F6] text-sm text-[#57554F]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin text-[#1B3B6F]" />
        Initializing Darija Song Studio…
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-screen flex-col bg-[#F8F8F6] text-[#141413]">
        <header className="border-b border-[#E5E4DF] bg-white">
          <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-3 px-4 py-3.5 sm:gap-8 sm:px-6">
            <span className="text-lg font-bold tracking-tight text-[#141413]">
              Darija Song Studio
            </span>
            <button
              type="button"
              onClick={handleSignIn}
              disabled={authLoading}
              className="inline-flex items-center gap-2 rounded-lg bg-[#1B3B6F] px-4 py-2 text-xs font-semibold text-white hover:bg-[#152E57] disabled:opacity-60"
            >
              <LogIn className="h-3.5 w-3.5" />
              {authLoading ? "Signing in…" : "Sign in with Google"}
            </button>
          </div>
        </header>

        <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-16">
          <div className="rounded-xl border border-[#E5E4DF] bg-white p-8 shadow-sm">
            <p className="text-xs font-semibold text-[#1B3B6F]">
              Open-Ended Moroccan Darija Song Generator &amp; Library
            </p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-[#141413]">
              Sign in with Google to enter your studio
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-[#57554F]">
              Create custom Moroccan Darija songs, draft in batches with Gemini, master to broadcast -14 LUFS WAVs with Lyria, review multiple takes, and manage your permanent cloud library.
            </p>

            {globalError && (
              <div className="mt-4 rounded-lg border border-[#FECACA] bg-[#FEF2F2] p-3 text-xs text-[#991B1B]">
                {globalError}
              </div>
            )}

            <button
              type="button"
              onClick={handleSignIn}
              disabled={authLoading}
              className="mt-6 inline-flex items-center gap-2.5 rounded-lg bg-[#1B3B6F] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#152E57] disabled:opacity-60"
            >
              {authLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LogIn className="h-4 w-4" />
              )}
              Sign in with Google
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8F8F6] text-[#141413]">
      {/* Hidden shared HTML5 audio element */}
      <audio
        aria-label="Studio audio player"
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

      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-30 border-b border-[#E5E4DF] bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-2 px-4 py-3 sm:gap-6 sm:px-6">
          <div className="flex items-center gap-6">
            <a
              href="#top"
              onClick={(e) => {
                e.preventDefault();
                setActiveTab("library");
              }}
              className="text-base font-bold tracking-tight text-[#141413] sm:text-lg"
            >
              Darija Song Studio
            </a>

            <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-[#57554F]">
              <button
                type="button"
                onClick={() => setActiveTab("library")}
                className={`border-b-2 py-1 transition-colors whitespace-nowrap ${
                  activeTab === "library"
                    ? "border-[#1B3B6F] text-[#141413]"
                    : "border-transparent hover:text-[#141413]"
                }`}
              >
                Song Library{libraryLoaded && " (" + activeSongs.length + ")"}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("settings")}
                className={`border-b-2 py-1 transition-colors whitespace-nowrap ${
                  activeTab === "settings"
                    ? "border-[#1B3B6F] text-[#141413]"
                    : "border-transparent hover:text-[#141413]"
                }`}
              >
                Settings &amp; Rules
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("export")}
                className={`border-b-2 py-1 transition-colors whitespace-nowrap ${
                  activeTab === "export"
                    ? "border-[#1B3B6F] text-[#141413]"
                    : "border-transparent hover:text-[#141413]"
                }`}
              >
                Export Pack
              </button>
            </nav>
          </div>

          {/* Creation & Action Buttons */}
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2.5">
            <button
              type="button"
              onClick={() => setIsHistoryDrawerOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#D4D2CA] bg-white px-3 py-1.5 text-xs font-semibold text-[#57554F] hover:bg-[#F3F2EE]"
              title="View permanent lyric history"
              aria-label={historyLabel}
            >
              <History className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{historyLabel}</span>
            </button>

            <button
              type="button"
              onClick={() => setIsBatchModalOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#1B3B6F] bg-[#EFF6FF] px-3.5 py-1.5 text-xs font-semibold text-[#1B3B6F] hover:bg-[#DBEAFE]"
            >
              <Layers className="h-3.5 w-3.5" />
              <span>Batch</span>
            </button>

            <button
              type="button"
              onClick={() => setIsNewSongModalOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#1B3B6F] px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-[#152E57]"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New Song</span>
            </button>

            <button
              type="button"
              onClick={() => void handleSignOut().catch(() => setGlobalError("Could not sign out."))}
              className="rounded-lg p-1.5 text-[#706E67] hover:bg-[#F3F2EE] hover:text-[#141413]"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main id="top" className="mx-auto max-w-[1240px] px-6 pb-28 pt-6">
        {/* Mobile Tab Switcher */}
        <div className="mb-4 flex gap-2 border-b border-[#E5E4DF] pb-3 md:hidden">
          {(
            [
              ["library", libraryLoaded ? `Library (${activeSongs.length})` : "Library"],
              ["settings", "Settings"],
              ["export", "Export"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap ${
                activeTab === id
                  ? "bg-[#1B3B6F] text-white"
                  : "bg-white text-[#57554F] border border-[#E5E4DF]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Global Error Notice */}
        {globalError && (
          <div className="mb-5 flex items-start justify-between gap-4 rounded-lg border border-[#FECACA] bg-[#FEF2F2] p-3 text-xs text-[#991B1B]">
            <div>
              <span className="font-semibold">Notice: </span>
              {globalError}
            </div>
            <button
              type="button"
              onClick={() => setGlobalError(null)}
              aria-label="Dismiss error"
              className="text-xs font-medium underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {libraryError && (
          <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#FECACA] bg-[#FEF2F2] p-3 text-xs text-[#991B1B]">
            <span>{libraryError}</span>
            <button type="button" onClick={() => void refresh()} className="font-semibold underline">Try again</button>
          </div>
        )}

        {/* TAB 1: LIBRARY SCREEN */}
        {activeTab === "library" && (libraryError && !libraryLoaded ? (
          <p className="rounded-xl border border-[#E5E4DF] bg-white py-16 text-center text-sm text-[#6E6C66]">The song library is unavailable.</p>
        ) : (
          <div className="space-y-5">
            {/* Real Counts Summary Bar (Rule 5) */}
            <section className="rounded-xl border border-[#E5E4DF] bg-white p-4 shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#ECEBE6] pb-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-[#141413]">Status:</span>
                  {(
                    [
                      ["all", `All (${statusCounts.all})`],
                      ["approved", `Approved (${statusCounts.approved})`],
                      ["ready", `Ready (${statusCounts.ready})`],
                      ["lyric_approved", `Lyric Approved (${statusCounts.lyric_approved})`],
                      ["draft", `Drafts (${statusCounts.draft})`],
                      ["failed", `Failed (${statusCounts.failed})`],
                      ["generating", `Generating (${statusCounts.generating})`],
                      ["other", `Other (${statusCounts.other})`],
                      ["needs_person", `Needs Person (${statusCounts.needs_person})`],
                      ["archived", `Archived (${statusCounts.archived})`],
                    ] as const
                  ).map(([statusKey, label]) => (
                    <button
                      key={statusKey}
                      type="button"
                      onClick={() => setStatusFilter(statusKey as StatusFilter)}
                      className={`rounded-md px-2.5 py-1 font-semibold transition-colors ${
                        statusFilter === statusKey
                          ? "bg-[#1B3B6F] text-white"
                          : "bg-[#F3F2EE] text-[#57554F] hover:bg-[#E5E4DF]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2 text-xs">
                  <span className="text-[#6E6C66]">Date:</span>
                  <select
                    value={dateFilter}
                    onChange={(e) => setDateFilter(e.target.value as DateFilter)}
                    className="rounded-md border border-[#D4D2CA] bg-white px-2 py-1 text-xs text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
                  >
                    <option value="all">All Time</option>
                    <option value="today">Today</option>
                    <option value="week">Past 7 Days</option>
                    <option value="newest">Newest First</option>
                    <option value="oldest">Oldest First</option>
                  </select>
                </div>
              </div>

              <label className="mt-3 flex items-center gap-2 text-xs">Rhyme
                <select className="rounded-md border border-[#D4D2CA] px-2 py-1" value={settings.rhyme_scheme === "OFF" ? "All" : rhymeFilter}
                  disabled={settings.rhyme_scheme === "OFF"} onChange={e => setRhymeFilter(e.target.value)}>
                  {["All", "Rhymes", "Broken"].map(option => <option key={option}>{option}</option>)}
                </select>
              </label>
              {/* Feelings Breakdown Bar (Clickable chips) */}
              <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
                <span className="font-semibold text-[#6E6C66] mr-1">Feeling:</span>
                <button
                  type="button"
                  onClick={() => setFeelingFilter("all")}
                  className={`rounded-full px-2.5 py-0.5 font-medium transition-colors ${
                    feelingFilter === "all"
                      ? "bg-[#141413] text-white"
                      : "bg-[#F3F2EE] text-[#57554F] hover:bg-[#E5E4DF]"
                  }`}
                >
                  All ({activeSongs.length})
                </button>
                {settings.feelings.map((feeling) => (
                  <button
                    key={feeling}
                    type="button"
                    onClick={() => setFeelingFilter(feeling)}
                    className={`rounded-full px-2.5 py-0.5 font-medium transition-colors ${
                      feelingFilter === feeling
                        ? "bg-[#1B3B6F] text-white"
                        : "bg-[#FAF9F6] border border-[#E5E4DF] text-[#57554F] hover:border-[#1B3B6F]"
                    }`}
                  >
                    {feeling} ({feelingCounts[feeling] || 0})
                  </button>
                ))}
              </div>
            </section>

            {rhymeProgress && <p role="status">{rhymeProgress}</p>}
            {proposals.map(proposal => {
              const check = validateLyrics(proposal.lines, settings);
              return <section key={proposal.id} className="space-y-2 rounded-xl border bg-white p-4 text-sm">
                <h3 className="font-semibold">Review rhyme fix · <bdi>{proposal.title}</bdi></h3>
                <div className="grid grid-cols-2 gap-2 text-xs"><strong>Before</strong><strong>After</strong></div>
                {Array.from({ length: Math.max(proposal.before.length, proposal.lines.length) }, (_, i) =>
                  <div key={i} className="grid grid-cols-2 gap-2">
                    <p dir="rtl">{proposal.before[i]}</p>
                    <p dir="rtl" className={proposal.before[i] !== proposal.lines[i] ? "bg-green-50" : ""}>{proposal.lines[i]}</p>
                  </div>)}
                {!check.valid && <p className="text-[#B91C1C]">{check.errors.join(" ")}</p>}
                <p className="text-xs">Applying changed lyrics requires a new recording. Existing takes stay in history.</p>
                <button className="rounded border px-3 py-1" disabled={applying || !check.valid} onClick={async () => {
                  setApplying(true);
                  try {
                    await handleSaveEdit(proposal.id, { lines: proposal.lines, expected_lines: proposal.before });
                    setProposals(current => current.filter(p => p.id !== proposal.id));
                  } catch { /* The save handler displays the error. */ }
                  finally { setApplying(false); }
                }}>Apply</button>
                <button className="ml-2" disabled={applying} onClick={() => setProposals(current => current.filter(p => p.id !== proposal.id))}>Dismiss</button>
              </section>;
            })}

            {/* Selection Actions & Search Toolbar */}
            <div className="flex flex-col gap-3 rounded-xl border border-[#E5E4DF] bg-white p-3.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={handleSelectAll}
                  className="rounded-lg border border-[#D4D2CA] bg-white px-3 py-1.5 text-xs font-semibold text-[#57554F] hover:bg-[#F3F2EE]"
                >
                  {selectedSongIds.size === filteredSongs.length && filteredSongs.length > 0
                    ? "Deselect All"
                    : `Select All (${filteredSongs.length})`}
                </button>

                {selectedSongIds.size > 0 && (
                  <div className="flex items-center gap-2 border-l border-[#ECEBE6] pl-2.5">
                    <span className="font-mono text-xs font-bold text-[#1B3B6F]">
                      {selectedSongIds.size} selected
                    </span>
                    <button disabled={!!rhymeProgress || settings.rhyme_scheme === "OFF"}
                      onClick={() => void fixRhymes(songs.filter(song => selectedSongIds.has(song.id)))}
                      className="rounded-md border px-2 py-1 text-xs">Fix rhyme</button>

                    <button
                      type="button"
                      onClick={() => void handleGenerateSelected()}
                      disabled={isBatchRunning}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#1B3B6F] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#152E57] disabled:opacity-50"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      Generate Selected
                    </button>

                    <button
                      type="button"
                      onClick={handleArchiveSelected}
                      className="inline-flex items-center gap-1 rounded-lg border border-[#D4D2CA] bg-white px-2.5 py-1.5 text-xs font-medium text-[#DC2626] hover:bg-[#FEF2F2]"
                    >
                      <Archive className="h-3.5 w-3.5" />
                      Archive
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        handleExportZip(
                          songs.filter((s) => selectedSongIds.has(s.id)),
                          "darija-selected-songs"
                        )
                      }
                      className="inline-flex items-center gap-1 rounded-lg border border-[#D4D2CA] bg-white px-2.5 py-1.5 text-xs font-medium text-[#1B3B6F] hover:bg-[#EFF6FF]"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Export ZIP
                    </button>
                  </div>
                )}
              </div>

              {/* Search Bar */}
              <div className="relative w-full sm:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#706E67]" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  aria-label="Search songs"
                  placeholder="Search by title, feeling, lyric..."
                  className="w-full rounded-lg border border-[#DCDAD2] bg-[#FAF9F6] py-1.5 pl-8 pr-3 text-xs text-[#141413] placeholder:text-[#8A877F] focus:border-[#1B3B6F] focus:bg-white focus:outline-none"
                />
              </div>
            </div>

            {/* Batch Progress Bar */}
            {isBatchRunning && (
              <div className="rounded-xl border border-[#BFDBFE] bg-[#EFF6FF] p-3 text-xs">
                <div className="flex items-center justify-between font-semibold text-[#1E40AF]">
                  <span>Generating audio takes for selected songs…</span>
                  <span className="font-mono">
                    {batchProgress.done} / {batchProgress.total} completed
                  </span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#DBEAFE]">
                  <div
                    className="h-full bg-[#1B3B6F] transition-all duration-300"
                    style={{
                      width: `${(batchProgress.done / Math.max(1, batchProgress.total)) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {(statusCounts.failed > 0 || statusCounts.generating > 0) && (
              <button type="button" disabled={isBatchRunning} onClick={() => void handleGenerateSelected(true)}
                className="inline-flex items-center gap-2 rounded-lg border border-[#D4D2CA] bg-white px-3 py-2 text-xs font-semibold disabled:opacity-50">
                <Wrench className="h-4 w-4" /> Fix all failed
              </button>
            )}

            {/* Song List */}
            <div className="overflow-hidden rounded-xl border border-[#E5E4DF] bg-white shadow-xs">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-[#6E6C66]">
                  <Loader2 className="h-4 w-4 animate-spin text-[#1B3B6F]" />
                  Loading songs…
                </div>
              ) : filteredSongs.length === 0 ? (
                <div className="py-16 text-center text-sm text-[#6E6C66]">
                  {songs.length ? "No songs match the current filters." : "Your library is empty. Create a song or open Settings to seed the default catalog."}
                </div>
              ) : (
                filteredSongs.map((song) => (
                  <SongRow
                    key={song.id}
                    song={song}
                    settings={settings}
                    isPlaying={isPlaying && activeSongNumber === song.number}
                    isActiveTrack={activeSongNumber === song.number}
                    isGenerating={generatingNumbers.has(song.number)}
                    currentTime={currentTime}
                    duration={duration}
                    isBatchRunning={isBatchRunning}
                    isSelected={selectedSongIds.has(song.id)}
                    onToggleSelect={handleToggleSelect}
                    onTogglePlay={handleTogglePlay}
                    onSeek={handleSeek}
                    onGenerate={(num) => {
                      void handleGenerateSong(num);
                    }}
                    onDownloadSingle={handleDownloadSingle}
                    onChangeAdminFeeling={handleChangeAdminFeeling}
                    fixingRhyme={!!rhymeProgress}
                    onFixRhyme={() => void fixRhymes([song])}
                    onSaveEdit={handleSaveEdit}
                    onApproveLyric={handleApproveLyric}
                    onCheckVocals={(number, take) => { void handleGenerateSong(number, false, take); }}
                    onApproveTake={handleApproveTake}
                    onChooseTake={handleChooseTake}
                    onToggleArchive={handleToggleArchive}
                    onViewHistory={(num) => {
                      setHistorySongNumber(num);
                      setIsHistoryDrawerOpen(true);
                    }}
                  />
                ))
              )}
            </div>
          </div>
        ))}

        {/* TAB 2: SETTINGS SCREEN */}
        {activeTab === "settings" && (
          <div className="space-y-5">
            <SettingsView key={settings.updated_at} settings={settings} onSaveSettings={handleSaveSettings} />
            <StudioAdministration refresh={refresh} />
          </div>
        )}

        {/* TAB 3: EXPORT SCREEN */}
        {activeTab === "export" && (
          <section className="space-y-6">
            <div className="rounded-xl border border-[#E5E4DF] bg-white p-6 shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#ECEBE6] pb-4">
                <div>
                  <h2 className="text-xl font-bold text-[#141413]">
                    Export Mastered Songs Pack &amp; Manifest
                  </h2>
                  <p className="mt-1 text-xs text-[#57554F]">
                    Downloads a complete ZIP of the best take of each song named <span className="font-mono text-xs">NN-feeling_key.wav</span>, along with the updated <span className="font-mono text-xs">songs.json</span> manifest containing <span className="font-mono text-xs">id</span>, <span className="font-mono text-xs">admin_feeling</span>, and transcription metrics.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleExportZip(filteredSongs, "darija-filtered-songs")}
                    disabled={downloadingZip}
                    className="inline-flex items-center gap-2 rounded-lg border border-[#D4D2CA] bg-white px-3.5 py-2 text-xs font-semibold text-[#141413] hover:bg-[#F3F2EE] disabled:opacity-50"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export Current Filter ({filteredSongs.filter((s) => s.download_url || s.storage_path).length})
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportZip(songs, "darija-all-songs-pack")}
                    disabled={downloadingZip}
                    className="inline-flex items-center gap-2 rounded-lg bg-[#1B3B6F] px-4 py-2 text-xs font-semibold text-white hover:bg-[#152E57] disabled:opacity-50"
                  >
                    <Archive className="h-4 w-4" />
                    {downloadingZip
                      ? `Packaging ZIP (${zipProgress ?? "…"})`
                      : `Export All Ready (${songs.filter((s) => s.download_url || s.storage_path).length})`}
                  </button>
                </div>
              </div>

              {/* Manifest JSON preview */}
              <div className="mt-6">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-bold text-[#141413]">
                    Live songs.json Preview ({manifestPreview.length} tracks)
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const blob = new Blob([JSON.stringify(manifestPreview, null, 2)], {
                        type: "application/json;charset=utf-8",
                      });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "songs.json";
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                    }}
                    className="font-mono text-xs text-[#1B3B6F] underline"
                  >
                    Download songs.json only
                  </button>
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
      </main>

      {/* New Song Modal */}
      <NewSongModal
        isOpen={isNewSongModalOpen}
        onClose={() => setIsNewSongModalOpen(false)}
        settings={settings}
        onAddSong={handleAddNewSong}
      />

      {/* Batch Generator Modal */}
      <BatchGeneratorModal
        isOpen={isBatchModalOpen}
        onClose={() => setIsBatchModalOpen(false)}
        settings={settings}
        existingSongs={songs}
        onAddBatch={handleAddBatchSongs}
      />

      {/* Song History Drawer */}
      <SongHistoryDrawer
        isOpen={isHistoryDrawerOpen}
        onClose={() => {
          setIsHistoryDrawerOpen(false);
          setHistorySongNumber(null);
        }}
        historyItems={historyItems}
        selectedSongNumber={historySongNumber}
      />

      {/* Sticky Mini Player Bar */}
      {activeSong && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[#DCDAD2] bg-white/95 backdrop-blur-md">
          <div className="mx-auto flex max-w-[1240px] items-center justify-between gap-4 px-6 py-2.5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="font-mono text-xs font-semibold text-[#706E67] tabular-nums">
                #{String(activeSong.number).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                <div
                  dir="rtl"
                  className="font-arabic truncate text-sm font-semibold text-[#141413]"
                >
                  {activeSong.title}
                </div>
                <div className="truncate font-mono text-[11px] text-[#6E6C66]">
                  {activeSong.feeling_key}
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
                onClick={() => {
                  void handleTogglePlay(activeSong);
                }}
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
                  max={duration || activeSong.duration_seconds || 30}
                  step={0.1}
                  value={currentTime}
                  onChange={(e) => handleSeek(Number(e.target.value))}
                  aria-label="Global track scrubber"
                  className="h-1.5 w-full cursor-pointer accent-[#1B3B6F]"
                />
                <span className="w-8 text-right font-mono text-[11px] text-[#6E6C66] tabular-nums">
                  {formatClock(duration || activeSong.duration_seconds || 30)}
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
