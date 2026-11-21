import { normalizeArabicText } from "./lyricQuality.ts";

export interface LyricText {
  title: string;
  lines: string[];
  embedding?: number[];
}

function prepare(lyric: LyricText) {
  const lines = lyric.lines.map(normalizeArabicText).filter(Boolean);
  const lyrics = lines.join(" ").split(/ +/).filter(Boolean);
  return {
    units: new Set([normalizeArabicText(lyric.title), ...lines].filter(Boolean)),
    words: new Set(lyrics),
    triples: new Set(lyrics.slice(2).map((_, index) => lyrics.slice(index, index + 3).join(" "))),
  };
}

export function cosine(a?: number[], b?: number[]): number {
  if (!a?.length || !b || b.length !== a.length) return 0;
  let dot = 0, left = 0, right = 0;
  for (const [index, value] of a.entries()) {
    dot += value * b[index];
    left += value ** 2;
    right += b[index] ** 2;
  }
  return left && right ? Math.min(1, dot / Math.sqrt(left * right)) : 0;
}

export function closestLyric(candidate: LyricText, history: LyricText[]) {
  const current = prepare(candidate);
  let closest = 0;
  let rejected = false;
  for (const entry of history) {
    const other = prepare(entry);
    const exact = [...current.units].some((unit) => other.units.has(unit));
    const triple = [...current.triples].some((text) => other.triples.has(text));
    const common = [...current.words].filter((word) => other.words.has(word)).length;
    const overlap = common / (Math.min(current.words.size, other.words.size) || 1);
    const embedding = cosine(candidate.embedding, entry.embedding);
    if (exact || triple || overlap > 0.4 || embedding > 0.85) rejected = true;
    closest = Math.max(closest, exact ? 1 : 0, triple ? 0.41 : 0, overlap, embedding);
  }
  return { rejected, closest_match_pct: Math.round(closest * 100) };
}
