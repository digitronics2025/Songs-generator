import { onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_STUDIO_SETTINGS, type SongHistoryItem, type SongState, type StudioSettings } from "../data/songs";
import { ApiError, studioApi } from "../lib/api";
import { auth, googleProvider } from "../lib/firebase";

interface Library {
  songs: SongState[];
  settings: StudioSettings;
  history: SongHistoryItem[];
}

export function useStudio() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [catalog, setCatalog] = useState<Library | null>(null);
  const [loading, setLoading] = useState(true);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!auth.currentUser) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    try {
      const data = await studioApi<Library>("/library", "GET", undefined, controller.signal);
      if (!controller.signal.aborted) {
        setCatalog(data);
        setLibraryError(null);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Could not load the studio library.";
      if (error instanceof ApiError && error.status === 403) {
        await signOut(auth);
        setGlobalError(message);
      } else {
        setLibraryError(message);
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (current) => {
      pending.current?.abort();
      setCatalog(null);
      setLibraryError(null);
      setUser(current);
      setAuthReady(true);
      setLoading(Boolean(current));
      if (current) void refresh();
    });
    return () => {
      pending.current?.abort();
      unsubscribe();
    };
  }, [refresh]);

  const handleSignIn = async () => {
    setAuthLoading(true);
    setGlobalError(null);
    try { await signInWithPopup(auth, googleProvider); }
    catch (error) { setGlobalError(error instanceof Error ? error.message : "Google sign-in failed."); }
    finally { setAuthLoading(false); }
  };
  return { user, authReady, authLoading, handleSignIn, handleSignOut: () => signOut(auth),
    songs: catalog?.songs ?? [], historyItems: catalog?.history ?? [], settings: catalog?.settings ?? DEFAULT_STUDIO_SETTINGS,
    loading, libraryLoaded: catalog !== null, libraryError, globalError, setGlobalError, refresh };
}
