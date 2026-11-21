import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  CheckCircle2,
  Clock,
  Download,
  AlertCircle,
  AlertTriangle,
  Loader2,
  LogIn,
  LogOut,
  Pause,
  Play,
  RotateCcw,
  Search,
  Settings as SettingsIcon,
  SkipBack,
  SkipForward,
  Sparkles,
  Square,
  Wrench,
  X,
  Plus,
  Layers,
  History,
  ShieldCheck,
  Filter,
  SlidersHorizontal,
} from "lucide-react";
import JSZip from "jszip";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import {
  getBlob,
  getDownloadURL,
  ref,
  uploadBytes,
} from "firebase/storage";
import { SongRow } from "./components/SongRow";
import { NewSongModal } from "./components/NewSongModal";
import { BatchGeneratorModal } from "./components/BatchGeneratorModal";
import { SettingsView } from "./components/SettingsView";
import { SongHistoryDrawer } from "./components/SongHistoryDrawer";
import {
  DEFAULT_STUDIO_SETTINGS,
  INITIAL_SONGS,
  formatSongFilename,
  type SongHistoryItem,
  type SongState,
  type SongStatus,
  type SongTake,
  type SongsJsonEntry,
  type StudioSettings,
} from "./data/songs";
import {
  OperationType,
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  storage,
} from "./lib/firebase";
import { validateLyrics } from "./lib/lyricQuality";

type ActiveTab = "library" | "settings" | "export";
type StatusFilter = "all" | SongStatus;
type DateFilter = "all" | "today" | "week" | "newest" | "oldest";

interface QualityReportPayload {
  words_heard_pct: number | null;
  transcribed_text: string | null;
  missing_words: string[];
  extra_words: string[];
  voice_start_seconds: number | null;
  voice_end_seconds: number | null;
}

function decodeQualityReportHeader(encoded: string | null): QualityReportPayload | null {
  if (!encoded) return null;
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json) as Partial<QualityReportPayload>;
    return {
      words_heard_pct:
        typeof parsed.words_heard_pct === "number" ? parsed.words_heard_pct : null,
      transcribed_text:
        typeof parsed.transcribed_text === "string" ? parsed.transcribed_text : null,
      missing_words: Array.isArray(parsed.missing_words) ? parsed.missing_words : [],
      extra_words: Array.isArray(parsed.extra_words) ? parsed.extra_words : [],
      voice_start_seconds:
        typeof parsed.voice_start_seconds === "number" ? parsed.voice_start_seconds : null,
      voice_end_seconds:
        typeof parsed.voice_end_seconds === "number" ? parsed.voice_end_seconds : null,
    };
  } catch {
    return null;
  }
}

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [idToken, setIdToken] = useState<string>("");

  const [songs, setSongs] = useState<SongState[]>([]);
  const [historyItems, setHistoryItems] = useState<SongHistoryItem[]>([]);
  const [settings, setSettings] = useState<StudioSettings>(DEFAULT_STUDIO_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<Error | null>(null);

  const reportFirestoreError = (
    err: unknown,
    operationType: OperationType,
    path: string | null
  ): never => {
    try {
      return handleFirestoreError(err, operationType, path);
    } catch (wrapped) {
      const errorObj = wrapped instanceof Error ? wrapped : new Error(String(wrapped));
      setFatalError(errorObj);
      throw errorObj;
    }
  };

  // UI state
  const [activeTab, setActiveTab] = useState<ActiveTab>("library");
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
  const [generatingNumbers, setGeneratingNumbers] = useState<Set<number>>(new Set());
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });
  const cancelBatchRef = useRef(false);

  // Audio player state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [activeSongNumber, setActiveSongNumber] = useState<number | null>(null);
  const [activeTrackKey, setActiveTrackKey] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [zipProgress, setZipProgress] = useState<string | null>(null);

  const migrationCheckedRef = useRef(false);

  // Listen to Firebase Google Auth state & refresh token
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (nextUser) {
        const token = await nextUser.getIdToken();
        setIdToken(token);
      } else {
        setIdToken("");
        setSongs([]);
        setHistoryItems([]);
        setLoading(false);
        migrationCheckedRef.current = false;
      }
    });
    return () => unsub();
  }, []);

  // 1. Subscribe to /settings/app_settings
  useEffect(() => {
    if (!authReady || !user) return;
    const settingsDocRef = doc(db, "settings", "app_settings");

    const unsub = onSnapshot(settingsDocRef, async (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data() as Partial<StudioSettings>;
        setSettings({
          feelings: Array.isArray(data.feelings) && data.feelings.length > 0
            ? data.feelings
            : DEFAULT_STUDIO_SETTINGS.feelings,
          lines_per_song: typeof data.lines_per_song === "number" ? data.lines_per_song : 6,
          max_words_per_line:
            typeof data.max_words_per_line === "number" ? data.max_words_per_line : 5,
          forbidden_words: Array.isArray(data.forbidden_words)
            ? data.forbidden_words
            : DEFAULT_STUDIO_SETTINGS.forbidden_words,
          block_substrings: data.block_substrings !== false,
          no_numbers_prices_brands: data.no_numbers_prices_brands !== false,
          default_model: data.default_model || "lyria-3-clip-preview",
          target_length: typeof data.target_length === "number" ? data.target_length : 30,
          updated_at: data.updated_at || new Date().toISOString(),
          ownerId: data.ownerId || user.uid,
        });
      } else {
        // Initialize default settings doc
        const initSettings: StudioSettings = {
          ...DEFAULT_STUDIO_SETTINGS,
          ownerId: user.uid,
          updated_at: new Date().toISOString(),
        };
        await setDoc(settingsDocRef, initSettings).catch(() => {});
      }
    });

    return () => unsub();
  }, [authReady, user]);

  // 2. Subscribe to /song_history
  useEffect(() => {
    if (!authReady || !user) return;
    const isStudioAdmin = user.email === "contact@tenten.ma" && user.emailVerified;
    const historyQuery = isStudioAdmin
      ? collection(db, "song_history")
      : query(collection(db, "song_history"), where("ownerId", "==", user.uid));

    const unsub = onSnapshot(historyQuery, (snapshot) => {
      const items: SongHistoryItem[] = [];
      snapshot.forEach((snap) => {
        items.push(snap.data() as SongHistoryItem);
      });
      // Sort newest first
      items.sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      setHistoryItems(items);
    });

    return () => unsub();
  }, [authReady, user]);

  // 3. Subscribe to /songs & run migration for songs 1–20 if needed
  useEffect(() => {
    if (!authReady || !user) return;
    setLoading(true);

    const isStudioAdmin = user.email === "contact@tenten.ma" && user.emailVerified;
    const songsQuery = isStudioAdmin
      ? collection(db, "songs")
      : query(collection(db, "songs"), where("ownerId", "==", user.uid));

    const unsubscribe = onSnapshot(
      songsQuery,
      async (snapshot) => {
        const loadedSongs: SongState[] = [];
        snapshot.forEach((docSnap) => {
          const raw = docSnap.data() as any;
          const songId = raw.id || docSnap.id;
          const songNumber = typeof raw.number === "number" ? raw.number : Number(docSnap.id) || 1;

          loadedSongs.push({
            id: songId,
            number: songNumber,
            title: raw.title || "أغنية مغربية",
            lines: Array.isArray(raw.lines) ? raw.lines : [],
            admin_feeling: raw.admin_feeling || "family_evening",
            feeling_key: raw.feeling_key || "family_song",
            theme: raw.theme || "Family moment",
            mood: raw.mood || "Warm and emotional",
            tempo_bpm: typeof raw.tempo_bpm === "number" ? raw.tempo_bpm : 80,
            instruments: raw.instruments || "Acoustic oud, guitar",
            vocal_tone: raw.vocal_tone || "Solo warm vocal",
            status: (raw.status as SongStatus) || (raw.storage_path ? "ready" : "draft"),
            best_take_id: raw.best_take_id || (raw.storage_path ? "take_1" : null),
            created_at: raw.created_at || new Date().toISOString(),
            updated_at: raw.updated_at || new Date().toISOString(),
            archived: Boolean(raw.archived),
            ownerId: raw.ownerId || user.uid,
            // Resolved active playback fields
            download_url: raw.download_url || null,
            storage_path: raw.storage_path || null,
            duration_seconds: raw.duration_seconds || null,
            lufs: raw.lufs || null,
            true_peak_db: raw.true_peak_db || null,
            file_name: raw.file_name || formatSongFilename(songNumber, raw.feeling_key || "song", "wav"),
            words_heard_pct: raw.words_heard_pct || null,
            transcribed_text: raw.transcribed_text || null,
            missing_words: Array.isArray(raw.missing_words) ? raw.missing_words : [],
            extra_words: Array.isArray(raw.extra_words) ? raw.extra_words : [],
            voice_start_seconds: raw.voice_start_seconds || null,
            voice_end_seconds: raw.voice_end_seconds || null,
            takes: Array.isArray(raw.takes) ? raw.takes : [],
          });
        });

        // Migration Check: If empty or missing legacy 1-20, seed them with 0 data loss
        if (!migrationCheckedRef.current) {
          migrationCheckedRef.current = true;
          const existingMap = new Map<number, any>();
          loadedSongs.forEach((s) => existingMap.set(s.number, s));

          const needsMigration = INITIAL_SONGS.filter((spec) => !existingMap.has(spec.number));

          if (needsMigration.length > 0) {
            try {
              const batch = writeBatch(db);
              const now = new Date().toISOString();

              for (const spec of needsMigration) {
                const docId = String(spec.number);
                const songRef = doc(db, "songs", docId);
                const initialSong: SongState = {
                  id: docId,
                  number: spec.number,
                  title: spec.title,
                  lines: spec.lines,
                  admin_feeling: spec.admin_feeling,
                  feeling_key: spec.feeling_key,
                  theme: spec.theme,
                  mood: spec.mood,
                  tempo_bpm: spec.tempo_bpm,
                  instruments: spec.instruments,
                  vocal_tone: spec.vocal_tone,
                  status: "lyric_approved",
                  best_take_id: null,
                  created_at: now,
                  updated_at: now,
                  archived: false,
                  ownerId: user.uid,
                  file_name: formatSongFilename(spec.number, spec.feeling_key, "wav"),
                  takes: [],
                };
                batch.set(songRef, initialSong);

                // Add to song_history with action "migrated"
                const historyRef = doc(db, "song_history", `hist_${docId}_init`);
                const historyItem: SongHistoryItem = {
                  id: `hist_${docId}_init`,
                  song_id: docId,
                  song_number: spec.number,
                  title: spec.title,
                  lines: spec.lines,
                  admin_feeling: spec.admin_feeling,
                  action: "migrated",
                  timestamp: now,
                  ownerId: user.uid,
                };
                batch.set(historyRef, historyItem);
              }
              await batch.commit();
              return;
            } catch (err) {
              reportFirestoreError(err, OperationType.WRITE, "songs");
            }
          }
        }

        // Sort songs by display number (1, 2, 3...)
        loadedSongs.sort((a, b) => a.number - b.number);
        setSongs(loadedSongs);
        setLoading(false);
      },
      (error) => {
        setLoading(false);
        try {
          reportFirestoreError(error, OperationType.LIST, "songs");
        } catch {
          // Handled
        }
      }
    );

    return () => unsubscribe();
  }, [authReady, user]);

  // Filtered and searched songs
  const filteredSongs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let result = songs.filter((song) => {
      // Archived filter
      if (statusFilter === "archived") {
        if (!song.archived) return false;
      } else {
        if (song.archived) return false;
        if (statusFilter !== "all" && song.status !== statusFilter) return false;
      }

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
  }, [songs, statusFilter, feelingFilter, dateFilter, searchQuery]);

  // Dynamic counts for library summary (no hardcoded "20")
  const activeSongs = useMemo(() => songs.filter((s) => !s.archived), [songs]);
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: activeSongs.length,
      draft: 0,
      lyric_approved: 0,
      generating: 0,
      ready: 0,
      approved: 0,
      failed: 0,
      needs_person: 0,
      archived: songs.filter((s) => s.archived).length,
    };
    activeSongs.forEach((s) => {
      if (typeof counts[s.status] === "number") {
        counts[s.status] += 1;
      }
    });
    return counts;
  }, [songs, activeSongs]);

  // Counts per feeling
  const feelingCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const f of settings.feelings) {
      counts[f] = 0;
    }
    activeSongs.forEach((s) => {
      if (typeof counts[s.admin_feeling] === "number") {
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

  const handleSignIn = async () => {
    setAuthLoading(true);
    setGlobalError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "Google sign-in failed");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    setIsPlaying(false);
    setActiveSongNumber(null);
    setActiveTrackKey(null);
    await signOut(auth);
  };

  // Audio Playback
  const resolveDownloadUrl = async (song: SongState): Promise<string> => {
    if (song.download_url) return song.download_url;
    if (!song.storage_path) {
      throw new Error(`No audio recorded for #${song.number}`);
    }
    return await getDownloadURL(ref(storage, song.storage_path));
  };

  const handleTogglePlay = async (song: SongState, take?: SongTake) => {
    const audio = audioRef.current;
    if (!audio) return;

    let targetUrl: string | null = null;
    let trackDuration = song.duration_seconds || 30;
    const trackKey = take ? `${song.id}-${take.id}` : `${song.id}-main`;

    if (take) {
      targetUrl = take.download_url || null;
      trackDuration = take.duration_seconds || trackDuration;
      if (!targetUrl && take.storage_path) {
        try {
          targetUrl = await getDownloadURL(ref(storage, take.storage_path));
        } catch {
          // Ignored
        }
      }
    } else {
      if (!song.download_url && !song.storage_path) return;
      try {
        targetUrl = await resolveDownloadUrl(song);
      } catch (err) {
        setGlobalError(err instanceof Error ? err.message : "Failed to resolve audio URL");
        return;
      }
    }

    if (!targetUrl) return;

    if (activeTrackKey === trackKey && activeSongNumber === song.number) {
      if (audio.paused) {
        void audio.play();
      } else {
        audio.pause();
      }
      return;
    }

    try {
      setActiveSongNumber(song.number);
      setActiveTrackKey(trackKey);
      setCurrentTime(0);
      setDuration(trackDuration);
      audio.src = targetUrl;
      audio.load();
      void audio.play();
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "Playback failed");
    }
  };

  const handleSeek = (time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = time;
    setCurrentTime(time);
  };

  const playAdjacentReady = (dir: -1 | 1) => {
    const readyList = filteredSongs.filter((s) => s.download_url || s.storage_path);
    if (readyList.length === 0) return;
    const currentIdx = readyList.findIndex((s) => s.number === activeSongNumber);
    const nextIdx =
      currentIdx === -1 ? 0 : (currentIdx + dir + readyList.length) % readyList.length;
    void handleTogglePlay(readyList[nextIdx]);
  };

  const fetchStorageWavBlob = async (song: SongState): Promise<Blob> => {
    if (!song.storage_path) {
      throw new Error(`Missing audio path for #${song.number}`);
    }
    try {
      return await getBlob(ref(storage, song.storage_path));
    } catch {
      const url = await resolveDownloadUrl(song);
      const proxyRes = await fetch("/api/storage-proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ url }),
      });
      if (!proxyRes.ok) {
        throw new Error(`Failed to download audio for #${song.number}`);
      }
      return await proxyRes.blob();
    }
  };

  const handleDownloadSingle = async (song: SongState, take?: SongTake) => {
    if (!user) return;
    setGlobalError(null);
    try {
      let blob: Blob;
      let downloadFileName = formatSongFilename(song.number, song.feeling_key, "wav");

      if (take && take.storage_path) {
        try {
          blob = await getBlob(ref(storage, take.storage_path));
        } catch {
          const url =
            take.download_url || (await getDownloadURL(ref(storage, take.storage_path)));
          const res = await fetch("/api/storage-proxy", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify({ url }),
          });
          blob = await res.blob();
        }
        downloadFileName = `${song.number}-${song.feeling_key}-take-${take.take_number}.wav`;
      } else {
        blob = await fetchStorageWavBlob(song);
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = downloadFileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : `Failed to download #${song.number}`);
    }
  };

  // Generation of audio for a song
  const handleGenerateSong = async (
    songNumber: number
  ): Promise<{ ok: boolean; stopBatch?: boolean }> => {
    if (!user) {
      setGlobalError("Please sign in first.");
      return { ok: false, stopBatch: true };
    }

    const song = songs.find((s) => s.number === songNumber);
    if (!song) return { ok: false };

    if (song.status === "draft") {
      setGlobalError(
        `Song #${songNumber} is still a draft. Please click "Approve Lyric" before generating audio.`
      );
      return { ok: false };
    }

    const lyricCheck = validateLyrics(song.lines, settings);
    if (!lyricCheck.valid) {
      setGlobalError(
        `Cannot generate #${songNumber} until lyric rule warnings are resolved: ${lyricCheck.errors.join("; ")}`
      );
      return { ok: false };
    }

    setGlobalError(null);
    setGeneratingNumbers((prev) => new Set(prev).add(songNumber));

    // Update status to "generating"
    await updateDoc(doc(db, "songs", song.id), {
      status: "generating",
      updated_at: new Date().toISOString(),
    }).catch(() => {});

    try {
      const res = await fetch(`/api/songs/${songNumber}/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          feeling_key: song.feeling_key,
          admin_feeling: song.admin_feeling,
          title: song.title,
          theme: song.theme,
          lines: song.lines,
          mood: song.mood,
          tempo_bpm: song.tempo_bpm,
          instruments: song.instruments,
          vocal_tone: song.vocal_tone,
          model: settings.default_model || "lyria-3-clip-preview",
        }),
      });

      if (!res.ok) {
        const errJson = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errJson.error || `Audio generation failed (${res.status})`);
      }

      const wavBlob = await res.blob();
      const durationSeconds = Number(res.headers.get("X-Duration-Seconds") || "30");
      const lufs = Number(res.headers.get("X-Lufs") || "-14");
      const truePeakDb = Number(res.headers.get("X-True-Peak-Db") || "-1");
      const modelUsed = res.headers.get("X-Model-Used") || settings.default_model;
      const qualityReport = decodeQualityReportHeader(res.headers.get("X-Quality-Report"));

      const existingTakes = song.takes || [];
      const takeNumber = existingTakes.length + 1;
      const takeId = `take_${takeNumber}_${Date.now()}`;
      const takeStoragePath = `songs/takes/${formatSongFilename(song.number, song.feeling_key, "wav")}-take-${takeNumber}.wav`;

      // 1. Upload take WAV to Cloud Storage
      const takeRef = ref(storage, takeStoragePath);
      await uploadBytes(takeRef, wavBlob, { contentType: "audio/wav" });
      const takeDownloadUrl = await getDownloadURL(takeRef);

      // 2. Create Take document in subcollection /songs/{songId}/takes/{takeId}
      const newTake: SongTake = {
        id: takeId,
        take_number: takeNumber,
        model: modelUsed,
        storage_path: takeStoragePath,
        download_url: takeDownloadUrl,
        duration_seconds: durationSeconds,
        lufs,
        true_peak_db: truePeakDb,
        words_heard_pct: qualityReport?.words_heard_pct ?? null,
        missing_words: qualityReport?.missing_words ?? [],
        extra_words: qualityReport?.extra_words ?? [],
        voice_start: qualityReport?.voice_start_seconds ?? null,
        voice_end: qualityReport?.voice_end_seconds ?? null,
        cost_estimate: 0.08,
        created_at: new Date().toISOString(),
        status: "ready",
        ownerId: user.uid,
        tempo_bpm: song.tempo_bpm,
      };

      await setDoc(doc(db, "songs", song.id, "takes", takeId), newTake);

      // 3. Promote to primary best take if first take or if no best take approved yet
      const mainStoragePath = `songs/${formatSongFilename(song.number, song.feeling_key, "wav")}`;
      const isFirstTake = existingTakes.length === 0;

      if (isFirstTake || !song.best_take_id) {
        await uploadBytes(ref(storage, mainStoragePath), wavBlob, {
          contentType: "audio/wav",
        });
      }

      const mainUrl = isFirstTake
        ? await getDownloadURL(ref(storage, mainStoragePath))
        : song.download_url;

      const updatedTakes = [...existingTakes, newTake].slice(-8);

      await updateDoc(doc(db, "songs", song.id), {
        status: "ready",
        best_take_id: isFirstTake ? takeId : song.best_take_id || takeId,
        duration_seconds: durationSeconds,
        lufs,
        true_peak_db: truePeakDb,
        download_url: mainUrl || takeDownloadUrl,
        storage_path: isFirstTake ? mainStoragePath : song.storage_path || takeStoragePath,
        words_heard_pct: qualityReport?.words_heard_pct ?? null,
        transcribed_text: qualityReport?.transcribed_text ?? null,
        missing_words: qualityReport?.missing_words ?? [],
        extra_words: qualityReport?.extra_words ?? [],
        voice_start_seconds: qualityReport?.voice_start_seconds ?? null,
        voice_end_seconds: qualityReport?.voice_end_seconds ?? null,
        model_used: modelUsed,
        takes: updatedTakes,
        updated_at: new Date().toISOString(),
      });

      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Generation failed";
      setGlobalError(`Error on #${songNumber}: ${msg}`);
      await updateDoc(doc(db, "songs", song.id), {
        status: "failed",
        updated_at: new Date().toISOString(),
      }).catch(() => {});
      return { ok: false };
    } finally {
      setGeneratingNumbers((prev) => {
        const next = new Set(prev);
        next.delete(songNumber);
        return next;
      });
    }
  };

  // Create single song from "New Song" modal
  const handleAddNewSong = async (newSong: {
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
  }) => {
    if (!user) return;
    const nextNumber =
      songs.length > 0 ? Math.max(...songs.map((s) => s.number)) + 1 : 1;
    const songId = `song_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();

    const songDoc: SongState = {
      id: songId,
      number: nextNumber,
      title: newSong.title,
      lines: newSong.lines,
      admin_feeling: newSong.admin_feeling,
      feeling_key: newSong.feeling_key,
      theme: newSong.theme,
      mood: newSong.mood,
      tempo_bpm: newSong.tempo_bpm,
      instruments: newSong.instruments,
      vocal_tone: newSong.vocal_tone,
      status: newSong.isApproved ? "lyric_approved" : "draft",
      best_take_id: null,
      created_at: now,
      updated_at: now,
      archived: false,
      ownerId: user.uid,
      file_name: formatSongFilename(nextNumber, newSong.feeling_key, "wav"),
      takes: [],
    };

    const batch = writeBatch(db);
    batch.set(doc(db, "songs", songId), songDoc);

    const historyId = `hist_${songId}_created`;
    const histItem: SongHistoryItem = {
      id: historyId,
      song_id: songId,
      song_number: nextNumber,
      title: newSong.title,
      lines: newSong.lines,
      admin_feeling: newSong.admin_feeling,
      action: newSong.isApproved ? "lyric_approved" : "created",
      timestamp: now,
      ownerId: user.uid,
    };
    batch.set(doc(db, "song_history", historyId), histItem);

    await batch.commit();
  };

  // Add batch songs from "Batch Generator" modal
  const handleAddBatchSongs = async (
    newSongs: Array<{
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
  ) => {
    if (!user || newSongs.length === 0) return;
    let nextNum = songs.length > 0 ? Math.max(...songs.map((s) => s.number)) + 1 : 1;
    const now = new Date().toISOString();
    const batch = writeBatch(db);

    for (const s of newSongs) {
      const songId = `song_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const songDoc: SongState = {
        id: songId,
        number: nextNum,
        title: s.title,
        lines: s.lines,
        admin_feeling: s.admin_feeling,
        feeling_key: s.feeling_key,
        theme: s.theme,
        mood: s.mood,
        tempo_bpm: s.tempo_bpm,
        instruments: s.instruments,
        vocal_tone: s.vocal_tone,
        status: s.isApproved ? "lyric_approved" : "draft",
        best_take_id: null,
        created_at: now,
        updated_at: now,
        archived: false,
        ownerId: user.uid,
        file_name: formatSongFilename(nextNum, s.feeling_key, "wav"),
        takes: [],
      };
      batch.set(doc(db, "songs", songId), songDoc);

      const histId = `hist_${songId}_created`;
      const histItem: SongHistoryItem = {
        id: histId,
        song_id: songId,
        song_number: nextNum,
        title: s.title,
        lines: s.lines,
        admin_feeling: s.admin_feeling,
        action: s.isApproved ? "lyric_approved" : "created",
        timestamp: now,
        ownerId: user.uid,
      };
      batch.set(doc(db, "song_history", histId), histItem);

      nextNum += 1;
    }

    await batch.commit();
  };

  // Approve Lyric action (draft -> lyric_approved)
  const handleApproveLyric = async (songId: string) => {
    if (!user) return;
    const song = songs.find((s) => s.id === songId);
    if (!song) return;

    const now = new Date().toISOString();
    const batch = writeBatch(db);

    batch.update(doc(db, "songs", songId), {
      status: "lyric_approved",
      updated_at: now,
    });

    const histId = `hist_${songId}_${Date.now()}`;
    const histItem: SongHistoryItem = {
      id: histId,
      song_id: songId,
      song_number: song.number,
      title: song.title,
      lines: song.lines,
      admin_feeling: song.admin_feeling,
      action: "lyric_approved",
      timestamp: now,
      ownerId: user.uid,
    };
    batch.set(doc(db, "song_history", histId), histItem);

    await batch.commit();
  };

  // Approve Take as best_take_id (marks status "approved")
  const handleApproveTake = async (songId: string, takeId: string) => {
    if (!user) return;
    const song = songs.find((s) => s.id === songId);
    if (!song) return;

    const targetTake = (song.takes || []).find((t) => t.id === takeId);
    const now = new Date().toISOString();

    await updateDoc(doc(db, "songs", songId), {
      best_take_id: takeId,
      status: "approved",
      download_url: targetTake?.download_url || song.download_url,
      storage_path: targetTake?.storage_path || song.storage_path,
      duration_seconds: targetTake?.duration_seconds ?? song.duration_seconds,
      lufs: targetTake?.lufs ?? song.lufs,
      true_peak_db: targetTake?.true_peak_db ?? song.true_peak_db,
      words_heard_pct: targetTake?.words_heard_pct ?? song.words_heard_pct,
      updated_at: now,
    });
  };

  // Edit lyrics (instantly saves to Firestore and appends to song_history)
  const handleSaveEdit = async (
    songId: string,
    updates: {
      title: string;
      lines: string[];
      mood: string;
      tempo_bpm: number;
      instruments: string;
      admin_feeling: string;
    }
  ) => {
    if (!user) return;
    const song = songs.find((s) => s.id === songId);
    if (!song) return;

    const now = new Date().toISOString();
    const batch = writeBatch(db);

    batch.update(doc(db, "songs", songId), {
      title: updates.title.trim().slice(0, 120),
      lines: updates.lines.map((l) => l.trim().slice(0, 240)),
      mood: updates.mood.trim().slice(0, 80),
      tempo_bpm: Math.min(100, Math.max(70, Math.round(updates.tempo_bpm))),
      instruments: updates.instruments.trim().slice(0, 300),
      admin_feeling: updates.admin_feeling,
      status: "draft", // Lyric edited -> back to draft for fresh review
      updated_at: now,
    });

    const histId = `hist_${songId}_${Date.now()}`;
    const histItem: SongHistoryItem = {
      id: histId,
      song_id: songId,
      song_number: song.number,
      title: updates.title.trim(),
      lines: updates.lines,
      admin_feeling: updates.admin_feeling,
      action: "edited",
      timestamp: now,
      ownerId: user.uid,
    };
    batch.set(doc(db, "song_history", histId), histItem);

    await batch.commit();
  };

  // Change admin_feeling dropdown
  const handleChangeAdminFeeling = async (songId: string, adminFeeling: string) => {
    if (!user) return;
    await updateDoc(doc(db, "songs", songId), {
      admin_feeling: adminFeeling,
      updated_at: new Date().toISOString(),
    });
  };

  // Archive / Restore song
  const handleToggleArchive = async (songId: string, archive: boolean) => {
    if (!user) return;
    const song = songs.find((s) => s.id === songId);
    if (!song) return;

    const now = new Date().toISOString();
    const batch = writeBatch(db);

    batch.update(doc(db, "songs", songId), {
      archived: archive,
      status: archive ? "archived" : song.best_take_id ? "ready" : "draft",
      updated_at: now,
    });

    const histId = `hist_${songId}_${Date.now()}`;
    const histItem: SongHistoryItem = {
      id: histId,
      song_id: songId,
      song_number: song.number,
      title: song.title,
      lines: song.lines,
      admin_feeling: song.admin_feeling,
      action: archive ? "archived" : "restored",
      timestamp: now,
      ownerId: user.uid,
    };
    batch.set(doc(db, "song_history", histId), histItem);

    await batch.commit();
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
  const handleGenerateSelected = async () => {
    const selected = songs.filter(
      (s) =>
        selectedSongIds.has(s.id) &&
        (s.status === "lyric_approved" || s.status === "ready" || s.status === "approved" || s.status === "failed") &&
        validateLyrics(s.lines, settings).valid
    );

    if (selected.length === 0) {
      setGlobalError(
        "None of the selected songs are eligible for generation (must be lyric_approved or later with zero rule errors)."
      );
      return;
    }

    cancelBatchRef.current = false;
    setIsBatchRunning(true);
    setBatchProgress({ done: 0, total: selected.length });

    let completed = 0;
    for (const target of selected) {
      if (cancelBatchRef.current) break;
      const res = await handleGenerateSong(target.number);
      if (res.stopBatch) break;
      completed += 1;
      setBatchProgress({ done: completed, total: selected.length });
    }

    setIsBatchRunning(false);
  };

  // Multi-selection: Archive selected
  const handleArchiveSelected = async () => {
    if (!user || selectedSongIds.size === 0) return;
    const now = new Date().toISOString();
    const batch = writeBatch(db);

    for (const songId of selectedSongIds) {
      const song = songs.find((s) => s.id === songId);
      if (!song) continue;

      batch.update(doc(db, "songs", songId), {
        archived: true,
        status: "archived",
        updated_at: now,
      });

      const histId = `hist_${songId}_${Date.now()}`;
      batch.set(doc(db, "song_history", histId), {
        id: histId,
        song_id: songId,
        song_number: song.number,
        title: song.title,
        lines: song.lines,
        admin_feeling: song.admin_feeling,
        action: "archived",
        timestamp: now,
        ownerId: user.uid,
      });
    }

    await batch.commit();
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
            const wavBlob = await fetchStorageWavBlob(song);
            const buf = await wavBlob.arrayBuffer();
            const fileName = formatSongFilename(song.number, song.feeling_key, "wav");
            zip.file(fileName, buf, { compression: "STORE" });
            fetched += 1;
            setZipProgress(`${fetched}/${readyToExport.length}`);
          })
        );
      }

      setZipProgress("Building ZIP…");
      const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${zipTitle}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "Failed to package ZIP archive");
    } finally {
      setDownloadingZip(false);
      setZipProgress(null);
    }
  };

  const handleSaveSettings = async (updated: StudioSettings) => {
    if (!user) return;
    await setDoc(doc(db, "settings", "app_settings"), updated);
  };

  if (fatalError) {
    throw fatalError;
  }

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
          <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-8 px-6 py-3.5">
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
        <div className="mx-auto flex max-w-[1240px] items-center justify-between gap-6 px-6 py-3">
          <div className="flex items-center gap-6">
            <a
              href="#top"
              onClick={(e) => {
                e.preventDefault();
                setActiveTab("library");
              }}
              className="text-lg font-bold tracking-tight text-[#141413] whitespace-nowrap shrink-0"
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
                Song Library ({activeSongs.length})
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
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => setIsHistoryDrawerOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#D4D2CA] bg-white px-3 py-1.5 text-xs font-semibold text-[#57554F] hover:bg-[#F3F2EE]"
              title="View permanent lyric history"
            >
              <History className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">History ({historyItems.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setIsBatchModalOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#1B3B6F] bg-[#EFF6FF] px-3.5 py-1.5 text-xs font-semibold text-[#1B3B6F] hover:bg-[#DBEAFE]"
            >
              <Layers className="h-3.5 w-3.5" />
              <span>Batch (1–20)</span>
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
              onClick={handleSignOut}
              className="rounded-lg p-1.5 text-[#706E67] hover:bg-[#F3F2EE] hover:text-[#141413]"
              title="Sign out"
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
              ["library", `Library (${activeSongs.length})`],
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
              className="text-xs font-medium underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* TAB 1: LIBRARY SCREEN */}
        {activeTab === "library" && (
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

                    <button
                      type="button"
                      onClick={handleGenerateSelected}
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

            {/* Song List */}
            <div className="overflow-hidden rounded-xl border border-[#E5E4DF] bg-white shadow-xs">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-[#6E6C66]">
                  <Loader2 className="h-4 w-4 animate-spin text-[#1B3B6F]" />
                  Loading songs from Firestore…
                </div>
              ) : filteredSongs.length === 0 ? (
                <div className="py-16 text-center text-sm text-[#6E6C66]">
                  No songs match the current filter or search criteria.
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
                    onSaveEdit={handleSaveEdit}
                    onApproveLyric={handleApproveLyric}
                    onApproveTake={handleApproveTake}
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
        )}

        {/* TAB 2: SETTINGS SCREEN */}
        {activeTab === "settings" && (
          <SettingsView
            settings={settings}
            onSaveSettings={handleSaveSettings}
          />
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
        existingSongs={songs}
        onAddSong={handleAddNewSong}
        idToken={idToken}
      />

      {/* Batch Generator Modal */}
      <BatchGeneratorModal
        isOpen={isBatchModalOpen}
        onClose={() => setIsBatchModalOpen(false)}
        settings={settings}
        existingSongs={songs}
        onAddBatch={handleAddBatchSongs}
        idToken={idToken}
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
