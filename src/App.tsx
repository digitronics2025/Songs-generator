import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  Download,
  Loader2,
  LogIn,
  LogOut,
  Pause,
  Play,
  RotateCcw,
  Search,
  SkipBack,
  SkipForward,
  Sparkles,
  Square,
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
  onSnapshot,
  query,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import {
  deleteObject,
  getBlob,
  getDownloadURL,
  ref,
  uploadBytes,
} from "firebase/storage";
import { SongRow } from "./components/SongRow";
import {
  INITIAL_SONGS,
  formatSongFilename,
  type SongState,
  type SongsJsonEntry,
} from "./data/songs";
import {
  OperationType,
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  storage,
} from "./lib/firebase";
import {
  ADMIN_FEELINGS,
  DEFAULT_ADMIN_FEELING_BY_KEY,
  validateLyrics,
  type AdminFeeling,
} from "./lib/lyricQuality";

type FilterMode = "all" | "ready" | "pending" | "error";
type ActiveTab = "studio" | "export" | "rules";
type LyriaModel = "lyria-3.5" | "lyria-3-clip-preview";

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

  const [songs, setSongs] = useState<SongState[]>([]);
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
  const [activeTab, setActiveTab] = useState<ActiveTab>("studio");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [model, setModel] = useState<LyriaModel>("lyria-3.5");
  const [generatingNumbers, setGeneratingNumbers] = useState<Set<number>>(new Set());

  // Batch queue state
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [batchCurrentNumber, setBatchCurrentNumber] = useState<number | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });
  const cancelBatchRef = useRef(false);
  const seededRef = useRef(false);

  // Audio player state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [activeSongNumber, setActiveSongNumber] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [zipProgress, setZipProgress] = useState<string | null>(null);

  // Listen to Firebase Google Auth state
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (!nextUser) {
        setSongs([]);
        setLoading(false);
        seededRef.current = false;
      }
    });
    return () => unsub();
  }, []);

  // Load and subscribe to Firestore `songs` collection once signed in
  useEffect(() => {
    if (!authReady || !user) return;
    setLoading(true);
    setGlobalError(null);

    const isStudioAdmin = user.email === "contact@tenten.ma" && user.emailVerified;
    const songsQuery = isStudioAdmin
      ? collection(db, "songs")
      : query(collection(db, "songs"), where("ownerId", "==", user.uid));

    const unsubscribe = onSnapshot(
      songsQuery,
      async (snapshot) => {
        const docsMap = new Map<number, SongState>();
        snapshot.forEach((docSnap) => {
          const raw = docSnap.data() as Partial<SongState>;
          if (typeof raw.number === "number") {
            const fallbackFeeling: AdminFeeling =
              DEFAULT_ADMIN_FEELING_BY_KEY[raw.feeling_key || ""] ?? "family_evening";
            const normalizedAdminFeeling = ADMIN_FEELINGS.includes(
              raw.admin_feeling as AdminFeeling
            )
              ? (raw.admin_feeling as AdminFeeling)
              : fallbackFeeling;

            docsMap.set(raw.number, {
              ...(raw as SongState),
              admin_feeling: normalizedAdminFeeling,
              words_heard_pct:
                typeof raw.words_heard_pct === "number" ? raw.words_heard_pct : null,
              transcribed_text:
                typeof raw.transcribed_text === "string" ? raw.transcribed_text : null,
              missing_words: Array.isArray(raw.missing_words) ? raw.missing_words : [],
              extra_words: Array.isArray(raw.extra_words) ? raw.extra_words : [],
              voice_start_seconds:
                typeof raw.voice_start_seconds === "number" ? raw.voice_start_seconds : null,
              voice_end_seconds:
                typeof raw.voice_end_seconds === "number" ? raw.voice_end_seconds : null,
            });
          }
        });

        // Seed any missing documents (1-20) on first run
        const missingSpecs = INITIAL_SONGS.filter((spec) => !docsMap.has(spec.number));
        if (missingSpecs.length > 0 && !seededRef.current) {
          seededRef.current = true;
          try {
            const batch = writeBatch(db);
            for (const spec of missingSpecs) {
              const docRef = doc(db, "songs", String(spec.number));
              const initialDoc: SongState = {
                ...spec,
                admin_feeling:
                  DEFAULT_ADMIN_FEELING_BY_KEY[spec.feeling_key] ?? "family_evening",
                model_used: null,
                status: "pending",
                duration_seconds: null,
                lufs: null,
                true_peak_db: null,
                file_name: formatSongFilename(spec.number, spec.feeling_key, "wav"),
                storage_path: null,
                download_url: null,
                generated_at: null,
                error_message: null,
                words_heard_pct: null,
                transcribed_text: null,
                missing_words: [],
                extra_words: [],
                voice_start_seconds: null,
                voice_end_seconds: null,
                ownerId: user.uid,
              };
              batch.set(docRef, initialDoc);
            }
            await batch.commit();
            return;
          } catch (err) {
            seededRef.current = false;
            reportFirestoreError(err, OperationType.WRITE, "songs");
          }
        }

        const ordered = Array.from(docsMap.values()).sort((a, b) => a.number - b.number);
        setSongs(ordered);
        setLoading(false);
      },
      (error) => {
        setLoading(false);
        try {
          reportFirestoreError(error, OperationType.LIST, "songs");
        } catch {
          // Captured in fatalError for ErrorBoundary
        }
      }
    );

    return () => unsubscribe();
  }, [authReady, user]);

  const readySongs = useMemo(() => songs.filter((s) => s.status === "ready"), [songs]);
  const pendingSongs = useMemo(
    () => songs.filter((s) => s.status === "pending" || s.status === "error"),
    [songs]
  );
  const errorSongs = useMemo(() => songs.filter((s) => s.status === "error"), [songs]);
  const validSongsCount = useMemo(
    () => songs.filter((s) => validateLyrics(s.lines).valid).length,
    [songs]
  );

  const filteredSongs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return songs.filter((song) => {
      if (filter === "ready" && song.status !== "ready") return false;
      if (filter === "pending" && song.status !== "pending") return false;
      if (filter === "error" && song.status !== "error") return false;
      if (!q) return true;
      return (
        song.feeling_key.toLowerCase().includes(q) ||
        song.admin_feeling.toLowerCase().includes(q) ||
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
  }, [songs]);

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
    await signOut(auth);
  };

  // Resolve Cloud Storage download URL & fetch raw bytes (with authenticated proxy fallback if bucket lacks GET CORS)
  const resolveDownloadUrl = async (song: SongState): Promise<string> => {
    if (song.download_url) return song.download_url;
    if (!song.storage_path) {
      throw new Error(`No Cloud Storage path recorded for ${song.file_name}`);
    }
    return await getDownloadURL(ref(storage, song.storage_path));
  };

  const fetchStorageWavBlob = async (song: SongState, idToken: string): Promise<Blob> => {
    if (!song.storage_path) {
      throw new Error(`Missing Cloud Storage path for ${song.file_name}`);
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
        const err = (await proxyRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Failed to download ${song.file_name} from Cloud Storage`);
      }
      return await proxyRes.blob();
    }
  };

  // Audio element handlers (plays directly from Cloud Storage URL)
  const handleTogglePlay = async (song: SongState) => {
    if (song.status !== "ready" || (!song.download_url && !song.storage_path)) return;
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

    try {
      const url = await resolveDownloadUrl(song);
      setActiveSongNumber(song.number);
      setCurrentTime(0);
      setDuration(song.duration_seconds || 0);
      audio.src = url;
      audio.load();
      void audio.play();
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "Failed to load audio from Cloud Storage");
    }
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
      currentIdx === -1 ? 0 : (currentIdx + dir + readySongs.length) % readySongs.length;
    void handleTogglePlay(readySongs[nextIdx]);
  };

  const handleDownloadSingle = async (song: SongState) => {
    if (!user) return;
    setGlobalError(null);
    try {
      const idToken = await user.getIdToken();
      const blob = await fetchStorageWavBlob(song, idToken);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = song.file_name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : `Failed to download ${song.file_name}`);
    }
  };

  const generateSingleSong = async (
    songNumber: number
  ): Promise<{ ok: boolean; stopBatch?: boolean }> => {
    if (!user) {
      setGlobalError("Please sign in with Google first.");
      return { ok: false, stopBatch: true };
    }

    const song = songs.find((s) => s.number === songNumber);
    if (!song) return { ok: false };

    const lyricCheck = validateLyrics(song.lines);
    if (!lyricCheck.valid) {
      setGlobalError(
        `Cannot generate #${songNumber} (${song.file_name}) until lyric rule warnings are fixed: ${lyricCheck.errors.join(" ")}`
      );
      return { ok: false };
    }

    const hadExistingReady = song.status === "ready" && Boolean(song.storage_path);
    setGlobalError(null);
    setGeneratingNumbers((prev) => new Set(prev).add(songNumber));

    let backupPath: string | null = null;

    try {
      const idToken = await user.getIdToken();

      // Step 1: Generate, master, and run Gemini vocal quality checks on server (ephemeral /tmp only)
      const res = await fetch(`/api/songs/${songNumber}/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          feeling_key: song.feeling_key,
          title: song.title,
          theme: song.theme,
          lines: song.lines,
          mood: song.mood,
          tempo_bpm: song.tempo_bpm,
          instruments: song.instruments,
          vocal_tone: song.vocal_tone,
          model,
        }),
      });

      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as { error?: string };
        const msg = errData.error || `Generation failed (HTTP ${res.status})`;

        if (res.status === 404 || res.status === 403 || res.status === 429 || res.status === 401) {
          setGlobalError(msg);
        }

        // Never lose an existing good song if regenerate fails
        if (!hadExistingReady) {
          try {
            await updateDoc(doc(db, "songs", String(songNumber)), {
              status: "error",
              error_message: msg.slice(0, 990),
            });
          } catch (fsErr) {
            reportFirestoreError(fsErr, OperationType.UPDATE, `songs/${songNumber}`);
          }
        } else {
          setGlobalError(`Regenerate failed for #${songNumber} (previous good WAV preserved): ${msg}`);
        }

        return {
          ok: false,
          stopBatch: res.status === 404 || res.status === 403 || res.status === 401,
        };
      }

      const wavBlob = await res.blob();
      const durationSeconds = Number(res.headers.get("X-Duration-Seconds") || "0");
      const lufs = Number(res.headers.get("X-Lufs") || "-14");
      const truePeakDb = Number(res.headers.get("X-True-Peak-Db") || "-1");
      const modelUsed = res.headers.get("X-Model-Used") || model;
      const qualityReport = decodeQualityReportHeader(res.headers.get("X-Quality-Report"));

      // Step 2: If regenerating, back up the old WAV to songs/old/<file_name>-<date>.wav
      if (hadExistingReady && song.storage_path) {
        const oldBlob = await fetchStorageWavBlob(song, idToken);
        const dateTag = new Date().toISOString().replace(/[:.]/g, "-");
        backupPath = `songs/old/${song.file_name}-${dateTag}.wav`;
        await uploadBytes(ref(storage, backupPath), oldBlob, {
          contentType: "audio/wav",
        });
      }

      // Step 3: Upload the final WAV to Cloud Storage at songs/<file_name> FIRST
      const targetPath = `songs/${song.file_name}`;
      const targetRef = ref(storage, targetPath);
      await uploadBytes(targetRef, wavBlob, {
        contentType: "audio/wav",
      });
      const downloadUrl = await getDownloadURL(targetRef);

      // Step 4: Only after Cloud Storage upload succeeds, mark "ready" and save quality results in Firestore
      const generatedAt = new Date().toISOString();
      try {
        await updateDoc(doc(db, "songs", String(songNumber)), {
          status: "ready",
          model_used: modelUsed,
          duration_seconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
          lufs: Number.isFinite(lufs) ? lufs : -14,
          true_peak_db: Number.isFinite(truePeakDb) ? truePeakDb : -1,
          storage_path: targetPath,
          download_url: downloadUrl,
          generated_at: generatedAt,
          error_message: null,
          words_heard_pct: qualityReport ? qualityReport.words_heard_pct : null,
          transcribed_text: qualityReport?.transcribed_text
            ? qualityReport.transcribed_text.slice(0, 1900)
            : null,
          missing_words: (qualityReport?.missing_words ?? []).slice(0, 50),
          extra_words: (qualityReport?.extra_words ?? []).slice(0, 50),
          voice_start_seconds: qualityReport ? qualityReport.voice_start_seconds : null,
          voice_end_seconds: qualityReport ? qualityReport.voice_end_seconds : null,
        });
      } catch (fsErr) {
        reportFirestoreError(fsErr, OperationType.UPDATE, `songs/${songNumber}`);
      }

      // Step 5: Remove temporary backup once the new song is safely marked ready
      if (backupPath) {
        await deleteObject(ref(storage, backupPath)).catch(() => {});
      }

      return { ok: true };
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed during generation or Cloud Storage upload";
      setGlobalError(
        hadExistingReady
          ? `Regenerate failed for #${songNumber} (previous good WAV preserved): ${msg}`
          : msg
      );
      if (!hadExistingReady) {
        try {
          await updateDoc(doc(db, "songs", String(songNumber)), {
            status: "error",
            error_message: msg.slice(0, 990),
          });
        } catch (fsErr) {
          reportFirestoreError(fsErr, OperationType.UPDATE, `songs/${songNumber}`);
        }
      }
      return { ok: false };
    } finally {
      setGeneratingNumbers((prev) => {
        const next = new Set(prev);
        next.delete(songNumber);
        return next;
      });
    }
  };

  const handleGenerateBatch = async (onlyPending: boolean) => {
    const candidates = onlyPending ? pendingSongs : songs;
    const targets = candidates.filter((s) => validateLyrics(s.lines).valid);
    if (isBatchRunning || !user) return;
    if (targets.length === 0) {
      setGlobalError(
        "No songs currently pass the admin lyric rules (6 lines, max 5 words/line, no forbidden words, numbers, prices, or brands). Fix the red warnings first."
      );
      return;
    }

    cancelBatchRef.current = false;
    setIsBatchRunning(true);
    setGlobalError(null);
    setBatchProgress({ done: 0, total: targets.length });

    let completed = 0;
    for (const target of targets) {
      if (cancelBatchRef.current) break;
      setBatchCurrentNumber(target.number);
      const result = await generateSingleSong(target.number);
      if (result.stopBatch) {
        break;
      }
      completed += 1;
      setBatchProgress({ done: completed, total: targets.length });
    }

    setBatchCurrentNumber(null);
    setIsBatchRunning(false);
  };

  const handleStopBatch = () => {
    cancelBatchRef.current = true;
  };

  const handleChangeAdminFeeling = async (songNumber: number, adminFeeling: AdminFeeling) => {
    if (!user) return;
    const docPath = `songs/${songNumber}`;
    try {
      await updateDoc(doc(db, "songs", String(songNumber)), {
        admin_feeling: adminFeeling,
      });
    } catch (err) {
      reportFirestoreError(err, OperationType.UPDATE, docPath);
    }
  };

  // Save lyric, admin_feeling & music edits directly to Firestore right away
  const handleSaveEdit = async (
    songNumber: number,
    updates: {
      title: string;
      lines: string[];
      mood: string;
      tempo_bpm: number;
      instruments: string;
      admin_feeling: AdminFeeling;
    }
  ) => {
    if (!user) return;
    const docPath = `songs/${songNumber}`;
    const sanitizedLines = updates.lines
      .slice(0, 8)
      .map((l) => l.trim().slice(0, 240));
    try {
      await updateDoc(doc(db, "songs", String(songNumber)), {
        title: updates.title.trim().slice(0, 120),
        lines: sanitizedLines.length > 0 ? sanitizedLines : [""],
        mood: updates.mood.trim().slice(0, 80),
        tempo_bpm: Math.min(100, Math.max(70, Math.round(updates.tempo_bpm))),
        instruments: updates.instruments.trim().slice(0, 300),
        admin_feeling: updates.admin_feeling,
      });
    } catch (err) {
      reportFirestoreError(err, OperationType.UPDATE, docPath);
    }
  };

  const handleResetLyrics = async () => {
    if (isBatchRunning || !user) return;
    try {
      const batch = writeBatch(db);
      for (const spec of INITIAL_SONGS) {
        batch.update(doc(db, "songs", String(spec.number)), {
          title: spec.title,
          theme: spec.theme,
          lines: spec.lines,
          mood: spec.mood,
          tempo_bpm: spec.tempo_bpm,
          instruments: spec.instruments,
          vocal_tone: spec.vocal_tone,
          admin_feeling:
            DEFAULT_ADMIN_FEELING_BY_KEY[spec.feeling_key] ?? "family_evening",
        });
      }
      await batch.commit();
    } catch (err) {
      reportFirestoreError(err, OperationType.WRITE, "songs");
    }
  };

  // Build ZIP and songs.json from Firestore + Cloud Storage
  const handleDownloadAll = async () => {
    if (!user || readySongs.length === 0 || downloadingZip) return;
    setDownloadingZip(true);
    setZipProgress(`0/${readySongs.length}`);
    setGlobalError(null);

    try {
      const idToken = await user.getIdToken();
      const zip = new JSZip();

      zip.file("songs.json", JSON.stringify(manifestPreview, null, 2), {
        compression: "DEFLATE",
      });

      let fetched = 0;
      const concurrency = 4;
      for (let i = 0; i < readySongs.length; i += concurrency) {
        const batch = readySongs.slice(i, i + concurrency);
        await Promise.all(
          batch.map(async (song) => {
            const wavBlob = await fetchStorageWavBlob(song, idToken);
            const buf = await wavBlob.arrayBuffer();
            zip.file(song.file_name, buf, { compression: "STORE" });
            fetched += 1;
            setZipProgress(`${fetched}/${readySongs.length}`);
          })
        );
      }

      setZipProgress("Building ZIP…");
      const blob = await zip.generateAsync({
        type: "blob",
        compression: "STORE",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "darija-family-songs-pack.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "Failed to generate ZIP archive");
    } finally {
      setDownloadingZip(false);
      setZipProgress(null);
    }
  };

  const handleDownloadSongsJson = () => {
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
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  if (fatalError) {
    throw fatalError;
  }

  if (!authReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F8F8F6] text-sm text-[#57554F]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin text-[#1B3B6F]" />
        Initializing studio…
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-screen flex-col bg-[#F8F8F6] text-[#141413]">
        <header className="border-b border-[#E5E4DF] bg-white">
          <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-8 px-6 py-3.5">
            <span className="text-lg font-bold tracking-tight text-[#141413] whitespace-nowrap shrink-0">
              Darija Reel Studio
            </span>
            <span className="text-xs text-[#6E6C66] whitespace-nowrap shrink-0">
              Firebase + Cloud Storage Studio
            </span>
            <button
              type="button"
              onClick={handleSignIn}
              disabled={authLoading}
              className="inline-flex items-center gap-2 rounded-lg bg-[#1B3B6F] px-4 py-2 text-xs font-semibold text-white hover:bg-[#152E57] disabled:opacity-60 whitespace-nowrap shrink-0"
            >
              <LogIn className="h-3.5 w-3.5" />
              {authLoading ? "Signing in…" : "Sign in with Google"}
            </button>
          </div>
        </header>

        <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-16">
          <div className="rounded-xl border border-[#E5E4DF] bg-white p-8">
            <p className="text-xs font-medium text-[#1B3B6F]">
              Persistent Moroccan Darija Song Studio
            </p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-[#141413]">
              Sign in with Google to open your 20-song studio
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-[#57554F]">
              Your 20 Darija lyrics, edit history, and mastered 44.1 kHz WAV files are stored permanently in Firestore and Cloud Storage so every track survives republishing. Only signed-in users can edit lyrics, generate audio, or download your ZIP pack.
            </p>

            {globalError && (
              <div className="mt-4 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-xs text-[#991B1B]">
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
              {authLoading ? "Signing in with Google…" : "Sign in with Google"}
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8F8F6] text-[#141413]">
      {/* Hidden shared HTML5 audio element (streams directly from Cloud Storage) */}
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
                  ? `Packaging ZIP (${zipProgress ?? "…"})`
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
                Synced to Firestore &amp; Cloud Storage · Signed in as {user.email}
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
                        onClick={() =>
                          handleGenerateBatch(pendingSongs.length > 0 && readySongs.length > 0)
                        }
                        disabled={loading || songs.length === 0 || validSongsCount === 0}
                        className="inline-flex items-center gap-2 rounded-lg bg-[#1B3B6F] px-4 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-[#152E57] disabled:opacity-50 whitespace-nowrap shrink-0"
                      >
                        <Sparkles className="h-4 w-4" />
                        {validSongsCount === 0
                          ? "Fix lyric rules to generate"
                          : readySongs.length === 20
                          ? `Regenerate valid songs (${validSongsCount})`
                          : readySongs.length > 0
                          ? `Generate valid remaining (${pendingSongs.filter((s) => validateLyrics(s.lines).valid).length})`
                          : `Generate valid songs (${validSongsCount}/20)`}
                      </button>

                      {readySongs.length > 0 && readySongs.length < 20 && validSongsCount > 0 && (
                        <button
                          type="button"
                          onClick={() => handleGenerateBatch(false)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-[#D4D2CA] bg-white px-3.5 py-2.5 text-xs font-medium text-[#3F3E39] hover:border-[#1B3B6F] hover:text-[#1B3B6F] whitespace-nowrap shrink-0"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          Regenerate all valid ({validSongsCount})
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
                      onClick={() => setModel("lyria-3.5")}
                      className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        model === "lyria-3.5"
                          ? "bg-white text-[#141413] shadow-xs"
                          : "text-[#57554F] hover:text-[#141413]"
                      }`}
                    >
                      Lyria 3.5 (~40s)
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

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleResetLyrics}
                    disabled={isBatchRunning}
                    className="rounded-md px-2.5 py-1.5 text-xs font-medium text-[#6E6C66] hover:text-[#141413] disabled:opacity-40 whitespace-nowrap shrink-0"
                  >
                    Reset default lyrics
                  </button>
                  <button
                    type="button"
                    onClick={handleSignOut}
                    disabled={isBatchRunning}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[#E5E4DF] px-2.5 py-1.5 text-xs font-medium text-[#57554F] hover:border-[#D4D2CA] hover:text-[#141413] disabled:opacity-40 whitespace-nowrap shrink-0"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Sign out
                  </button>
                </div>
              </div>

              {/* Batch Progress Bar */}
              {isBatchRunning && (
                <div className="border-t border-[#ECEBE6] pt-3">
                  <div className="mb-1.5 flex items-center justify-between text-xs">
                    <span className="font-medium text-[#1B3B6F]">
                      {batchCurrentNumber
                        ? `Generating & uploading track #${String(batchCurrentNumber).padStart(2, "0")}…`
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
                  Loading 20 Moroccan Darija songs from Firestore…
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
                    isGenerating={generatingNumbers.has(song.number)}
                    currentTime={currentTime}
                    duration={duration}
                    isBatchRunning={isBatchRunning}
                    onTogglePlay={(s) => {
                      void handleTogglePlay(s);
                    }}
                    onSeek={handleSeek}
                    onGenerate={(num) => {
                      void generateSingleSong(num);
                    }}
                    onDownloadSingle={(s) => {
                      void handleDownloadSingle(s);
                    }}
                    onChangeAdminFeeling={handleChangeAdminFeeling}
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
                    ZIP Export Manifest (songs.json + Cloud Storage WAV files)
                  </h2>
                  <p className="mt-1 text-sm text-[#57554F]">
                    Built directly from Firestore metadata and Firebase Cloud Storage (<span className="font-mono text-xs">songs/01-…</span> to <span className="font-mono text-xs">songs/20-…</span>).
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleDownloadAll}
                  disabled={readySongs.length === 0 || downloadingZip}
                  className="inline-flex items-center gap-2 rounded-lg bg-[#1B3B6F] px-4 py-2 text-xs font-semibold text-white hover:bg-[#152E57] disabled:bg-[#D4D2CA] disabled:text-[#6E6C66] whitespace-nowrap shrink-0"
                >
                  <Archive className="h-4 w-4" />
                  {downloadingZip
                    ? `Packaging ZIP (${zipProgress ?? "…"})`
                    : `Download ZIP (${readySongs.length}/20 WAVs ready)`}
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
                    Live songs.json preview (from Firestore)
                  </span>
                  <button
                    type="button"
                    onClick={handleDownloadSongsJson}
                    className="inline-flex items-center gap-1.5 font-mono text-xs text-[#1B3B6F] hover:underline"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download songs.json
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

        {activeTab === "rules" && (
          <section className="grid gap-6 md:grid-cols-2">
            <div className="rounded-xl border border-[#E5E4DF] bg-white p-6">
              <h2 className="text-base font-semibold text-[#141413]">
                Admin Lyric &amp; Vocal Quality Rules
              </h2>
              <ul className="mt-4 space-y-2.5 text-sm leading-relaxed text-[#57554F]">
                <li>Everyday Moroccan Darija written in Arabic script only—no French, English, numbers, prices, brands, or product names.</li>
                <li>Exactly 6 lines per song, max 5 words per line; songs failing rules show red warnings and cannot be generated until fixed.</li>
                <li>Forbidden words blocked: عيد، رمضان، اليوم، أحسن، لمة، طفا، نقيين، الصابون، البرنامج، بلاصتها، ليل ونهار.</li>
                <li>After generation, Gemini transcribes the sung words, reports words heard % (warns under 90%) + missing/extra words, and checks voice start (warns &gt; 1s) and voice end (warns &gt; 27s).</li>
              </ul>
            </div>

            <div className="rounded-xl border border-[#E5E4DF] bg-white p-6">
              <h2 className="text-base font-semibold text-[#141413]">
                Cloud Persistence &amp; Broadcast Mastering
              </h2>
              <ul className="mt-4 space-y-2.5 text-sm leading-relaxed text-[#57554F]">
                <li>Firestore collection <span className="font-mono text-xs">songs</span> (docs 1–20) persists lyrics, <span className="font-mono text-xs">admin_feeling</span>, transcription metrics, voice timing, LUFS, and storage paths across deploys.</li>
                <li>Mastered WAVs upload first to Cloud Storage (<span className="font-mono text-xs">songs/&lt;file_name&gt;</span>) before Firestore is marked ready.</li>
                <li>Regenerate backs up the previous WAV to <span className="font-mono text-xs">songs/old/&lt;file_name&gt;-&lt;date&gt;.wav</span> until the replacement succeeds.</li>
                <li>Two-pass EBU R128 mastering via FFmpeg: ~-14 LUFS integrated loudness, true peaks capped at -1.0 dBTP, exported as 44.1 kHz 16-bit PCM WAV.</li>
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
