import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import ffmpegStatic from "ffmpeg-static";
import { GoogleGenAI, Type } from "@google/genai";
import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { INITIAL_SONGS, type SongSpec } from "./src/data/songs.ts";
import {
  compareTranscriptInOrder,
  validateLyrics,
} from "./src/lib/lyricQuality.ts";

const execFileAsync = promisify(execFile);
const FFMPEG_BIN =
  typeof ffmpegStatic === "string" && fs.existsSync(ffmpegStatic)
    ? ffmpegStatic
    : "ffmpeg";

const PORT = Number(process.env.PORT || 3000);

const firebaseConfig = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "firebase-applet-config.json"), "utf8")
) as { projectId: string; storageBucket: string };

const adminApp = getApps().length
  ? getApp()
  : initializeApp({ projectId: firebaseConfig.projectId });
const adminAuth = getAuth(adminApp);

interface AuthenticatedRequest extends Request {
  user?: {
    uid: string;
    email: string;
  };
}

async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required. Please sign in with Google." });
    return;
  }
  const idToken = header.slice("Bearer ".length).trim();
  if (!idToken) {
    res.status(401).json({ error: "Authentication token missing." });
    return;
  }
  try {
    const decoded = await adminAuth.verifyIdToken(idToken);
    if (!decoded.email_verified) {
      res.status(403).json({ error: "Verified Google email is required." });
      return;
    }
    req.user = {
      uid: decoded.uid,
      email: decoded.email || "",
    };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired sign-in session. Please sign in again." });
  }
}

function getGenAI(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured. Please select an API key in Settings > Secrets.");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      apiVersion: "v1beta",
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function buildLyriaPrompt(song: SongSpec): string {
  const lyricsBlock = song.lines.join("\n");
  return [
    `Moroccan acoustic family song, length about 40 seconds, ending with 4-5 seconds of soft instrumental only.`,
    `Start singing immediately within the first 1 second (no long instrumental intro) and finish all vocals before 27 seconds, followed by soft instrumental only.`,
    `Theme: ${song.theme}.`,
    `Mood: ${song.mood}.`,
    `Tempo: ${song.tempo_bpm} BPM.`,
    `Instrumentation: ${song.instruments}. Warm North African acoustic feel.`,
    `Vocals: ${song.vocal_tone}. Sung slowly and clearly in natural Moroccan Darija Arabic ONLY, with the exact ${song.lines.length} lyric lines below.`,
    `Mixing & vocal clarity:`,
    `- One clear solo lead voice, loud and upfront in the mix, with softer acoustic accompaniment underneath.`,
    `- Clean dry studio vocal: no heavy echo, no autotune effects, no choir over the words, no rap, no distortion.`,
    `[Verse]`,
    lyricsBlock,
    ``,
    `End with 4-5 seconds of soft instrumental only (no voice).`,
  ].join("\n");
}

function readWavDurationSeconds(filePath: string): number | null {
  try {
    const buf = fs.readFileSync(filePath);
    if (
      buf.length < 44 ||
      buf.toString("ascii", 0, 4) !== "RIFF" ||
      buf.toString("ascii", 8, 12) !== "WAVE"
    ) {
      return null;
    }
    let offset = 12;
    let byteRate = 0;
    let dataSize = 0;
    while (offset + 8 <= buf.length) {
      const chunkId = buf.toString("ascii", offset, offset + 4);
      const chunkSize = buf.readUInt32LE(offset + 4);
      if (chunkId === "fmt " && offset + 24 <= buf.length) {
        byteRate = buf.readUInt32LE(offset + 16);
      } else if (chunkId === "data") {
        dataSize = chunkSize;
        break;
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
    if (byteRate > 0 && dataSize > 0) {
      return dataSize / byteRate;
    }
    return null;
  } catch {
    return null;
  }
}

async function probeDuration(filePath: string): Promise<number> {
  if (filePath.endsWith(".wav")) {
    const wavDur = readWavDurationSeconds(filePath);
    if (wavDur !== null && Number.isFinite(wavDur) && wavDur > 0) {
      return wavDur;
    }
  }

  let stderrText = "";
  try {
    const res = await execFileAsync(FFMPEG_BIN, ["-hide_banner", "-i", filePath]);
    stderrText = res.stderr || "";
  } catch (err) {
    const e = err as { stderr?: string };
    stderrText = e.stderr || "";
  }

  const match = stderrText.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (match) {
    const hours = parseFloat(match[1]);
    const mins = parseFloat(match[2]);
    const secs = parseFloat(match[3]);
    const total = hours * 3600 + mins * 60 + secs;
    return Number.isFinite(total) ? total : 0;
  }
  return 0;
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

async function masterAudioToWav(
  rawFilePath: string,
  outputWavPath: string
): Promise<{
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
    const { stderr: pass1Stderr } = await execFileAsync(FFMPEG_BIN, pass1Args, {
      maxBuffer: 10 * 1024 * 1024,
    });
    const jsonMatch = pass1Stderr.match(/\{\s*"input_i"\s*:[\s\S]*?\}/);
    if (jsonMatch) {
      const stats = JSON.parse(jsonMatch[0]) as LoudnormStats;
      const pass2Filter = [
        preFilter,
        `loudnorm=I=-14:TP=-1.0:LRA=7:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true:print_format=json`,
      ].join(",");

      const { stderr: pass2Stderr } = await execFileAsync(
        FFMPEG_BIN,
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
      FFMPEG_BIN,
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

interface VocalQualityAnalysis {
  words_heard_pct: number;
  transcribed_text: string;
  missing_words: string[];
  extra_words: string[];
  voice_start_seconds: number | null;
  voice_end_seconds: number | null;
}

async function analyzeGeneratedVocals(
  ai: GoogleGenAI,
  wavPath: string,
  mp3ScratchPath: string,
  lyricLines: string[],
  durationSeconds: number
): Promise<VocalQualityAnalysis> {
  // Compress temporarily to mono 16kHz MP3 so Gemini audio analysis is compact and fast
  let audioPath = wavPath;
  let mimeType = "audio/wav";
  try {
    await execFileAsync(
      FFMPEG_BIN,
      ["-y", "-i", wavPath, "-ac", "1", "-ar", "16000", "-b:a", "64k", mp3ScratchPath],
      { maxBuffer: 5 * 1024 * 1024 }
    );
    if (fs.existsSync(mp3ScratchPath)) {
      audioPath = mp3ScratchPath;
      mimeType = "audio/mp3";
    }
  } catch {
    audioPath = wavPath;
    mimeType = "audio/wav";
  }

  const audioBase64 = fs.readFileSync(audioPath).toString("base64");
  const audioPart = {
    inlineData: {
      mimeType,
      data: audioBase64,
    },
  };

  const [transcribeRes, timingRes] = await Promise.allSettled([
    ai.models.generateContent({
      model: "gemini-3.5-transcribe",
      contents: {
        parts: [
          audioPart,
          {
            text: "Transcribe all sung Moroccan Darija Arabic words in exact spoken/sung order as Arabic script only.",
          },
        ],
      },
    }),
    ai.models.generateContent({
      model: "gemini-4-hydrogen",
      contents: {
        parts: [
          audioPart,
          {
            text: [
              `Listen carefully to this ${durationSeconds.toFixed(1)}-second audio track.`,
              `Determine:`,
              `1. voice_start_seconds: exact timestamp in seconds when the singing voice first starts (e.g. 0.6).`,
              `2. voice_end_seconds: exact timestamp in seconds when the singing voice completely finishes before the instrumental outro (e.g. 25.4).`,
              `3. transcript_arabic: exact Moroccan Darija Arabic words actually sung by the vocalist in order (Arabic script only, no commentary).`,
            ].join("\n"),
          },
        ],
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            voice_start_seconds: { type: Type.NUMBER },
            voice_end_seconds: { type: Type.NUMBER },
            transcript_arabic: { type: Type.STRING },
          },
          required: ["voice_start_seconds", "voice_end_seconds", "transcript_arabic"],
        },
      },
    }),
  ]);

  let transcribeText = "";
  if (transcribeRes.status === "fulfilled") {
    transcribeText = (transcribeRes.value.text ?? "").trim();
  }

  let voiceStart: number | null = null;
  let voiceEnd: number | null = null;
  let timingTranscript = "";

  if (timingRes.status === "fulfilled") {
    const rawJson = (timingRes.value.text ?? "").trim();
    try {
      const parsed = JSON.parse(rawJson) as {
        voice_start_seconds?: number;
        voice_end_seconds?: number;
        transcript_arabic?: string;
      };
      if (typeof parsed.voice_start_seconds === "number" && Number.isFinite(parsed.voice_start_seconds)) {
        const clampedStart = Math.max(0, Math.min(durationSeconds, parsed.voice_start_seconds));
        voiceStart = Number(clampedStart.toFixed(1));
      }
      if (typeof parsed.voice_end_seconds === "number" && Number.isFinite(parsed.voice_end_seconds)) {
        const minEnd = voiceStart ?? 0;
        const clampedEnd = Math.max(minEnd, Math.min(durationSeconds, parsed.voice_end_seconds));
        voiceEnd = Number(clampedEnd.toFixed(1));
      }
      if (typeof parsed.transcript_arabic === "string") {
        timingTranscript = parsed.transcript_arabic.trim();
      }
    } catch {
      // Fall through if JSON parsing failed
    }
  }

  const finalTranscript = transcribeText || timingTranscript;
  if (!finalTranscript && transcribeRes.status === "rejected" && timingRes.status === "rejected") {
    throw new Error("Gemini vocal transcription & timing check failed.");
  }

  const comparison = compareTranscriptInOrder(lyricLines, finalTranscript);
  return {
    words_heard_pct: comparison.words_heard_pct,
    transcribed_text: comparison.transcribed_text.slice(0, 600),
    missing_words: comparison.missing_words.slice(0, 40),
    extra_words: comparison.extra_words.slice(0, 40),
    voice_start_seconds: voiceStart,
    voice_end_seconds: voiceEnd,
  };
}

const activeGenerations = new Set<string>();

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // Generate & master a single song in temporary /tmp scratch space and stream WAV back.
  // Never persists audio or state to local server disk.
  app.post(
    "/api/songs/:number/generate",
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const num = Number(req.params.number);
      const baseSpec = INITIAL_SONGS.find((s) => s.number === num);
      if (!baseSpec) {
        res.status(404).json({ error: `Song #${num} not found` });
        return;
      }

      const lockKey = `${req.user?.uid}:${num}`;
      if (activeGenerations.has(lockKey)) {
        res.status(409).json({ error: `Song #${num} is already generating` });
        return;
      }

      const body = (req.body || {}) as Partial<SongSpec> & { model?: string };
      const modelName =
        body.model === "lyria-3-clip-preview" ? "lyria-3-clip-preview" : "lyria-3.5";

      const lines = Array.isArray(body.lines)
        ? body.lines.map((l) => String(l).trim().slice(0, 240))
        : baseSpec.lines;

      const lyricCheck = validateLyrics(lines);
      if (!lyricCheck.valid) {
        res.status(400).json({
          error: `Lyric rule violation: ${lyricCheck.errors.join(" ")}`,
        });
        return;
      }

      const tempoBpm =
        typeof body.tempo_bpm === "number" &&
        body.tempo_bpm >= 70 &&
        body.tempo_bpm <= 100
          ? Math.round(body.tempo_bpm)
          : baseSpec.tempo_bpm;

      const songSpec: SongSpec = {
        number: baseSpec.number,
        feeling_key: baseSpec.feeling_key,
        title:
          typeof body.title === "string" && body.title.trim()
            ? body.title.trim().slice(0, 120)
            : baseSpec.title,
        theme:
          typeof body.theme === "string" && body.theme.trim()
            ? body.theme.trim().slice(0, 240)
            : baseSpec.theme,
        lines,
        mood:
          typeof body.mood === "string" && body.mood.trim()
            ? body.mood.trim().slice(0, 80)
            : baseSpec.mood,
        tempo_bpm: tempoBpm,
        instruments:
          typeof body.instruments === "string" && body.instruments.trim()
            ? body.instruments.trim().slice(0, 300)
            : baseSpec.instruments,
        vocal_tone:
          typeof body.vocal_tone === "string" && body.vocal_tone.trim()
            ? body.vocal_tone.trim().slice(0, 300)
            : baseSpec.vocal_tone,
      };

      activeGenerations.add(lockKey);
      const jobId = crypto.randomUUID();
      let typedRawPath: string | null = null;
      const tmpWavPath = path.join(os.tmpdir(), `darija-${num}-${jobId}-master.wav`);
      const tmpAnalyzeMp3Path = path.join(os.tmpdir(), `darija-${num}-${jobId}-analyze.mp3`);

      try {
        const ai = getGenAI();
        const prompt = buildLyriaPrompt(songSpec);

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
        typedRawPath = path.join(os.tmpdir(), `darija-${num}-${jobId}-raw${rawExt}`);
        fs.writeFileSync(typedRawPath, rawBuffer);

        const mastered = await masterAudioToWav(typedRawPath, tmpWavPath);
        const qualityReport = await analyzeGeneratedVocals(
          ai,
          tmpWavPath,
          tmpAnalyzeMp3Path,
          songSpec.lines,
          mastered.durationSeconds
        );
        const wavBuffer = fs.readFileSync(tmpWavPath);
        const encodedReport = Buffer.from(JSON.stringify(qualityReport), "utf8").toString(
          "base64"
        );

        res.setHeader("Content-Type", "audio/wav");
        res.setHeader("Content-Length", String(wavBuffer.length));
        res.setHeader("X-Duration-Seconds", String(mastered.durationSeconds));
        res.setHeader("X-Lufs", String(mastered.lufs));
        res.setHeader("X-True-Peak-Db", String(mastered.truePeakDb));
        res.setHeader("X-Model-Used", modelName);
        res.setHeader("X-Quality-Report", encodedReport);
        res.send(wavBuffer);
      } catch (err) {
        const rawMessage =
          err instanceof Error ? err.message : "Failed to generate audio with Lyria.";
        const isNotFound =
          rawMessage.includes("404") ||
          rawMessage.includes("NOT_FOUND") ||
          rawMessage.toLowerCase().includes("is not found");

        const statusCode = isNotFound
          ? 404
          : rawMessage.includes("PERMISSION_DENIED") || rawMessage.includes("403")
          ? 403
          : rawMessage.includes("RESOURCE_EXHAUSTED") || rawMessage.includes("429")
          ? 429
          : 500;

        const message = isNotFound
          ? `Model "${modelName}" returned 404 (not found for API version v1beta). Try switching to "lyria-3-clip-preview" or check model availability. Details: ${rawMessage}`
          : rawMessage;

        res.status(statusCode).json({ error: message });
      } finally {
        activeGenerations.delete(lockKey);
        if (typedRawPath && fs.existsSync(typedRawPath)) {
          fs.unlinkSync(typedRawPath);
        }
        if (fs.existsSync(tmpWavPath)) {
          fs.unlinkSync(tmpWavPath);
        }
        if (fs.existsSync(tmpAnalyzeMp3Path)) {
          fs.unlinkSync(tmpAnalyzeMp3Path);
        }
      }
    }
  );

  // Authenticated Cloud Storage proxy strictly locked to our project's Firebase Storage bucket.
  // Used as CORS-safe fallback when assembling ZIPs or backing up an old WAV during regenerate.
  app.post(
    "/api/storage-proxy",
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const rawUrl = (req.body as { url?: unknown } | undefined)?.url;
        if (typeof rawUrl !== "string" || !rawUrl) {
          res.status(400).json({ error: "Missing storage URL" });
          return;
        }
        const parsed = new URL(rawUrl);
        const expectedPrefix = `/v0/b/${firebaseConfig.storageBucket}/o/`;
        if (
          parsed.protocol !== "https:" ||
          parsed.hostname !== "firebasestorage.googleapis.com" ||
          !parsed.pathname.startsWith(expectedPrefix)
        ) {
          res.status(403).json({ error: "Forbidden storage URL" });
          return;
        }

        const upstream = await fetch(parsed.toString());
        if (!upstream.ok) {
          res.status(upstream.status).json({ error: `Storage fetch failed (${upstream.status})` });
          return;
        }
        const arrBuf = await upstream.arrayBuffer();
        const buf = Buffer.from(arrBuf);
        res.setHeader("Content-Type", upstream.headers.get("content-type") || "audio/wav");
        res.setHeader("Content-Length", String(buf.length));
        res.send(buf);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to fetch from Cloud Storage";
        res.status(500).json({ error: msg });
      }
    }
  );

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
