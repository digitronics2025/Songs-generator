import type { checkRhyme, RhymeScheme } from "../lib/lyricQuality";

type Result = ReturnType<typeof checkRhyme>;

export function RhymeTag({ result, index }: { result: Result; index: number }) {
  if (!result.labels[index]) return null;
  const broken = result.broken.some(group => group.includes(index));
  return <span dir="ltr" className={broken ? "text-[#B91C1C]" : "text-[#15803D]"}
    aria-label={`Rhyme group ${result.labels[index]}, ${broken ? "broken" : "matches"}`}>
    {" · "}{result.labels[index]}·<bdi>{result.keys[index] || "—"}</bdi>
  </span>;
}

export function RhymeSummary({ result, scheme }: { result: Result; scheme: RhymeScheme }) {
  if (scheme === "OFF") return null;
  const count = result.broken.length;
  const unit = scheme === "MONO" ? "group" : "pair";
  return <span className={result.ok ? "text-[#15803D]" : "text-[#B91C1C]"}>
    Rhyme: {result.ok ? scheme + " ✓" : count + " " + unit + (count === 1 ? "" : "s") + " broken"}
  </span>;
}
