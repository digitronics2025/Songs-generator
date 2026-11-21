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
  childhood_friends: "summer_at_home",
  true_friend: "family_evening",
  first_rain: "family_evening",
  winter_warmth: "family_evening",
  summer_sea: "summer_at_home",
  new_morning: "new_home",
  graduation: "fathers_pride",
  first_salary: "fathers_pride",
  small_dream: "new_home",
  falling_rising: "fathers_pride",
  patience: "mothers_care",
  wedding_joy: "family_evening",
  new_baby: "new_home",
  eid_together: "eid_morning",
  small_gift: "mothers_care",
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
  "ثمن",
  "الثمن",
  "بثمن",
  "سعر",
  "السعر",
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
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    // Normalize alef forms, alef maqsura, teh marbuta
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    // Strip punctuation
    .replace(/[.,،؛؟!:"'()[\]{}\-_/\\~`@#$%^&*+=<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

export function validateLyrics(lines: string[]): LyricValidationResult {
  const errors: string[] = [];
  const nonEmptyLines = lines.map((l) => l.trim()).filter(Boolean);

  if (lines.length !== 6 || nonEmptyLines.length !== 6) {
    errors.push(`Must have exactly 6 non-empty lines (currently ${nonEmptyLines.length}).`);
  }

  lines.forEach((rawLine, idx) => {
    const lineNum = idx + 1;
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    const wc = countLineWords(trimmed);
    if (wc > 5) {
      errors.push(`Line ${lineNum} has ${wc} words (max 5 words per line).`);
    }

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

    const normLine = normalizeArabicText(trimmed);
    const words = normLine ? normLine.split(" ") : [];
    const wordSet = new Set(words);

    // Forbidden phrases
    for (const phrase of FORBIDDEN_PHRASES) {
      const normPhrase = normalizeArabicText(phrase);
      if (
        normLine.includes(normPhrase) ||
        normLine.includes("الليل والنهار") ||
        normLine.includes("ليل نهار")
      ) {
        errors.push(`Line ${lineNum} uses forbidden phrase "${phrase}".`);
      }
    }

    // Forbidden single words
    for (const forbidden of FORBIDDEN_SINGLE_WORDS) {
      const forms = buildWordForms(normalizeArabicText(forbidden));
      // Also catch lma with possessive like لمتنا
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
      for (const f of forms) {
        if (wordSet.has(f)) {
          errors.push(`Line ${lineNum} uses forbidden word "${forbidden}".`);
          break;
        }
      }
    }

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
  });

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
