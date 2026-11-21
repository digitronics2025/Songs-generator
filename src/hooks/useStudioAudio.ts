import { useEffect, useRef, useState } from "react";
import { formatSongFilename, type SongState, type SongTake } from "../data/songs";
import { studioAudio } from "../lib/api";

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function useStudioAudio(setError: (error: string) => void, enabled: boolean) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [activeSongNumber, setActiveSongNumber] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const url = useRef<string | null>(null);
  const track = useRef<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => {
    request.current?.abort();
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
    track.current = null;
  }, [enabled]);

  const handleTogglePlay = async (song: SongState, take?: SongTake) => {
    const audio = audioRef.current;
    if (!audio) return;
    const path = take ? take.storage_path ?? take.raw_storage_path : song.storage_path;
    const key = song.id + ":" + path;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      if (track.current === key) {
        if (audio.paused) await audio.play();
        else audio.pause();
        return;
      }
      const blob = await studioAudio(path, controller.signal);
      if (controller.signal.aborted) return;
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = URL.createObjectURL(blob);
      track.current = key;
      audio.src = url.current;
      setActiveSongNumber(song.number);
      setCurrentTime(0);
      setDuration(0);
      await audio.play();
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Playback failed.");
    }
  };
  const handleSeek = (time: number) => {
    const element = audioRef.current;
    if (element && Number.isFinite(element.duration)) element.currentTime = time;
  };
  const handleDownloadSingle = async (song: SongState, take?: SongTake) => {
    try {
      const path = take ? take.storage_path ?? take.raw_storage_path : song.storage_path;
      const blob = await studioAudio(path);
      const name = song.file_name ?? formatSongFilename(song.number, song.feeling_key);
      const ext = path?.endsWith(".mp3") ? ".mp3" : ".wav";
      saveBlob(blob, take ? name.replace(/\.[^.]+$/, "") + "-take-" + take.take_number + ext : name.replace(/\.[^.]+$/, "") + ext);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Download failed.");
    }
  };
  return { audioRef, activeSongNumber, isPlaying, currentTime, duration, setIsPlaying, setCurrentTime, setDuration,
    handleTogglePlay, handleSeek, handleDownloadSingle };
}
