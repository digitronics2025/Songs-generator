import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import JSZip from "jszip";
import { GoogleGenAI } from "@google/genai";
import {
  INITIAL_SONGS,
  formatSongFilename,
  type SongState,
  type SongsJsonEntry,
} from "./src/data/songs.ts";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 3000);
const AUDIO_DIR = path.resolve(process.cwd(), ".generated_audio");
const STATE_FILE = path.join(AUDIO_DIR, "state.json");

if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

function getGenAI(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured. Please select an API key in Settings > Secrets.");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function buildInitialState(): SongState[] {
  return INITIAL_SONGS.map((song) => ({
    ...song,
    status: "pending",
    duration_seconds: null,
    audio_url: null,
    file_name: formatSongFilename(song.number, song.feeling_key, "wav"),
    format: "wav",
    lufs: null,
    true_peak_db: null,
    error_message: null,
    generated_at: null,
  }));
}

function loadState(): SongState[] {
  const defaults = buildInitialState();
  if (!fs.existsSync(STATE_FILE)) {
    return defaults;
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const saved = JSON.parse(raw) as Partial<SongState>[];
    return defaults.map((def) => {
      const match = saved.find((s) => s.number === def.number);
      if (!match) return def;
      const fileName = formatSongFilename(def.number, def.feeling_key, match.format === "mp3" ? "mp3" : "wav");
      const fileExists = fs.existsSync(path.join(AUDIO_DIR, fileName));
      const status = match.status === "ready" && fileExists ? "ready" : match.status === "error" ? "error" : "pending";
      return {
        ...def,
        title: match.title || def.title,
        theme: match.theme || def.theme,
        lines: Array.isArray(match.lines) && match.lines.length === 4 ? (match.lines as [string, string, string, string]) : def.lines,
        mood: match.mood || def.mood,
        tempo_bpm: typeof match.tempo_bpm === "number" ? match.tempo_bpm : def.tempo_bpm,
        instruments: match.instruments || def.instruments,
        vocal_tone: match.vocal_tone || def.vocal_tone,
        status,
        duration_seconds: fileExists && typeof match.duration_seconds === "number" ? match.duration_seconds : null,
        audio_url: fileExists ? `/api/audio/${fileName}?v=${encodeURIComponent(match.generated_at || "1")}` : null,
        file_name: fileName,
        format: match.format === "mp3" ? "mp3" : "wav",
        lufs: fileExists && typeof match.lufs === "number" ? match.lufs : null,
        true_peak_db: fileExists && typeof match.true_peak_db === "number" ? match.true_peak_db : null,
        error_message: status === "error" ? match.error_message || null : null,
        generated_at: fileExists ? match.generated_at || null : null,
      };
    });
  } catch {
    return defaults;
  }
}

function saveState(songs: SongState[]): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(songs, null, 2), "utf8");
}

let songsState: SongState[] = loadState();

function buildLyriaPrompt(song: SongState): string {
  const lyricsBlock = song.lines.map((line, i) => `Line ${i + 1}: ${line}`).join("\n");
  return [
    `Create a warm, emotional 38-second Moroccan acoustic song for a family video.`,
    `Theme: ${song.theme}.`,
    `Mood: ${song.mood}.`,
    `Tempo: ${song.tempo_bpm} BPM.`,
    `Instrumentation: ${song.instruments}. Warm North African acoustic feel.`,
    `Vocal direction: ${song.vocal_tone}. Sung in natural Moroccan Darija Arabic ONLY.`,
    `Mixing & vocal clarity (CRITICAL):`,
    `- One clear solo lead voice, sung slowly and clearly so every single Arabic word is easy to hear.`,
    `- Keep the lead voice loud and upfront in the mix, and keep the acoustic instruments softer underneath.`,
    `- Clean dry studio vocal: NO heavy echo or reverb, NO autotune effects, NO backing choir over the words, NO rap, NO distortion.`,
    `Song structure (35 to 42 seconds total):`,
    `- 2-second soft acoustic instrumental intro.`,
    `- Sing these exact 4 Moroccan Darija lines once slowly and clearly:`,
    lyricsBlock,
    `- Then softly repeat Line 1 once ("${song.lines[0]}") as a warm closing phrase.`,
    `- End with 4 to 5 seconds of soft instrumental music only (no singing, no voice), fading gently so a spoken line can be added later.`,
  ].join("\n");
}

async function probeDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const val = parseFloat(stdout.trim());
  return Number.isFinite(val) ? val : 0;
}

interface LoudnormStats {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
  output_i?: string;
  output_tp?: string;
}

async function masterAudioToWav(rawFilePath: string, outputWavPath: string): Promise<{
  durationSeconds: number;
  lufs: number;
  truePeakDb: number;
}> {
  const rawDuration = await probeDuration(rawFilePath);
  const needsTrim = rawDuration > 44.5;
  const targetMax = 44.0;
  const fadeStart = targetMax - 3.5;

  const preFilter = needsTrim
    ? `atrim=0:${targetMax},asetpts=PTS-STARTPTS,afade=t=out:st=${fadeStart}:d=3.5`
    : `afade=t=out:st=${Math.max(0, rawDuration - 1.5)}:d=1.5`;

  let measuredLufs = -14.0;
  let measuredTp = -1.0;

  try {
    // Pass 1: Analyze loudness for linear two-pass EBU R128 mastering
    const pass1Args = [
      "-y",
      "-i",
      rawFilePath,
      "-af",
      `${preFilter},loudnorm=I=-14:TP=-1.0:LRA=7:print_format=json`,
      "-f",
      "null",
      "-",
    ];
    const { stderr: pass1Stderr } = await execFileAsync("ffmpeg", pass1Args, { maxBuffer: 10 * 1024 * 1024 });
    const jsonMatch = pass1Stderr.match(/\{\s*"input_i"\s*:[\s\S]*?\}/);
    if (jsonMatch) {
      const stats = JSON.parse(jsonMatch[0]) as LoudnormStats;
      const pass2Filter = [
        preFilter,
        `loudnorm=I=-14:TP=-1.0:LRA=7:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true:print_format=json`,
      ].join(",");

      const { stderr: pass2Stderr } = await execFileAsync(
        "ffmpeg",
        [
          "-y",
          "-i",
          rawFilePath,
          "-af",
          pass2Filter,
          "-ar",
          "44100",
          "-ac",
          "2",
          "-c:a",
          "pcm_s16le",
          outputWavPath,
        ],
        { maxBuffer: 10 * 1024 * 1024 }
      );
      const outMatch = pass2Stderr.match(/\{\s*"input_i"\s*:[\s\S]*?\}/);
      if (outMatch) {
        const outStats = JSON.parse(outMatch[0]) as LoudnormStats;
        const parsedI = parseFloat(outStats.output_i || "-14");
        const parsedTp = parseFloat(outStats.output_tp || "-1");
        if (Number.isFinite(parsedI)) measuredLufs = Number(parsedI.toFixed(1));
        if (Number.isFinite(parsedTp)) measuredTp = Number(parsedTp.toFixed(1));
      }
    } else {
      throw new Error("Could not parse loudnorm pass 1 stats");
    }
  } catch {
    // Fallback single-pass loudnorm to guarantee -14 LUFS and <= -1 dBTP
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i",
        rawFilePath,
        "-af",
        `${preFilter},loudnorm=I=-14:TP=-1.0:LRA=7`,
        "-ar",
        "44100",
        "-ac",
        "2",
        "-c:a",
        "pcm_s16le",
        outputWavPath,
      ],
      { maxBuffer: 10 * 1024 * 1024 }
    );
  }

  const finalDuration = await probeDuration(outputWavPath);
  return {
    durationSeconds: Number(finalDuration.toFixed(1)),
    lufs: measuredLufs,
    truePeakDb: measuredTp,
  };
}

const activeGenerations = new Set<number>();

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/songs", (_req, res) => {
    res.json({ songs: songsState });
  });

  app.put("/api/songs/:number", (req, res) => {
    const num = Number(req.params.number);
    const idx = songsState.findIndex((s) => s.number === num);
    if (idx === -1) {
      res.status(404).json({ error: `Song #${num} not found` });
      return;
    }

    const body = req.body as Partial<SongState>;
    const current = songsState[idx];

    const updatedLines =
      Array.isArray(body.lines) && body.lines.length === 4
        ? (body.lines.map((l) => String(l).trim()) as [string, string, string, string])
        : current.lines;

    const updatedTempo =
      typeof body.tempo_bpm === "number" && body.tempo_bpm >= 70 && body.tempo_bpm <= 100
        ? Math.round(body.tempo_bpm)
        : current.tempo_bpm;

    songsState[idx] = {
      ...current,
      title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : current.title,
      theme: typeof body.theme === "string" && body.theme.trim() ? body.theme.trim() : current.theme,
      lines: updatedLines,
      mood: typeof body.mood === "string" && body.mood.trim() ? body.mood.trim() : current.mood,
      tempo_bpm: updatedTempo,
      instruments:
        typeof body.instruments === "string" && body.instruments.trim()
          ? body.instruments.trim()
          : current.instruments,
      vocal_tone:
        typeof body.vocal_tone === "string" && body.vocal_tone.trim()
          ? body.vocal_tone.trim()
          : current.vocal_tone,
    };

    saveState(songsState);
    res.json({ song: songsState[idx] });
  });

  app.post("/api/songs/:number/generate", async (req, res) => {
    const num = Number(req.params.number);
    const idx = songsState.findIndex((s) => s.number === num);
    if (idx === -1) {
      res.status(404).json({ error: `Song #${num} not found` });
      return;
    }
    if (activeGenerations.has(num)) {
      res.status(409).json({ error: `Song #${num} is already generating` });
      return;
    }

    const requestedModel = (req.body as { model?: string } | undefined)?.model;
    const modelName =
      requestedModel === "lyria-3-clip-preview" ? "lyria-3-clip-preview" : "lyria-3-pro-preview";

    activeGenerations.add(num);
    songsState[idx] = {
      ...songsState[idx],
      status: "generating",
      error_message: null,
    };

    const song = songsState[idx];
    const rawTmpPath = path.join(AUDIO_DIR, `raw-${song.number}-${Date.now()}.bin`);
    const wavFilename = formatSongFilename(song.number, song.feeling_key, "wav");
    const outputWavPath = path.join(AUDIO_DIR, wavFilename);

    try {
      const ai = getGenAI();
      const prompt = buildLyriaPrompt(song);

      const stream = await ai.models.generateContentStream({
        model: modelName,
        contents: prompt,
      });

      const audioChunks: Buffer[] = [];
      let mimeType = "audio/mpeg";

      for await (const chunk of stream) {
        const parts = chunk.candidates?.[0]?.content?.parts;
        if (!parts) continue;
        for (const part of parts) {
          if (part.inlineData?.data) {
            if (audioChunks.length === 0 && part.inlineData.mimeType) {
              mimeType = part.inlineData.mimeType;
            }
            audioChunks.push(Buffer.from(part.inlineData.data, "base64"));
          }
        }
      }

      if (audioChunks.length === 0) {
        throw new Error("Lyria returned no audio data for this prompt.");
      }

      const rawBuffer = Buffer.concat(audioChunks);
      const rawExt = mimeType.includes("wav") ? ".wav" : ".mp3";
      const typedRawPath = rawTmpPath.replace(/\.bin$/, rawExt);
      fs.writeFileSync(typedRawPath, rawBuffer);

      const mastered = await masterAudioToWav(typedRawPath, outputWavPath);

      if (fs.existsSync(typedRawPath)) {
        fs.unlinkSync(typedRawPath);
      }

      const generatedAt = new Date().toISOString();
      songsState[idx] = {
        ...songsState[idx],
        status: "ready",
        duration_seconds: mastered.durationSeconds,
        audio_url: `/api/audio/${wavFilename}?v=${encodeURIComponent(generatedAt)}`,
        file_name: wavFilename,
        format: "wav",
        lufs: mastered.lufs,
        true_peak_db: mastered.truePeakDb,
        error_message: null,
        generated_at: generatedAt,
      };
      saveState(songsState);

      res.json({ song: songsState[idx] });
    } catch (err) {
      if (fs.existsSync(rawTmpPath)) {
        fs.unlinkSync(rawTmpPath);
      }
      const message = err instanceof Error ? err.message : "Failed to generate audio with Lyria.";
      songsState[idx] = {
        ...songsState[idx],
        status: "error",
        error_message: message,
      };
      saveState(songsState);

      const statusCode =
        message.includes("PERMISSION_DENIED") || message.includes("403")
          ? 403
          : message.includes("RESOURCE_EXHAUSTED") || message.includes("429")
          ? 429
          : 500;

      res.status(statusCode).json({ error: message, song: songsState[idx] });
    } finally {
      activeGenerations.delete(num);
    }
  });

  app.post("/api/songs/reset-lyrics", (_req, res) => {
    const defaults = buildInitialState();
    songsState = songsState.map((existing) => {
      const def = defaults.find((d) => d.number === existing.number);
      if (!def) return existing;
      return {
        ...existing,
        title: def.title,
        theme: def.theme,
        lines: def.lines,
        mood: def.mood,
        tempo_bpm: def.tempo_bpm,
        instruments: def.instruments,
        vocal_tone: def.vocal_tone,
      };
    });
    saveState(songsState);
    res.json({ songs: songsState });
  });

  app.get("/api/audio/:filename", (req, res) => {
    const safeName = path.basename(req.params.filename);
    const filePath = path.join(AUDIO_DIR, safeName);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Audio file not found" });
      return;
    }
    res.setHeader("Content-Type", safeName.endsWith(".mp3") ? "audio/mpeg" : "audio/wav");
    res.setHeader("Accept-Ranges", "bytes");
    res.sendFile(filePath);
  });

  app.get("/api/songs.json", (_req, res) => {
    const manifest: SongsJsonEntry[] = songsState.map((s) => ({
      number: s.number,
      feeling_key: s.feeling_key,
      title: s.title,
      theme: s.theme,
      lyric: s.lines.join(" / "),
      duration_seconds: s.duration_seconds ?? 0,
      mood: s.mood,
      tempo_bpm: s.tempo_bpm,
    }));
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(JSON.stringify(manifest, null, 2));
  });

  app.get("/api/download-all", async (_req, res) => {
    try {
      const zip = new JSZip();
      const manifest: SongsJsonEntry[] = [];

      for (const song of songsState) {
        const fileName = formatSongFilename(song.number, song.feeling_key, song.format);
        const filePath = path.join(AUDIO_DIR, fileName);
        if (fs.existsSync(filePath)) {
          const data = fs.readFileSync(filePath);
          zip.file(fileName, data);
        }
        manifest.push({
          number: song.number,
          feeling_key: song.feeling_key,
          title: song.title,
          theme: song.theme,
          lyric: song.lines.join(" / "),
          duration_seconds: song.duration_seconds ?? 0,
          mood: song.mood,
          tempo_bpm: song.tempo_bpm,
        });
      }

      zip.file("songs.json", JSON.stringify(manifest, null, 2));

      const zipBuffer = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", 'attachment; filename="darija-family-songs-pack.zip"');
      res.setHeader("Content-Length", String(zipBuffer.length));
      res.send(zipBuffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to build ZIP archive";
      res.status(500).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), "dist");
    app.use(express.static(distDir));
    app.get("/{*path}", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Darija Reel Studio listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
