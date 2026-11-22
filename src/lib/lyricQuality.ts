import type { StudioSettings } from "../data/songs.ts";

export const ADMIN_FEELINGS = [
  "mothers_care",
  "fathers_pride",
  "family_evening",
  "ramadan_ftour",
  "eid_morning",
  "calling_home",
  "summer_at_home",
  "new_home",
] as const;

export type AdminFeeling = (typeof ADMIN_FEELINGS)[number];

export const DEFAULT_ADMIN_FEELING_BY_KEY: Record<string, AdminFeeling> = {
  mothers_prayers: "mothers_care",
  fathers_effort: "fathers_pride",
  grandparents: "family_evening",
  far_from_home: "calling_home",
  siblings: "family_evening",
  childhood_friends: "family_evening",
  true_friend: "calling_home",
  first_rain: "family_evening",
  winter_warmth: "family_evening",
  summer_sea: "summer_at_home",
  new_morning: "new_home",
  graduation: "mothers_care",
  first_salary: "mothers_care",
  small_dream: "new_home",
  falling_rising: "fathers_pride",
  patience: "fathers_pride",
  wedding_joy: "eid_morning",
  new_baby: "new_home",
  eid_together: "eid_morning",
  small_gift: "fathers_pride",
};

export const FORBIDDEN_SINGLE_WORDS = [
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
] as const;

export const FORBIDDEN_PHRASES = ["ليل ونهار"] as const;

const PRICE_TERMS = [
  "درهم",
  "دراهم",
  "سنتيم",
  "ريال",
  "فرنك",
  "أورو",
  "يورو",
  "دولار",
  "سعر",
  "تخفيض",
  "مجانا",
  "فابور",
  "صولد",
  "برومو",
  "dh",
  "dhs",
  "mad",
  "eur",
  "usd",
  "prix",
  "price",
  "promo",
] as const;

const NUMBER_WORDS = [
  "صفر",
  "جوج",
  "زوج",
  "تلاتة",
  "ثلاثة",
  "ربعة",
  "أربعة",
  "خمسة",
  "ستة",
  "سبعة",
  "تمنية",
  "ثمانية",
  "تسعود",
  "تسعة",
  "عشرة",
  "عشرين",
  "تلاتين",
  "ثلاثين",
  "ربعين",
  "أربعين",
  "خمسين",
  "ستين",
  "سبعين",
  "تمانين",
  "ثمانين",
  "تسعين",
  "مية",
  "مائة",
  "ميات",
  "ألف",
  "الاف",
  "مليون",
  "مليار",
] as const;

const BRAND_OR_PRODUCT_TERMS = [
  "تيد",
  "أريال",
  "أومو",
  "بيرسيل",
  "ماكسي",
  "ساني كروا",
  "جافيل",
  "فيري",
  "بريل",
  "أوني",
  "كوكا",
  "كوكاكولا",
  "بيبسي",
  "فانتا",
  "سبرايت",
  "مرجان",
  "كارفور",
  "أسيما",
  "بيم",
  "سنطرال",
  "دانون",
  "جودة",
  "لوسيور",
  "عافية",
  "بيمو",
  "إينوي",
  "أورنج",
  "اتصالات المغرب",
  "تيك توك",
  "انستغرام",
  "انستقرام",
  "فيسبوك",
  "يوتيوب",
  "واتساب",
  "غوغل",
  "جوجل",
  "أبل",
  "سامسونج",
  "ماركة",
  "برودوي",
  "منتج",
  "منتوج",
  "tide",
  "ariel",
  "omo",
  "persil",
  "maxi",
  "javel",
  "fairy",
  "pril",
  "coca",
  "pepsi",
  "marjane",
  "carrefour",
  "bim",
  "centrale",
  "danone",
  "lesieur",
  "inwi",
  "orange",
  "tiktok",
  "instagram",
  "facebook",
  "youtube",
  "whatsapp",
  "google",
  "apple",
  "samsung",
] as const;

export function normalizeArabicText(text: string): string {
  return text
    .normalize("NFKC")
    // Strip tashkeel & tatweel
    .replace(/[\p{M}\p{Cf}\u0640]/gu, "")
    // Normalize alef forms, alef maqsura, teh marbuta
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    // Strip punctuation
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export type RhymeScheme = StudioSettings["rhyme_scheme"];

export function lastArabicWord(line: string): string {
  return line.normalize("NFKC").match(/(?:(?=\p{Script=Arabic})\p{L}|[\p{M}\u0640])+/gu)
    ?.filter(word => /\p{L}/u.test(word)).at(-1) ?? "";
}

export function rhymeKey(line: string): string {
  const word = lastArabicWord(normalizeArabicText(line));
  // The short حنا and longer معانا share the pronounced -na suffix.
  const ending = word.length > 3 && !word.endsWith("نا") ? word.replace(/ا$/, "") : word;
  return ending.slice(-2);
}

export function rhymeGroups(lineCount: number, scheme: RhymeScheme): number[][] {
  const paired = lineCount - lineCount % 2;
  if (scheme === "OFF" || paired < 2) return [];
  if (scheme === "MONO") return [Array.from({ length: paired }, (_, i) => i)];
  const groups: number[][] = [];
  for (let i = 0; i < paired; i += 2) {
    if (scheme === "ABAB" && i + 3 < paired) {
      groups.push([i, i + 2], [i + 1, i + 3]);
      i += 2;
    } else groups.push([i, i + 1]);
  }
  return groups;
}

export function checkRhyme(lines: string[], scheme: RhymeScheme) {
  const keys = lines.map(rhymeKey);
  const words = lines.map(line => lastArabicWord(normalizeArabicText(line)));
  const labels = lines.map(() => "");
  const broken = rhymeGroups(lines.length, scheme).filter((group, index) => {
    for (const i of group) labels[i] = String.fromCharCode(65 + index);
    return group.some(i => keys[i].length < 2 || keys[i] !== keys[group[0]]) ||
      new Set(group.map(i => words[i])).size !== group.length;
  });
  return { ok: broken.length === 0, keys, labels, broken };
}

export function countLineWords(line: string): number {
  const trimmed = line.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

const SINGLE_PREFIXES = ["و", "ف", "ب", "ك", "ل"];

function buildWordForms(baseNorm: string): Set<string> {
  const forms = new Set<string>([baseNorm]);
  if (!baseNorm.startsWith("ال")) {
    forms.add(`ال${baseNorm}`);
    forms.add(`وال${baseNorm}`);
    forms.add(`فال${baseNorm}`);
    forms.add(`بال${baseNorm}`);
    forms.add(`كال${baseNorm}`);
    forms.add(`لل${baseNorm}`);
  } else {
    const bare = baseNorm.slice(2);
    forms.add(bare);
    forms.add(`و${baseNorm}`);
    forms.add(`ف${baseNorm}`);
    forms.add(`ب${baseNorm}`);
    forms.add(`ل${bare}`);
    forms.add(`لل${bare}`);
  }
  for (const p of SINGLE_PREFIXES) {
    forms.add(`${p}${baseNorm}`);
  }
  return forms;
}

export interface LyricValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateLyrics(
  lines: string[],
  settings?: {
    rhyme_scheme?: RhymeScheme;
    lines_per_song?: number;
    max_words_per_line?: number;
    forbidden_words?: string[];
    block_substrings?: boolean;
    no_numbers_prices_brands?: boolean;
  }
): LyricValidationResult {
  const errors: string[] = [];
  const targetLinesCount = settings?.lines_per_song ?? 6;
  const maxWords = settings?.max_words_per_line ?? 5;
  const blockSubstrings = settings?.block_substrings ?? true;
  const noNumbersPricesBrands = settings?.no_numbers_prices_brands ?? true;
  const activeForbiddenWords = settings?.forbidden_words ?? [
    ...FORBIDDEN_SINGLE_WORDS,
    ...FORBIDDEN_PHRASES,
  ];

  const nonEmptyLines = lines.map((l) => l.trim()).filter(Boolean);

  if (lines.length !== targetLinesCount || nonEmptyLines.length !== targetLinesCount) {
    errors.push(
      `Must have exactly ${targetLinesCount} non-empty lines (currently ${nonEmptyLines.length}).`
    );
  }

  lines.forEach((rawLine, idx) => {
    const lineNum = idx + 1;
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    const wc = countLineWords(trimmed);
    if (wc > maxWords) {
      errors.push(`Line ${lineNum} has ${wc} words (max ${maxWords} words per line).`);
    }

    if (noNumbersPricesBrands) {
      // Digits check (ASCII + Arabic-Indic + Extended Arabic-Indic)
      if (/[0-9\u0660-\u0669\u06F0-\u06F9]/.test(trimmed)) {
        errors.push(`Line ${lineNum} contains digits/numbers (numbers are not allowed).`);
      }

      // Currency symbol check
      if (/[$€£¥]/.test(trimmed)) {
        errors.push(`Line ${lineNum} contains a price/currency symbol.`);
      }

      // Latin word check (brands, product names, English/French)
      const latinMatch = trimmed.match(/[A-Za-z]{2,}/);
      if (latinMatch) {
        errors.push(
          `Line ${lineNum} contains non-Arabic text "${latinMatch[0]}" (no brands, French, or English).`
        );
      }
    }

    const normLine = normalizeArabicText(trimmed);
    const words = normLine ? normLine.split(" ") : [];
    const wordSet = new Set(words);

    // Check active forbidden words
    for (const forbidden of activeForbiddenWords) {
      const normForbidden = normalizeArabicText(forbidden);
      if (!normForbidden) continue;

      if (normForbidden.includes(" ")) {
        if (normLine.includes(normForbidden)) {
          errors.push(`Line ${lineNum} uses forbidden phrase "${forbidden}".`);
        }
      } else {
        const forms = buildWordForms(normForbidden);
        if (forbidden === "لمة") {
          forms.add("لمتنا");
          forms.add("ولمتنا");
          forms.add("لمتهم");
          forms.add("لمتكم");
        }
        if (forbidden === "طفا") {
          forms.add("طفات");
          forms.add("طفاو");
          forms.add("يطفا");
          forms.add("تطفا");
        }

        let found = false;
        for (const f of forms) {
          if (wordSet.has(f)) {
            errors.push(`Line ${lineNum} uses forbidden word "${forbidden}".`);
            found = true;
            break;
          }
        }

        // Also check if word contains forbidden substring when block_substrings is true
        if (!found && blockSubstrings && normForbidden.length >= 3) {
          for (const w of words) {
            if (w.includes(normForbidden) && w !== normForbidden) {
              errors.push(
                `Line ${lineNum} uses word "${w}" containing forbidden "${forbidden}".`
              );
              break;
            }
          }
        }
      }
    }

    if (noNumbersPricesBrands) {
      // Number words check
      for (const numWord of NUMBER_WORDS) {
        const forms = buildWordForms(normalizeArabicText(numWord));
        for (const f of forms) {
          if (wordSet.has(f)) {
            errors.push(`Line ${lineNum} uses number word "${numWord}" (no numbers allowed).`);
            break;
          }
        }
      }

      // Price words check
      for (const priceTerm of PRICE_TERMS) {
        const normPrice = normalizeArabicText(priceTerm);
        const forms = buildWordForms(normPrice);
        for (const f of forms) {
          if (wordSet.has(f)) {
            errors.push(`Line ${lineNum} mentions price/currency term "${priceTerm}".`);
            break;
          }
        }
      }

      // Brand/product names check
      for (const brand of BRAND_OR_PRODUCT_TERMS) {
        const normBrand = normalizeArabicText(brand);
        if (normBrand.includes(" ")) {
          if (normLine.includes(normBrand)) {
            errors.push(`Line ${lineNum} mentions brand/product "${brand}".`);
          }
        } else {
          const forms = buildWordForms(normBrand);
          for (const f of forms) {
            if (wordSet.has(f)) {
              errors.push(`Line ${lineNum} mentions brand/product "${brand}".`);
              break;
            }
          }
        }
      }
    }
  });

  for (const group of checkRhyme(lines, settings?.rhyme_scheme ?? "OFF").broken) {
    const numbers = group.map(i => i + 1).join(" and ");
    const words = group.map(i => JSON.stringify(lastArabicWord(lines[i]))).join(" vs ");
    errors.push(`Lines ${numbers} don't rhyme (${words}). Use distinct words with matching endings.`);
  }

  return {
    valid: errors.length === 0,
    errors: Array.from(new Set(errors)),
  };
}

function tokenizeDisplayAndNorm(text: string): { display: string; norm: string }[] {
  const rawTokens = text.trim().split(/\s+/).filter(Boolean);
  const tokens: { display: string; norm: string }[] = [];
  for (const raw of rawTokens) {
    const cleanDisplay = raw.replace(/[.,،؛؟!:"'()[\]{}\-_/\\]+/g, "").trim();
    const norm = normalizeArabicText(raw);
    if (!norm) continue;
    // Handle cases where punctuation split a token into multiple normalized words
    const subNorms = norm.split(" ").filter(Boolean);
    if (subNorms.length === 1) {
      tokens.push({ display: cleanDisplay || raw, norm: subNorms[0] });
    } else {
      for (const sub of subNorms) {
        tokens.push({ display: sub, norm: sub });
      }
    }
  }
  return tokens;
}

export interface TranscriptComparison {
  words_heard_pct: number;
  transcribed_text: string;
  missing_words: string[];
  extra_words: string[];
}

export function compareTranscriptInOrder(
  lyricLines: string[],
  transcribedText: string
): TranscriptComparison {
  const expected = tokenizeDisplayAndNorm(lyricLines.join(" "));
  const heard = tokenizeDisplayAndNorm(transcribedText);

  const n = expected.length;
  const m = heard.length;

  // LCS DP table for in-order word alignment
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (expected[i - 1].norm === heard[j - 1].norm) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = dp[i - 1][j] >= dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1];
      }
    }
  }

  const matchedExpected = new Set<number>();
  const matchedHeard = new Set<number>();
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (expected[i - 1].norm === heard[j - 1].norm) {
      matchedExpected.add(i - 1);
      matchedHeard.add(j - 1);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  const missing_words = expected
    .filter((_, idx) => !matchedExpected.has(idx))
    .map((t) => t.display);
  const extra_words = heard
    .filter((_, idx) => !matchedHeard.has(idx))
    .map((t) => t.display);

  const lcsLen = dp[n][m];
  const words_heard_pct = n > 0 ? Math.round((lcsLen / n) * 100) : 0;

  return {
    words_heard_pct,
    transcribed_text: transcribedText.trim(),
    missing_words,
    extra_words,
  };
}
