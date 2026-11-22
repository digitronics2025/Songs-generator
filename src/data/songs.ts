import { DEFAULT_AUTOPILOT, type AutopilotSettings } from "../lib/autopilot.ts";
import type { AdminFeeling } from "../lib/lyricQuality.ts";
import type { GenerationFailureDetail, ProposedLyric, RepairLogEntry } from "../lib/songRepair.ts";

export type SongStatus =
  | "draft"
  | "lyric_approved"
  | "generating"
  | "ready"
  | "approved"
  | "failed"
  | "needs_person"
  | "archived";

export interface SongTake {
  id: string;
  take_number: number;
  model: string;
  storage_path: string | null;
  download_url?: string | null;
  duration_seconds: number | null;
  lufs: number | null;
  true_peak_db: number | null;
  words_heard_pct: number | null;
  missing_words: string[];
  extra_words: string[];
  voice_start: number | null;
  voice_end: number | null;
  cost_estimate: number;
  created_at: string;
  status: "ready" | "failed" | "generating";
  is_approved?: boolean;
  auto_approved?: boolean;
  lyric_revision?: string;
  passed_all_checks?: boolean;
  failure_reasons?: string[];
  failure_detail?: GenerationFailureDetail | null;
  vocal_check_pending?: boolean;
  raw_storage_path?: string | null;
  transcribed_text?: string | null;
  repeated_words?: string[];
  ownerId: string;
  tempo_bpm?: number;
}

export interface SongHistoryItem {
  id: string;
  song_id: string;
  song_number: number;
  title: string;
  lines: string[];
  admin_feeling: string;
  action: "created" | "edited" | "archived" | "restored" | "migrated" | "lyric_approved" | "imported";
  source?: string;
  timestamp: string;
  ownerId: string;
}

export interface StudioSettings {
  feelings: string[];
  lines_per_song: number;
  rhyme_scheme: "AABB" | "ABAB" | "MONO" | "OFF";
  max_words_per_line: number;
  forbidden_words: string[];
  block_substrings: boolean;
  no_numbers_prices_brands: boolean;
  default_model: string;
  text_model: string;
  autopilot: AutopilotSettings;
  quality_checks: boolean;
  target_length: number;
  daily_budget_usd: number;
  updated_at: string;
  ownerId: string;
}

export const DEFAULT_STUDIO_SETTINGS: StudioSettings = {
  feelings: [
    "mothers_care",
    "fathers_pride",
    "family_evening",
    "ramadan_ftour",
    "eid_morning",
    "calling_home",
    "summer_at_home",
    "new_home",
  ],
  lines_per_song: 6,
  rhyme_scheme: "AABB",
  max_words_per_line: 5,
  forbidden_words: [
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
  ],
  block_substrings: true,
  no_numbers_prices_brands: true,
  default_model: "lyria-3-clip-preview",
  text_model: "gemini-4-hydrogen",
  autopilot: DEFAULT_AUTOPILOT,
  quality_checks: false,
  target_length: 30,
  daily_budget_usd: 0,
  updated_at: "",
  ownerId: "",
};

export interface SongSpec {
  number: number;
  feeling_key: string;
  admin_feeling: AdminFeeling;
  title: string;
  theme: string;
  lines: string[];
  mood: string;
  tempo_bpm: number;
  instruments: string;
  vocal_tone: string;
}

export interface SongState {
  auto_approved?: boolean;
  archive_reason?: string | null;
  id: string;
  number: number;
  title: string;
  lines: string[];
  admin_feeling: string;
  feeling_key: string;
  theme: string;
  mood: string;
  tempo_bpm: number;
  instruments: string;
  vocal_tone: string;
  status: string;
  closest_match_pct?: number;
  best_take_id: string | null;
  created_at: string;
  updated_at: string;
  archived: boolean;
  ownerId: string;

  // Resolved active audio & playback fields
  model_used?: string | null;
  duration_seconds?: number | null;
  lufs?: number | null;
  true_peak_db?: number | null;
  file_name?: string;
  storage_path?: string | null;
  download_url?: string | null;
  generated_at?: string | null;
  error_message?: string | null;
  words_heard_pct?: number | null;
  transcribed_text?: string | null;
  missing_words?: string[];
  extra_words?: string[];
  voice_start_seconds?: number | null;
  voice_end_seconds?: number | null;
  takes?: SongTake[];
  repair_logs?: RepairLogEntry[];
  proposed_lyric?: ProposedLyric | null;
  needs_person_reason?: string | null;
  automatic_takes_today?: number;
  last_take_date?: string | null;
  approved_take_id?: string | null;
  daily_budget_usd?: number | null;
}

export interface SongsJsonEntry {
  id: string;
  number: number;
  feeling_key: string;
  admin_feeling: string;
  title: string;
  theme: string;
  lyric: string;
  duration_seconds: number;
  mood: string;
  tempo_bpm: number;
  words_heard_pct: number | null;
  transcribed_text: string | null;
  missing_words: string[];
  extra_words: string[];
  voice_start_seconds: number | null;
  voice_end_seconds: number | null;
}

export function formatSongFilename(
  number: number,
  feelingKey: string,
  ext: "wav" | "mp3" = "wav"
): string {
  const padded = String(number).padStart(2, "0");
  return `${padded}-${feelingKey}.${ext}`;
}

export function countArabicWords(line: string): number {
  const trimmed = line.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export const MAX_DRAFT_BATCH = 12;

export const INITIAL_SONGS: SongSpec[] = [
  {
    number: 1,
    feeling_key: "mothers_prayers",
    admin_feeling: "mothers_care",
    title: "دعاوي الواليدة",
    theme: "a mother's prayers that follow you everywhere",
    lines: [
      "دعاوي الواليدة معايا",
      "فين ما مشيت",
      "كنحس بيها حدايا",
      "رضاها ضو طريقي",
      "وكلمتها كتقويني",
      "يا ربي خليها ليا",
    ],
    mood: "Tender & grateful",
    tempo_bpm: 76,
    instruments: "Warm acoustic oud, delicate qanun arpeggios, soft nylon guitar",
    vocal_tone: "Warm intimate female solo voice, gentle and heartfelt",
  },
  {
    number: 2,
    feeling_key: "fathers_effort",
    admin_feeling: "fathers_pride",
    title: "تعب الواليد",
    theme: "a father who worked hard all his life for us",
    lines: [
      "يدين بابا تعبانين",
      "خرج بكري للخدمة",
      "باش ما نخصو والو",
      "كبرنا ونتا صابر",
      "دابا جا دورنا",
      "نردو ليك الفرحة",
    ],
    mood: "Respectful & heartfelt",
    tempo_bpm: 74,
    instruments: "Solo nylon guitar, warm oud counter-melody, soft upright piano",
    vocal_tone: "Clear soulful male baritone solo, steady and warm",
  },
  {
    number: 3,
    feeling_key: "grandparents",
    admin_feeling: "family_evening",
    title: "دار جدتي",
    theme: "grandmother's stories and her warm house",
    lines: [
      "دار جدتي دافية",
      "الحكايات قبل النعاس",
      "يديها فيهم البركة",
      "والخبز سخون فالفران",
      "كنرجعو ليها صغار",
      "جدتي نوارة قلوبنا",
    ],
    mood: "Nostalgic & comforting",
    tempo_bpm: 72,
    instruments: "Gentle qanun, mellow oud, soft felt piano chords",
    vocal_tone: "Soft nostalgic female alto solo, clear storytelling delivery",
  },
  {
    number: 4,
    feeling_key: "far_from_home",
    admin_feeling: "calling_home",
    title: "التيليفون كيقربنا",
    theme: "calling family on the phone from far away, hearing their voice",
    lines: [
      "بيناتنا بحر وبلاد",
      "والتيليفون كيقربنا",
      "كتقولي واش كليتي",
      "كنضحك وعيني دامعة",
      "قلبي ساكن معاكم",
      "حتى يجمعنا اللقا",
    ],
    mood: "Longing turning hopeful",
    tempo_bpm: 75,
    instruments: "Fingerpicked acoustic guitar, delicate oud, warm piano sustain",
    vocal_tone: "Expressive tender male tenor solo, earnest and clear",
  },
  {
    number: 5,
    feeling_key: "siblings",
    admin_feeling: "family_evening",
    title: "خويا سندي",
    theme: "my brother/sister is my support",
    lines: [
      "خويا يا سندي",
      "طحت ورفدتيني",
      "كبرنا فنفس البيت",
      "وتقاسمنا الخبزة",
      "ختي ضحكة الدار",
      "حنا ديما يد وحدة",
    ],
    mood: "Warm & supportive",
    tempo_bpm: 84,
    instruments: "Bright oud melody, rhythmic nylon guitar, soft brushed darbuka",
    vocal_tone: "Warm confident male solo voice, clear and friendly",
  },
  {
    number: 6,
    feeling_key: "childhood_friends",
    admin_feeling: "family_evening",
    title: "صحاب الدرب",
    theme: "friends from the neighbourhood, memories of playing outside",
    lines: [
      "صحاب الدرب القدام",
      "الكورة والضحك برا",
      "كبرنا وتفرقنا شوية",
      "والقلب باقي كيعقل",
      "نتلاقاو ونرجعو صغار",
      "صحبة ما كتنساش",
    ],
    mood: "Playful & nostalgic",
    tempo_bpm: 92,
    instruments: "Cheerful acoustic guitar, lively oud, light soft darbuka pulse",
    vocal_tone: "Bright smiling male solo voice, relaxed nostalgic phrasing",
  },
  {
    number: 7,
    feeling_key: "true_friend",
    admin_feeling: "calling_home",
    title: "صاحبي ف الشدة",
    theme: "the friend who stayed in hard times",
    lines: [
      "فالشدة عيطت عليك",
      "جيتي بلا ما نطلب",
      "وقفتي معايا حتى ناضيت",
      "الصاحب الصح باين",
      "كلامك كيكفيني",
      "ربي يدوم صحبتنا",
    ],
    mood: "Sincere & reassuring",
    tempo_bpm: 78,
    instruments: "Warm acoustic piano, mellow oud, very soft hand percussion",
    vocal_tone: "Calm grounded male solo voice, sincere and unhurried",
  },
  {
    number: 8,
    feeling_key: "first_rain",
    admin_feeling: "family_evening",
    title: "الشتا الأولى",
    theme: "the smell of the first rain, children at the window",
    lines: [
      "الشتا الأولى جات",
      "ريحة التراب فالزنقة",
      "الصغار حدا الشرجم",
      "كيحسبو النقط بفرحة",
      "والدار دافية بينا",
      "خير نازل من السما",
    ],
    mood: "Gentle wonder & joy",
    tempo_bpm: 82,
    instruments: "Rippling qanun notes, bright felt piano, soft acoustic guitar",
    vocal_tone: "Clear sweet female solo voice, gentle and airy",
  },
  {
    number: 9,
    feeling_key: "winter_warmth",
    admin_feeling: "family_evening",
    title: "دفا الدار",
    theme: "cold outside, warm home and tea together",
    lines: [
      "البرد قاصح برا",
      "وحنا تحت البطانية",
      "الماما جابت البيصارة",
      "والحكايات بلا نهاية",
      "الدفا فقلوبنا",
      "دارنا هي الأمان",
    ],
    mood: "Cozy & peaceful",
    tempo_bpm: 73,
    instruments: "Soft felt piano, warm intimate oud, subtle qanun accents",
    vocal_tone: "Cozy warm female alto solo, calm fireside delivery",
  },
  {
    number: 10,
    feeling_key: "summer_sea",
    admin_feeling: "summer_at_home",
    title: "صيف البحر",
    theme: "summer holidays, family at the beach",
    lines: [
      "جينا للبحر كاملين",
      "الرملة سخونة والموج",
      "الصغار كيجريو ويضحكو",
      "بابا كيعوم معاهم",
      "والماما تحت الظل",
      "صيف كيبقى فالبال",
    ],
    mood: "Sunny & joyful",
    tempo_bpm: 96,
    instruments: "Breezy nylon guitar, bright upbeat oud, light coastal darbuka",
    vocal_tone: "Light joyful female solo voice, sunny and crisp",
  },
  {
    number: 11,
    feeling_key: "new_morning",
    admin_feeling: "new_home",
    title: "صباح جديد",
    theme: "a fresh morning, a new start",
    lines: [
      "صباح جديد بدا",
      "الشمس دخلات الشرجم",
      "نسينا تعب البارح",
      "وفتحنا قلب جديد",
      "خطوة بخطوة نوصلو",
      "الخير جاي لينا",
    ],
    mood: "Fresh & optimistic",
    tempo_bpm: 88,
    instruments: "Crisp acoustic piano, uplifting nylon guitar, gentle qanun shimmer",
    vocal_tone: "Bright optimistic male solo voice, clear morning energy",
  },
  {
    number: 12,
    feeling_key: "graduation",
    admin_feeling: "mothers_care",
    title: "نجحت يا مي",
    theme: "passing the exam, parents' proud tears",
    lines: [
      "نجحت يا مي",
      "الورقة فيدي",
      "دموعك ديال الفرح",
      "سهرتي معايا بزاف",
      "هاد النجاح ديالك",
      "وكل تعبك ما ضاع",
    ],
    mood: "Proud & uplifting",
    tempo_bpm: 90,
    instruments: "Uplifting piano chords, warm oud melody, gentle celebratory darbuka",
    vocal_tone: "Youthful proud female solo voice, emotional and clear",
  },
  {
    number: 13,
    feeling_key: "first_salary",
    admin_feeling: "mothers_care",
    title: "أول خلصة",
    theme: "first salary, buying a gift for the parents",
    lines: [
      "أول خلصة فجيبي",
      "دخلت للدار فرحان",
      "هدية صغيرة لماما",
      "عنقاتني وضحكات",
      "قالت كبرتي يا وليدي",
      "فرحتها هي الكنز",
    ],
    mood: "Grateful & proud",
    tempo_bpm: 86,
    instruments: "Warm acoustic guitar, joyful oud lead, light hand percussion",
    vocal_tone: "Warm earnest male solo voice, smiling delivery",
  },
  {
    number: 14,
    feeling_key: "small_dream",
    admin_feeling: "new_home",
    title: "حلمي الصغير",
    theme: "starting a small business from nothing",
    lines: [
      "حلمي صغير فالبداية",
      "حانوت وباب مفتوح",
      "خدمت بالصبر والنية",
      "كل صباح نزيد شوية",
      "الحلم كيكبر معايا",
      "ربي كيفتح الأبواب",
    ],
    mood: "Determined & hopeful",
    tempo_bpm: 87,
    instruments: "Steady acoustic guitar, inspiring piano, warm oud accompaniment",
    vocal_tone: "Clear determined female solo voice, hopeful and steady",
  },
  {
    number: 15,
    feeling_key: "falling_rising",
    admin_feeling: "fathers_pride",
    title: "طحت ونضت",
    theme: "falling down and standing up again",
    lines: [
      "طحت مرة ومرة",
      "بابا قال لي نوض",
      "الطيحة ماشي النهاية",
      "نفضت الغبرة ومشيت",
      "وقلبي ولا قوي",
      "شكرا على يدك",
    ],
    mood: "Resilient & uplifting",
    tempo_bpm: 85,
    instruments: "Acoustic guitar pulse, expressive oud, hopeful upright piano",
    vocal_tone: "Resilient warm male tenor solo, calm strength",
  },
  {
    number: 16,
    feeling_key: "patience",
    admin_feeling: "fathers_pride",
    title: "الصبر مفتاح",
    theme: "patience in hard days, better days are coming",
    lines: [
      "الأيام صعيبة شوية",
      "بابا قال صبر",
      "الصبر مفتاح الفرج",
      "الغيمة كتدوز ديما",
      "والشمس كترجع تبان",
      "غدا يكون زوين",
    ],
    mood: "Calm & hopeful",
    tempo_bpm: 74,
    instruments: "Contemplative qanun, soft warm piano, mellow acoustic oud",
    vocal_tone: "Soothing calm female solo voice, gentle reassurance",
  },
  {
    number: 17,
    feeling_key: "wedding_joy",
    admin_feeling: "eid_morning",
    title: "فرحة العرس",
    theme: "a family wedding, everyone happy together",
    lines: [
      "الدار مزوقة بالنوار",
      "الزغاريد فكل جيهة",
      "العروسة بحال القمر",
      "الحبايب جاو كاملين",
      "الطبل والفرح يشطح",
      "ربي يتمم بالخير",
    ],
    mood: "Festive & joyful",
    tempo_bpm: 98,
    instruments: "Joyful Moroccan oud, bright qanun flourishes, light festive darbuka",
    vocal_tone: "Joyful celebratory female solo voice, clear and radiant",
  },
  {
    number: 18,
    feeling_key: "new_baby",
    admin_feeling: "new_home",
    title: "ضيف جديد",
    theme: "a new baby arrives in the house",
    lines: [
      "ضيف صغير وصل",
      "عينيه كيضويو الدار",
      "ماما كتغني ليه",
      "وبابا ما كينعسش",
      "يدو صغيرة فيدي",
      "مرحبا بيك يا قلبي",
    ],
    mood: "Sweet & tender",
    tempo_bpm: 78,
    instruments: "Delicate lullaby piano, soft acoustic guitar, gentle qanun",
    vocal_tone: "Tender gentle female solo voice, lullaby warmth",
  },
  {
    number: 19,
    feeling_key: "eid_together",
    admin_feeling: "eid_morning",
    title: "طبلة الصباح",
    theme: "Eid morning, the whole family at one table",
    lines: [
      "طبلة الصباح عامرة",
      "الملوي والمسمن سخون",
      "الجلابة جديدة ومكوية",
      "الدراري كيبوسو اليدين",
      "الأهل كاملين حاضرين",
      "فرحة كتجمعنا",
    ],
    mood: "Warm & celebratory",
    tempo_bpm: 92,
    instruments: "Festive warm oud, cheerful nylon guitar, soft darbuka rhythm",
    vocal_tone: "Warm joyful male solo voice, welcoming family feel",
  },
  {
    number: 20,
    feeling_key: "small_gift",
    admin_feeling: "fathers_pride",
    title: "هدية صغيرة",
    theme: "a small gift that says \"I remember you\"",
    lines: [
      "هدية صغيرة فيدي",
      "لبابا اللي عطا بزاف",
      "ماشي غالية بالثمن",
      "غالية بالمعنى",
      "قلت ليه ما نسيتكش",
      "وضحكتو كانت الجواب",
    ],
    mood: "Affectionate & gentle",
    tempo_bpm: 80,
    instruments: "Intimate nylon guitar, soft warm piano, subtle oud accent",
    vocal_tone: "Warm affectionate female solo voice, close and clear",
  },
];
