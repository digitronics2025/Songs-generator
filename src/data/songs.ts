import type { AdminFeeling } from "../lib/lyricQuality.ts";

export type SongStatus = "pending" | "generating" | "ready" | "error";

export interface SongSpec {
  number: number;
  feeling_key: string;
  title: string;
  theme: string;
  lines: string[];
  mood: string;
  tempo_bpm: number;
  instruments: string;
  vocal_tone: string;
}

export interface SongState extends SongSpec {
  admin_feeling: AdminFeeling;
  model_used: string | null;
  status: SongStatus;
  duration_seconds: number | null;
  lufs: number | null;
  true_peak_db: number | null;
  file_name: string;
  storage_path: string | null;
  download_url: string | null;
  generated_at: string | null;
  error_message: string | null;
  words_heard_pct: number | null;
  transcribed_text: string | null;
  missing_words: string[];
  extra_words: string[];
  voice_start_seconds: number | null;
  voice_end_seconds: number | null;
  ownerId: string;
}

export interface SongsJsonEntry {
  number: number;
  feeling_key: string;
  admin_feeling: AdminFeeling;
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

export function formatSongFilename(number: number, feelingKey: string, ext: "wav" | "mp3" = "wav"): string {
  const padded = String(number).padStart(2, "0");
  return `${padded}-${feelingKey}.${ext}`;
}

export function countArabicWords(line: string): number {
  const trimmed = line.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export const INITIAL_SONGS: SongSpec[] = [
  {
    number: 1,
    feeling_key: "mothers_prayers",
    title: "دعاوي الواليدة",
    theme: "a mother's prayers that follow you everywhere",
    lines: [
      "دعاوي الواليدة ديما تابعة خطواتي",
      "فين ما مشيت كنلقى بركتها معايا",
      "رضاها ضو كينور كاع طريق حياتي",
      "الله يخليك ليا يا تاج راسي",
    ],
    mood: "Tender & grateful",
    tempo_bpm: 76,
    instruments: "Warm acoustic oud, delicate qanun arpeggios, soft nylon guitar",
    vocal_tone: "Warm intimate female solo voice, gentle and heartfelt",
  },
  {
    number: 2,
    feeling_key: "fathers_effort",
    title: "تعب الواليد",
    theme: "a father who worked hard all his life for us",
    lines: [
      "تعب الواليد باين ف يديه الصابرة",
      "خرج من الصباح باش يفرحنا فالدار",
      "عمرنا ما نسينا خيره ووقفته معانا",
      "اليوم نردو الفرحة لقلبه الكبير",
    ],
    mood: "Respectful & heartfelt",
    tempo_bpm: 74,
    instruments: "Solo nylon guitar, warm oud counter-melody, soft upright piano",
    vocal_tone: "Clear soulful male baritone solo, steady and warm",
  },
  {
    number: 3,
    feeling_key: "grandparents",
    title: "دار جدتي",
    theme: "grandmother's stories and her warm house",
    lines: [
      "دار جدتي عامرة بحكايات زمان الزينة",
      "ريحة الخبز السخون وضحكتها الحنينة",
      "كنجلسو حداها وننساو هموم الدنيا",
      "بركة الكبار كتبقى ديما ف قلوبنا",
    ],
    mood: "Nostalgic & comforting",
    tempo_bpm: 72,
    instruments: "Gentle qanun, mellow oud, soft felt piano chords",
    vocal_tone: "Soft nostalgic female alto solo, clear storytelling delivery",
  },
  {
    number: 4,
    feeling_key: "far_from_home",
    title: "صوتكم كيوصلني",
    theme: "calling family on the phone from far away, hearing their voice",
    lines: [
      "صوتكم كيوصلني واخا الغربة بعيدة بزاف",
      "مكالمة وحدة منكم كترد ليا الروح",
      "توحشت لمتنا على طبلة وحدة فالدار",
      "قريب نرجع ونفرحو كاملين كيف ديما",
    ],
    mood: "Longing turning hopeful",
    tempo_bpm: 75,
    instruments: "Fingerpicked acoustic guitar, delicate oud, warm piano sustain",
    vocal_tone: "Expressive tender male tenor solo, earnest and clear",
  },
  {
    number: 5,
    feeling_key: "siblings",
    title: "خويا سندي",
    theme: "my brother/sister is my support",
    lines: [
      "خويا سندي وكتفي ف وقت الضيق",
      "ضحكنا كبر مع بعضنا ف نفس الدار",
      "واخا نبعدو كيبقى الدم ديما جامعنا",
      "الله يخلي خوتي عزوتي طول العمر",
    ],
    mood: "Warm & supportive",
    tempo_bpm: 84,
    instruments: "Bright oud melody, rhythmic nylon guitar, soft brushed darbuka",
    vocal_tone: "Warm confident male solo voice, clear and friendly",
  },
  {
    number: 6,
    feeling_key: "childhood_friends",
    title: "صحاب الدرب",
    theme: "friends from the neighbourhood, memories of playing outside",
    lines: [
      "صحاب الدرب واللعب تحت شمس العشية",
      "كنا صغار والضحكة طالعة من القلب",
      "كبرنا وبقات ديك الذكريات حية فينا",
      "فين ما تلاقينا كترجع لينا الفرحة",
    ],
    mood: "Playful & nostalgic",
    tempo_bpm: 92,
    instruments: "Cheerful acoustic guitar, lively oud, light soft darbuka pulse",
    vocal_tone: "Bright smiling male solo voice, relaxed nostalgic phrasing",
  },
  {
    number: 7,
    feeling_key: "true_friend",
    title: "صاحبي ف الشدة",
    theme: "the friend who stayed in hard times",
    lines: [
      "صاحبي ف الشدة بقى واقف بجنبي",
      "ما تبدلش عليا نهار ضاقت الدنيا",
      "كلمة زوينة منو هونت كل صعيب",
      "الصاحب الوفي رزق من عند الله",
    ],
    mood: "Sincere & reassuring",
    tempo_bpm: 78,
    instruments: "Warm acoustic piano, mellow oud, very soft hand percussion",
    vocal_tone: "Calm grounded male solo voice, sincere and unhurried",
  },
  {
    number: 8,
    feeling_key: "first_rain",
    title: "الشتا الأولى",
    theme: "the smell of the first rain, children at the window",
    lines: [
      "الشتا الأولى طاحت وفاحت ريحة التراب",
      "الدراري حدا الشرجم فرحانين بالقطرات كيطيحو",
      "غسلات الجو وجابت معاها الخير والبركة",
      "غدا يكون أخضر وزين بإذن الله",
    ],
    mood: "Gentle wonder & joy",
    tempo_bpm: 82,
    instruments: "Rippling qanun notes, bright felt piano, soft acoustic guitar",
    vocal_tone: "Clear sweet female solo voice, gentle and airy",
  },
  {
    number: 9,
    feeling_key: "winter_warmth",
    title: "دفا الدار",
    theme: "cold outside, warm home and tea together",
    lines: [
      "دفا الدار كينسينا برد الليل الطويل",
      "براد أتاي مشحر والعائلة مجموعة حدا بعضها",
      "هدرة حلوة وضحكة دافية ترد البال مرتاح",
      "ما كاين ما حسن من لمتنا فالبرد",
    ],
    mood: "Cozy & peaceful",
    tempo_bpm: 73,
    instruments: "Soft felt piano, warm intimate oud, subtle qanun accents",
    vocal_tone: "Cozy warm female alto solo, calm fireside delivery",
  },
  {
    number: 10,
    feeling_key: "summer_sea",
    title: "صيف البحر",
    theme: "summer holidays, family at the beach",
    lines: [
      "صيف البحر وموجه الأزرق كينادي علينا",
      "العائلة فرحانة والرملة سخونة تحت رجلينا",
      "ضحك ولعب ونهار زوين بلا حساب",
      "الصيف مع الحباب أحلى وقت فالعام",
    ],
    mood: "Sunny & joyful",
    tempo_bpm: 96,
    instruments: "Breezy nylon guitar, bright upbeat oud, light coastal darbuka",
    vocal_tone: "Light joyful female solo voice, sunny and crisp",
  },
  {
    number: 11,
    feeling_key: "new_morning",
    title: "صباح جديد",
    theme: "a fresh morning, a new start",
    lines: [
      "صباح جديد فتح بابو بضو الشمس",
      "نسيم الفجر كيبشر بيوم كله خير",
      "نوض بالنية الصافية والابتسامة على وجهك",
      "كل نهار فرصة زوينة نبداو من جديد",
    ],
    mood: "Fresh & optimistic",
    tempo_bpm: 88,
    instruments: "Crisp acoustic piano, uplifting nylon guitar, gentle qanun shimmer",
    vocal_tone: "Bright optimistic male solo voice, clear morning energy",
  },
  {
    number: 12,
    feeling_key: "graduation",
    title: "نجحت يا مي",
    theme: "passing the exam, parents' proud tears",
    lines: [
      "نجحت يا مي وشوفي دموع الفرحة",
      "سهر الليالي والتعب كامل جاب ثمارو",
      "فرحتكم بيا هي أكبر جائزة فحياتي",
      "دابا نبداو طريق جديد وراسي مرفوع",
    ],
    mood: "Proud & uplifting",
    tempo_bpm: 90,
    instruments: "Uplifting piano chords, warm oud melody, gentle celebratory darbuka",
    vocal_tone: "Youthful proud female solo voice, emotional and clear",
  },
  {
    number: 13,
    feeling_key: "first_salary",
    title: "أول خلصة",
    theme: "first salary, buying a gift for the parents",
    lines: [
      "أول خلصة جاتني وفكرت ف الدار",
      "شريت هدية بسيطة للواليدة والواليد العزيز",
      "فرحتهم صغيرة ولكن معناها عندي كبير",
      "الرزق الحلال كيحلى ملي يتقسم مع الحباب",
    ],
    mood: "Grateful & proud",
    tempo_bpm: 86,
    instruments: "Warm acoustic guitar, joyful oud lead, light hand percussion",
    vocal_tone: "Warm earnest male solo voice, smiling delivery",
  },
  {
    number: 14,
    feeling_key: "small_dream",
    title: "حلمي الصغير",
    theme: "starting a small business from nothing",
    lines: [
      "حلمي الصغير بديتو من والو بيديا",
      "خطوة بخطوة والصبر زادني قوة كبيرة",
      "واخا الطريق طويل الأمل ديما قدامي",
      "غادي نوصل بالعمل والنية الصافية ديما",
    ],
    mood: "Determined & hopeful",
    tempo_bpm: 87,
    instruments: "Steady acoustic guitar, inspiring piano, warm oud accompaniment",
    vocal_tone: "Clear determined female solo voice, hopeful and steady",
  },
  {
    number: 15,
    feeling_key: "falling_rising",
    title: "طحت ونضت",
    theme: "falling down and standing up again",
    lines: [
      "طحت ونضت وتعلمت نقف على رجلي",
      "الخسارة علماتني نصبر ونزيد القدام",
      "الضلام كيدوز وكيجي موراه نهار ضاوي",
      "أنا أقوى اليوم وغدا أحسن بزاف",
    ],
    mood: "Resilient & uplifting",
    tempo_bpm: 85,
    instruments: "Acoustic guitar pulse, expressive oud, hopeful upright piano",
    vocal_tone: "Resilient warm male tenor solo, calm strength",
  },
  {
    number: 16,
    feeling_key: "patience",
    title: "الصبر مفتاح",
    theme: "patience in hard days, better days are coming",
    lines: [
      "الصبر مفتاح كل باب مسدود اليوم",
      "واخا الأيام صعيبة الفرج قريب كيجي",
      "خلي قلبك هاني وزيد خطوة لقدام",
      "بعد الشدة ديما كتجي أيام الفرح",
    ],
    mood: "Calm & hopeful",
    tempo_bpm: 74,
    instruments: "Contemplative qanun, soft warm piano, mellow acoustic oud",
    vocal_tone: "Soothing calm female solo voice, gentle reassurance",
  },
  {
    number: 17,
    feeling_key: "wedding_joy",
    title: "فرحة العرس",
    theme: "a family wedding, everyone happy together",
    lines: [
      "فرحة العرس ضوات الدار بالزغاريد والضحك",
      "العائلة كلها مجموعة لابسة أحسن ما كاين",
      "دقة خفيفة وفرحة طالعة من كل قلب",
      "الله يكمل بالخير ويدوم الفرح ديما",
    ],
    mood: "Festive & joyful",
    tempo_bpm: 98,
    instruments: "Joyful Moroccan oud, bright qanun flourishes, light festive darbuka",
    vocal_tone: "Joyful celebratory female solo voice, clear and radiant",
  },
  {
    number: 18,
    feeling_key: "new_baby",
    title: "ضيف جديد",
    theme: "a new baby arrives in the house",
    lines: [
      "ضيف جديد نور الدار ببسمة بريئة",
      "يديه صغار وجاب معاه فرحة كبيرة",
      "كل واحد فالعائلة فرحان وبغا يهزو",
      "يكبر ف عزنا ويتربى فالمحبة والخير",
    ],
    mood: "Sweet & tender",
    tempo_bpm: 78,
    instruments: "Delicate lullaby piano, soft acoustic guitar, gentle qanun",
    vocal_tone: "Tender gentle female solo voice, lullaby warmth",
  },
  {
    number: 19,
    feeling_key: "eid_together",
    title: "العيد فالدار",
    theme: "Eid morning, the whole family at one table",
    lines: [
      "العيد فالدار والطبلة عامرة بالخير والحلوى",
      "التسامح والمحبة والضحكة دايرة بين الحباب",
      "الكبار والصغار فرحانين بهاد الصباح الزين",
      "كل عام وحنا مجموعين على خير",
    ],
    mood: "Warm & celebratory",
    tempo_bpm: 92,
    instruments: "Festive warm oud, cheerful nylon guitar, soft darbuka rhythm",
    vocal_tone: "Warm joyful male solo voice, welcoming family feel",
  },
  {
    number: 20,
    feeling_key: "small_gift",
    title: "هدية صغيرة",
    theme: "a small gift that says \"I remember you\"",
    lines: [
      "هدية صغيرة كتقول ليك راني تفكرتك",
      "ماشي بالقيمة ولكن بالمحبة اللي فيها",
      "ابتسامة على وجهك تساوي الدنيا كاملة",
      "الحباب يستاهلو كل كلمة طيبة منا",
    ],
    mood: "Affectionate & gentle",
    tempo_bpm: 80,
    instruments: "Intimate nylon guitar, soft warm piano, subtle oud accent",
    vocal_tone: "Warm affectionate female solo voice, close and clear",
  },
];
