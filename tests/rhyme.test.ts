import { expect, it } from "vitest";
import { checkRhyme, rhymeGroups, rhymeKey, validateLyrics } from "../src/lib/lyricQuality.ts";
import { settingsFromDocument } from "../server/settings.ts";

const rhyming = ["يديك يا بابا تعبانين", "خدمتي ليل ونهار سنين", "باش ما نخصو والو حنا",
  "كبرنا وصبرك ديما معانا", "دابا جا دورنا نردوها", "الفرحة ليك نهديوها"];
const original = ["يدين بابا تعبانين", "خرج بكري للخدمة", "باش ما نخصو والو", "كبرنا ونتا صابر",
  "دابا جا دورنا", "نردو ليك الفرحة"];

it("normalizes the final Arabic word and keeps distinct two-letter endings", () => {
  expect(rhymeKey("يا تَعْبـانِين!")).toBe(rhymeKey("سنين"));
  expect(rhymeKey("حنا")).toBe(rhymeKey("معانا"));
  expect(rhymeKey("نردوها")).toBe(rhymeKey("نهديوها"));
  expect(rhymeKey("للخدمة")).not.toBe(rhymeKey("الفرحة"));
});

it("groups pairs, alternating quatrains, and monorhymes with a free odd line", () => {
  expect(rhymeGroups(6, "AABB")).toEqual([[0, 1], [2, 3], [4, 5]]);
  expect(rhymeGroups(7, "ABAB")).toEqual([[0, 2], [1, 3], [4, 5]]);
  expect(rhymeGroups(7, "MONO")).toEqual([[0, 1, 2, 3, 4, 5]]);
  expect(rhymeGroups(6, "OFF")).toEqual([]);
});

it("checks both versions and rejects repeated or short endings", () => {
  expect(checkRhyme(rhyming, "AABB")).toMatchObject({ ok: true, labels: ["A","A","B","B","C","C"] });
  expect(checkRhyme(original, "AABB").broken).toEqual([[0,1],[2,3],[4,5]]);
  expect(checkRhyme(["يا سنين", "سِنين!"], "AABB").ok).toBe(false);
  expect(checkRhyme(["ه", "ة"], "MONO").ok).toBe(false);
  expect(validateLyrics(original).errors.join(" ")).not.toMatch(/rhyme/);
  expect(validateLyrics(original, { rhyme_scheme: "AABB" }).errors[0]).toContain("Lines 1 and 2 don't rhyme");
  expect(validateLyrics(rhyming, { rhyme_scheme: "AABB" }).errors.join(" ")).toContain("forbidden phrase");
});

it("loads existing and invalid settings using the default scheme", () => {
  expect(settingsFromDocument({}).rhyme_scheme).toBe("AABB");
  expect(settingsFromDocument({ rhyme_scheme: "wrong" }).rhyme_scheme).toBe("AABB");
  expect(settingsFromDocument({ rhyme_scheme: "OFF" }).rhyme_scheme).toBe("OFF");
});
