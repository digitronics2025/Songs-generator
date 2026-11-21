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

function buildLyriaPrompt(song: SongSpec, promptDirective?: string): string {
  const lyricsBlock = song.lines.join("\n");
  const directiveLine = promptDirective
    ? `- ${promptDirective}.`
    : `- Start singing immediately within the first 1 second (no long instrumental intro) and finish all vocals before 27 seconds, followed by soft instrumental only.`;
  return [
    `Moroccan acoustic family song, length about 40 seconds, ending with 4-5 seconds of soft instrumental only.`,
    directiveLine,
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
      const rawParam = req.params.number;
      const num = Number(rawParam);
      const isNum = !isNaN(num) && num > 0;
      const baseSpec = isNum ? INITIAL_SONGS.find((s) => s.number === num) : undefined;

      const body = (req.body || {}) as Partial<SongSpec> & {
        model?: string;
        prompt_directive?: string;
        feeling_key?: string;
        admin_feeling?: string;
      };

      const title =
        (typeof body.title === "string" && body.title.trim()) ||
        baseSpec?.title ||
        "أغنية مغربية";

      const lines =
        Array.isArray(body.lines) && body.lines.length > 0
          ? body.lines.map((l) => String(l).trim().slice(0, 240))
          : baseSpec?.lines || [];

      if (lines.length === 0) {
        res.status(400).json({ error: "No lyric lines provided for generation." });
        return;
      }

      const feelingKey =
        (typeof body.feeling_key === "string" && body.feeling_key.trim()) ||
        baseSpec?.feeling_key ||
        "family_song";

      const adminFeeling =
        (typeof body.admin_feeling === "string" && body.admin_feeling.trim()) ||
        baseSpec?.admin_feeling ||
        "family_evening";

      const theme =
        (typeof body.theme === "string" && body.theme.trim()) ||
        baseSpec?.theme ||
        "Everyday Moroccan family moment";

      const mood =
        (typeof body.mood === "string" && body.mood.trim()) ||
        baseSpec?.mood ||
        "Warm, emotional acoustic feel";

      const tempoBpm =
        typeof body.tempo_bpm === "number" &&
        body.tempo_bpm >= 70 &&
        body.tempo_bpm <= 100
          ? Math.round(body.tempo_bpm)
          : baseSpec?.tempo_bpm || 80;

      const instruments =
        (typeof body.instruments === "string" && body.instruments.trim()) ||
        baseSpec?.instruments ||
        "Acoustic oud, guitar, and gentle percussion";

      const vocalTone =
        (typeof body.vocal_tone === "string" && body.vocal_tone.trim()) ||
        baseSpec?.vocal_tone ||
        "Solo warm Moroccan vocal, clear and close-mic";

      const lockKey = `${req.user?.uid}:${rawParam}`;
      if (activeGenerations.has(lockKey)) {
        res.status(409).json({ error: `Song #${rawParam} is already generating` });
        return;
      }

      const modelName =
        body.model === "lyria-3-clip-preview" ? "lyria-3-clip-preview" : "lyria-3.5";

      const lyricCheck = validateLyrics(lines);
      if (!lyricCheck.valid) {
        res.status(400).json({
          error: `Lyric rule violation: ${lyricCheck.errors.join(" ")}`,
        });
        return;
      }

      const songSpec: SongSpec = {
        number: isNum ? num : 1,
        feeling_key: feelingKey,
        admin_feeling: adminFeeling as any,
        title,
        theme,
        lines,
        mood,
        tempo_bpm: tempoBpm,
        instruments,
        vocal_tone: vocalTone,
      };

      activeGenerations.add(lockKey);
      const jobId = crypto.randomUUID();
      let typedRawPath: string | null = null;
      const tmpWavPath = path.join(os.tmpdir(), `darija-${num}-${jobId}-master.wav`);
      const tmpAnalyzeMp3Path = path.join(os.tmpdir(), `darija-${num}-${jobId}-analyze.mp3`);

      try {
        const ai = getGenAI();
        const prompt = buildLyriaPrompt(songSpec, body.prompt_directive);

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

  // Re-master existing audio (no new generation) to satisfy -14 ±1 LUFS and <= -1 dBTP
  app.post(
    "/api/songs/remaster",
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const body = (req.body || {}) as {
        audio_base64?: string;
        url?: string;
        lines?: string[];
      };
      let rawBuffer: Buffer | null = null;

      try {
        if (body.audio_base64) {
          rawBuffer = Buffer.from(body.audio_base64, "base64");
        } else if (typeof body.url === "string" && body.url.startsWith("https://")) {
          const upstream = await fetch(body.url);
          if (!upstream.ok) {
            res.status(400).json({ error: "Failed to download existing audio for remaster" });
            return;
          }
          const ab = await upstream.arrayBuffer();
          rawBuffer = Buffer.from(ab);
        }

        if (!rawBuffer || rawBuffer.length === 0) {
          res.status(400).json({ error: "No audio data provided for remastering" });
          return;
        }

        const jobId = crypto.randomUUID();
        const tmpRawPath = path.join(os.tmpdir(), `remaster-${jobId}-raw.wav`);
        const tmpOutPath = path.join(os.tmpdir(), `remaster-${jobId}-out.wav`);
        const tmpAnalyzePath = path.join(os.tmpdir(), `remaster-${jobId}-analyze.mp3`);

        fs.writeFileSync(tmpRawPath, rawBuffer);
        try {
          const mastered = await masterAudioToWav(tmpRawPath, tmpOutPath);
          const ai = getGenAI();
          let qualityReport = null;
          if (Array.isArray(body.lines) && body.lines.length >= 1) {
            qualityReport = await analyzeGeneratedVocals(
              ai,
              tmpOutPath,
              tmpAnalyzePath,
              body.lines,
              mastered.durationSeconds
            );
          }
          const outWav = fs.readFileSync(tmpOutPath);
          res.setHeader("Content-Type", "audio/wav");
          res.setHeader("Content-Length", String(outWav.length));
          res.setHeader("X-Duration-Seconds", String(mastered.durationSeconds));
          res.setHeader("X-Lufs", String(mastered.lufs));
          res.setHeader("X-True-Peak-Db", String(mastered.truePeakDb));
          if (qualityReport) {
            res.setHeader(
              "X-Quality-Report",
              Buffer.from(JSON.stringify(qualityReport), "utf8").toString("base64")
            );
          }
          res.send(outWav);
        } finally {
          if (fs.existsSync(tmpRawPath)) fs.unlinkSync(tmpRawPath);
          if (fs.existsSync(tmpOutPath)) fs.unlinkSync(tmpOutPath);
          if (fs.existsSync(tmpAnalyzePath)) fs.unlinkSync(tmpAnalyzePath);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to remaster audio";
        res.status(500).json({ error: msg });
      }
    }
  );

  // Propose a repaired 6-line lyric via Gemini (requires manual approval before generating audio)
  app.post(
    "/api/songs/:number/propose-lyric-fix",
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const num = Number(req.params.number);
      const baseSpec = INITIAL_SONGS.find((s) => s.number === num);
      if (!baseSpec) {
        res.status(404).json({ error: `Song #${num} not found` });
        return;
      }

      const body = (req.body || {}) as {
        current_lines?: string[];
        reason?: string;
        failing_words?: string[];
      };

      try {
        const ai = getGenAI();
        const failingWordsText =
          Array.isArray(body.failing_words) && body.failing_words.length > 0
            ? `Avoid difficult or frequently missed words like: ${body.failing_words.join(", ")}.`
            : "";

        const prompt = [
          `You are an expert Moroccan Darija songwriter crafting short acoustic family songs for Reels/Shorts.`,
          `Fix the lyrics for track #${num} about the feeling "${baseSpec.feeling_key}" (Theme: ${baseSpec.theme}, Admin feeling category: ${baseSpec.admin_feeling}).`,
          `Current lyrics to revise:`,
          (body.current_lines || baseSpec.lines).join("\n"),
          `Reason for revision: ${body.reason || "Vocal clarity or rule failure."}`,
          failingWordsText,
          `MANDATORY LYRIC RULES:`,
          `1. EXACTLY 6 short lines.`,
          `2. MAX 5 words per line (4-5 words is ideal). Every line must have 1 to 5 words, no more.`,
          `3. Everyday Moroccan Darija in Arabic letters only. No Modern Standard Arabic poetry, no French, no English.`,
          `4. Warm, emotional, never sad without hope: hard moments must end with hope.`,
          `5. Title MUST be the first few words of line 1 (in Arabic).`,
          `6. STRICTLY FORBIDDEN words (do NOT use any of these or their forms): عيد، رمضان، اليوم، أحسن، لمة، طفا، نقيين، الصابون، البرنامج، بلاصتها، ليل ونهار.`,
          `7. NO numbers, no digits, no prices or currency terms (درهم، ريال، etc.), no brand or product names.`,
          `8. Create fresh natural phrasing not identical to the current lines.`,
          `Provide your proposal with: title, lines (array of exactly 6 strings), and a short reason explaining the fix.`,
        ].join("\n");

        const response = await ai.models.generateContent({
          model: "gemini-4-hydrogen",
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                lines: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                reason: { type: Type.STRING },
              },
              required: ["title", "lines", "reason"],
            },
          },
        });

        const rawJson = (response.text ?? "").trim();
        const parsed = JSON.parse(rawJson) as {
          title: string;
          lines: string[];
          reason: string;
        };

        const check = validateLyrics(parsed.lines);
        if (!check.valid) {
          // If Gemini made a minor rule violation on first try, clean up or report
          res.status(422).json({
            error: `Proposed lyric failed rules: ${check.errors.join("; ")}`,
            proposal: parsed,
          });
          return;
        }

        res.json({
          title: parsed.title.trim().slice(0, 120),
          lines: parsed.lines.map((l) => l.trim().slice(0, 240)),
          reason: parsed.reason.trim().slice(0, 500),
          created_at: new Date().toISOString(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to propose lyric fix";
        res.status(500).json({ error: msg });
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

  // Generate 1-5 song options for "New Song" using Gemini with anti-collision
  app.post(
    "/api/songs/generate-options",
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const body = (req.body || {}) as {
        admin_feeling: string;
        idea?: string;
        mood?: string;
        options_count?: number;
        settings?: {
          lines_per_song?: number;
          max_words_per_line?: number;
          forbidden_words?: string[];
          block_substrings?: boolean;
          no_numbers_prices_brands?: boolean;
        };
        used_titles?: string[];
        used_first_lines?: string[];
      };

      const adminFeeling = body.admin_feeling || "mothers_care";
      const optionsCount = Math.max(1, Math.min(5, Math.round(body.options_count || 3)));
      const settings = body.settings || {};
      const linesPerSong = settings.lines_per_song || 6;
      const maxWordsPerLine = settings.max_words_per_line || 5;
      const forbiddenWords = settings.forbidden_words || [
        "عيد",
        "رمضان",
        "اليوم",
        "أحسن",
        "لمة",
        "طفا",
        "نقيين",
        "الصابون",
        "البرنامج",
        "بلاصتها",
        "ليل ونهار",
      ];
      const usedTitles = Array.isArray(body.used_titles) ? body.used_titles.filter(Boolean) : [];
      const usedFirstLines = Array.isArray(body.used_first_lines)
        ? body.used_first_lines.filter(Boolean)
        : [];

      try {
        const ai = getGenAI();
        const antiCollisionText =
          usedTitles.length > 0 || usedFirstLines.length > 0
            ? [
                `CRITICAL ANTI-COLLISION CONSTRAINT:`,
                `The library ALREADY has these songs for "${adminFeeling}":`,
                usedTitles.length > 0 ? `Existing titles: ${usedTitles.join(", ")}` : "",
                usedFirstLines.length > 0
                  ? `Existing opening lines:\n${usedFirstLines.map((l) => `- "${l}"`).join("\n")}`
                  : "",
                `DO NOT reuse or imitate these scenes, rhymes, or phrasing. You MUST choose a DIFFERENT scene, place, moment, metaphor, and vocabulary!`,
              ]
                .filter(Boolean)
                .join("\n")
            : "";

        const prompt = [
          `You are an expert Moroccan Darija songwriter crafting acoustic family songs for social Reels and Shorts.`,
          `Category / Feeling: "${adminFeeling}".`,
          body.idea ? `Specific story/moment requested: "${body.idea}".` : "",
          body.mood ? `Desired emotional mood: "${body.mood}".` : "",
          `MANDATORY SONGWRITING RULES:`,
          `1. Everyday Moroccan Darija in Arabic script only. No Modern Standard Arabic poetry, no French, no English in the lyrics.`,
          `2. EXACTLY ${linesPerSong} short lines per song.`,
          `3. MAXIMUM ${maxWordsPerLine} words per line (4 to 5 words is ideal; NEVER exceed ${maxWordsPerLine} words per line).`,
          `4. Warm, emotional, everyday family moments. Hopeful ending: hard moments must conclude with hope and love.`,
          `5. Title MUST be the first few words of Line 1 (in Arabic script).`,
          `6. STRICTLY FORBIDDEN words (never use any of these or their forms/substrings): ${forbiddenWords.join("، ")}.`,
          settings.no_numbers_prices_brands !== false
            ? `7. NO numbers, no digits, no prices or currency terms (درهم، ريال، etc.), no brand or product names.`
            : "",
          `8. Canonical feeling_key in snake_case English (e.g. mothers_care, evening_tea, etc.).`,
          `9. Acoustic instrumentation (oud, qanun, acoustic guitar, or piano at 70 to 100 BPM).`,
          antiCollisionText,
          `Generate exactly ${optionsCount} distinct, high-quality song option(s). Each option must offer a fresh angle.`,
        ]
          .filter(Boolean)
          .join("\n");

        const response = await ai.models.generateContent({
          model: "gemini-4-hydrogen",
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  lines: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  theme: { type: Type.STRING },
                  mood: { type: Type.STRING },
                  tempo_bpm: { type: Type.INTEGER },
                  instruments: { type: Type.STRING },
                  vocal_tone: { type: Type.STRING },
                  feeling_key: { type: Type.STRING },
                },
                required: [
                  "title",
                  "lines",
                  "theme",
                  "mood",
                  "tempo_bpm",
                  "instruments",
                  "vocal_tone",
                  "feeling_key",
                ],
              },
            },
          },
        });

        const rawJson = (response.text ?? "").trim();
        const parsed = JSON.parse(rawJson) as Array<{
          title: string;
          lines: string[];
          theme: string;
          mood: string;
          tempo_bpm: number;
          instruments: string;
          vocal_tone: string;
          feeling_key: string;
        }>;

        const validatedOptions = parsed.map((opt) => {
          const cleanLines = opt.lines
            .slice(0, linesPerSong)
            .map((l) => l.trim().slice(0, 240));
          const check = validateLyrics(cleanLines, settings);
          return {
            title: opt.title.trim().slice(0, 120),
            lines: cleanLines,
            theme: opt.theme.trim().slice(0, 240),
            mood: opt.mood.trim().slice(0, 80),
            tempo_bpm: Math.min(100, Math.max(70, opt.tempo_bpm || 80)),
            instruments: opt.instruments.trim().slice(0, 300),
            vocal_tone: opt.vocal_tone.trim().slice(0, 300),
            feeling_key: opt.feeling_key
              .toLowerCase()
              .replace(/[^a-z0-9_]+/g, "_")
              .slice(0, 64),
            admin_feeling: adminFeeling,
            validation: check,
          };
        });

        res.json({ options: validatedOptions });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to generate song options";
        res.status(500).json({ error: msg });
      }
    }
  );

  // Batch generate 1-20 song drafts for "Batch Generator"
  app.post(
    "/api/songs/batch-generate",
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const body = (req.body || {}) as {
        count: number;
        feelings: string[];
        settings?: {
          lines_per_song?: number;
          max_words_per_line?: number;
          forbidden_words?: string[];
          block_substrings?: boolean;
          no_numbers_prices_brands?: boolean;
        };
        used_songs?: Array<{ admin_feeling: string; title: string; first_line: string }>;
      };

      const totalCount = Math.max(1, Math.min(20, Math.round(body.count || 5)));
      const feelings =
        Array.isArray(body.feelings) && body.feelings.length > 0
          ? body.feelings
          : ["family_evening"];
      const settings = body.settings || {};
      const linesPerSong = settings.lines_per_song || 6;
      const maxWordsPerLine = settings.max_words_per_line || 5;
      const forbiddenWords = settings.forbidden_words || [
        "عيد",
        "رمضان",
        "اليوم",
        "أحسن",
        "لمة",
        "طفا",
        "نقيين",
        "الصابون",
        "البرنامج",
        "بلاصتها",
        "ليل ونهار",
      ];
      const usedSongs = Array.isArray(body.used_songs) ? body.used_songs : [];

      try {
        const ai = getGenAI();
        const drafts: any[] = [];

        // Distribute count across selected feelings
        const feelingsToGenerate: string[] = [];
        for (let i = 0; i < totalCount; i++) {
          feelingsToGenerate.push(feelings[i % feelings.length]);
        }

        // Group by feeling for efficient generation
        const grouped = new Map<string, number>();
        for (const f of feelingsToGenerate) {
          grouped.set(f, (grouped.get(f) || 0) + 1);
        }

        for (const [feeling, count] of grouped.entries()) {
          const feelingUsed = usedSongs.filter((u) => u.admin_feeling === feeling);
          const antiCollisionText =
            feelingUsed.length > 0
              ? [
                  `CRITICAL ANTI-COLLISION CONSTRAINT:`,
                  `The library ALREADY has these songs for "${feeling}":`,
                  `Titles: ${feelingUsed.map((u) => u.title).join(", ")}`,
                  `First lines:\n${feelingUsed.map((u) => `- "${u.first_line}"`).join("\n")}`,
                  `DO NOT reuse or imitate these scenes, rhymes, or phrasing. Choose distinct scenes and moments!`,
                ].join("\n")
              : "";

          const prompt = [
            `You are an expert Moroccan Darija songwriter crafting acoustic family songs for social Reels and Shorts.`,
            `Category / Feeling: "${feeling}".`,
            `Generate exactly ${count} distinct original song draft(s).`,
            `MANDATORY SONGWRITING RULES:`,
            `1. Everyday Moroccan Darija in Arabic script only. No Modern Standard Arabic poetry, no French, no English in lyrics.`,
            `2. EXACTLY ${linesPerSong} short lines per song.`,
            `3. MAXIMUM ${maxWordsPerLine} words per line (4 to 5 words is ideal; NEVER exceed ${maxWordsPerLine} words per line).`,
            `4. Warm, emotional, everyday family moments. Hopeful ending.`,
            `5. Title MUST be the first few words of Line 1 (in Arabic script).`,
            `6. FORBIDDEN words: ${forbiddenWords.join("، ")}.`,
            settings.no_numbers_prices_brands !== false
              ? `7. NO numbers, no digits, no prices or currency terms, no brand or product names.`
              : "",
            `8. Canonical feeling_key in snake_case English (e.g. mothers_care, etc.).`,
            `9. Acoustic instrumentation (oud, qanun, acoustic guitar, or piano at 70 to 100 BPM).`,
            antiCollisionText,
          ]
            .filter(Boolean)
            .join("\n");

          const response = await ai.models.generateContent({
            model: "gemini-4-hydrogen",
            contents: prompt,
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    lines: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                    theme: { type: Type.STRING },
                    mood: { type: Type.STRING },
                    tempo_bpm: { type: Type.INTEGER },
                    instruments: { type: Type.STRING },
                    vocal_tone: { type: Type.STRING },
                    feeling_key: { type: Type.STRING },
                  },
                  required: [
                    "title",
                    "lines",
                    "theme",
                    "mood",
                    "tempo_bpm",
                    "instruments",
                    "vocal_tone",
                    "feeling_key",
                  ],
                },
              },
            },
          });

          const rawJson = (response.text ?? "").trim();
          const parsed = JSON.parse(rawJson) as any[];
          for (const item of parsed) {
            const cleanLines = (item.lines || [])
              .slice(0, linesPerSong)
              .map((l: any) => String(l).trim().slice(0, 240));
            const check = validateLyrics(cleanLines, settings);
            drafts.push({
              title: String(item.title || "").trim().slice(0, 120),
              lines: cleanLines,
              theme: String(item.theme || "").trim().slice(0, 240),
              mood: String(item.mood || "").trim().slice(0, 80),
              tempo_bpm: Math.min(100, Math.max(70, Number(item.tempo_bpm) || 80)),
              instruments: String(item.instruments || "").trim().slice(0, 300),
              vocal_tone: String(item.vocal_tone || "").trim().slice(0, 300),
              feeling_key: String(item.feeling_key || feeling)
                .toLowerCase()
                .replace(/[^a-z0-9_]+/g, "_")
                .slice(0, 64),
              admin_feeling: feeling,
              validation: check,
            });
          }
        }

        res.json({ drafts: drafts.slice(0, totalCount) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Batch generation failed";
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
