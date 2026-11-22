import { useState } from "react";
import {
  Save,
  RotateCcw,
  Check,
  Plus,
  X,
  Settings as SettingsIcon,
  ShieldAlert,
  Sliders,
} from "lucide-react";
import { DEFAULT_STUDIO_SETTINGS, type StudioSettings } from "../data/songs";

import { AutopilotPanel } from "./AutopilotPanel";

interface SettingsViewProps {
  settings: StudioSettings;
  onSaveSettings: (updated: StudioSettings) => Promise<void>;
}

export function SettingsView({ settings, onSaveSettings }: SettingsViewProps) {
  const [feelings, setFeelings] = useState<string[]>(settings.feelings);
  const [newFeeling, setNewFeeling] = useState("");

  const [linesPerSong, setLinesPerSong] = useState(settings.lines_per_song || 6);
  const [rhymeScheme, setRhymeScheme] = useState(settings.rhyme_scheme);
  const [maxWordsPerLine, setMaxWordsPerLine] = useState(
    settings.max_words_per_line || 5
  );

  const [forbiddenWords, setForbiddenWords] = useState<string[]>(
    settings.forbidden_words
  );
  const [newForbiddenWord, setNewForbiddenWord] = useState("");

  const [blockSubstrings, setBlockSubstrings] = useState(
    settings.block_substrings !== false
  );
  const [noNumbersPricesBrands, setNoNumbersPricesBrands] = useState(
    settings.no_numbers_prices_brands !== false
  );

  const [defaultModel, setDefaultModel] = useState(
    settings.default_model || "lyria-3-clip-preview"
  );
  const [autopilot, setAutopilot] = useState(settings.autopilot);
  const [textModel, setTextModel] = useState(settings.text_model);
  const [budget, setBudget] = useState(settings.daily_budget_usd);
  const [targetLength, setTargetLength] = useState(settings.target_length || 30);

  const [isSaving, setIsSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAddFeeling = () => {
    const trimmed = newFeeling.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
    if (!trimmed) return;
    if (feelings.includes(trimmed)) {
      setError(`Feeling "${trimmed}" already exists.`);
      return;
    }
    setFeelings([...feelings, trimmed]);
    setNewFeeling("");
    setError(null);
  };

  const handleRemoveFeeling = (f: string) => {
    if (feelings.length <= 1) {
      setError("At least one feeling category is required.");
      return;
    }
    setFeelings(feelings.filter((item) => item !== f));
  };

  const handleAddForbiddenWord = () => {
    const trimmed = newForbiddenWord.trim();
    if (!trimmed) return;
    if (forbiddenWords.includes(trimmed)) {
      setError(`Word "${trimmed}" already in forbidden list.`);
      return;
    }
    setForbiddenWords([...forbiddenWords, trimmed]);
    setNewForbiddenWord("");
    setError(null);
  };

  const handleRemoveForbiddenWord = (w: string) => {
    setForbiddenWords(forbiddenWords.filter((item) => item !== w));
  };

  const handleResetDefaults = () => {
    setFeelings(DEFAULT_STUDIO_SETTINGS.feelings);
    setLinesPerSong(DEFAULT_STUDIO_SETTINGS.lines_per_song);
    setRhymeScheme(DEFAULT_STUDIO_SETTINGS.rhyme_scheme);
    setMaxWordsPerLine(DEFAULT_STUDIO_SETTINGS.max_words_per_line);
    setForbiddenWords(DEFAULT_STUDIO_SETTINGS.forbidden_words);
    setBlockSubstrings(DEFAULT_STUDIO_SETTINGS.block_substrings);
    setNoNumbersPricesBrands(DEFAULT_STUDIO_SETTINGS.no_numbers_prices_brands);
    setDefaultModel(DEFAULT_STUDIO_SETTINGS.default_model);
    setAutopilot(DEFAULT_STUDIO_SETTINGS.autopilot);
    setTextModel(DEFAULT_STUDIO_SETTINGS.text_model);
    setBudget(DEFAULT_STUDIO_SETTINGS.daily_budget_usd);
    setTargetLength(DEFAULT_STUDIO_SETTINGS.target_length);
    setError(null);
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    setSavedSuccess(false);

    try {
      if (!/^gemini-[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(textModel.trim())) {
        throw new Error("Enter a Gemini model ID, such as gemini-4-hydrogen.");
      }
      if (!/^(?:[01]\d|2[0-3]):[0-5][05]$/.test(autopilot.run_time)) {
        throw new Error("Choose an Autopilot time in five-minute increments.");
      }
      const updated: StudioSettings = {
        feelings,
        lines_per_song: Math.max(1, Math.min(12, Math.round(linesPerSong))),
        rhyme_scheme: rhymeScheme,
        max_words_per_line: Math.max(1, Math.min(15, Math.round(maxWordsPerLine))),
        forbidden_words: forbiddenWords,
        block_substrings: blockSubstrings,
        no_numbers_prices_brands: noNumbersPricesBrands,
        default_model: defaultModel,
        text_model: textModel.trim(),
        autopilot,
        target_length: Math.max(28, Math.min(44, Math.round(targetLength))),
        daily_budget_usd: budget,
        updated_at: new Date().toISOString(),
        ownerId: settings.ownerId,
      };

      await onSaveSettings(updated);
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header card */}
      <div className="rounded-xl border border-[#E5E4DF] bg-white p-6 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#ECEBE6] pb-4">
          <div>
            <div className="flex items-center gap-2">
              <SettingsIcon className="h-5 w-5 text-[#1B3B6F]" />
              <h2 className="text-xl font-bold text-[#141413]">
                Studio Rules &amp; Model Settings
              </h2>
            </div>
            <p className="mt-1 text-xs text-[#57554F]">
              Stored permanently in Firestore (<span className="font-mono">/settings/app_settings</span>). These rules govern all Gemini lyric creation, validation warnings, and Lyria mastering.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleResetDefaults}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#D4D2CA] bg-white px-3.5 py-2 text-xs font-medium text-[#57554F] hover:bg-[#F3F2EE]"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset to Defaults
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="inline-flex items-center gap-2 rounded-lg bg-[#1B3B6F] px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-[#152E57] disabled:opacity-60"
            >
              {savedSuccess ? (
                <>
                  <Check className="h-4 w-4 text-emerald-300" />
                  Saved to Cloud!
                </>
              ) : (
                <>
                  <Save className="h-4 w-4" />
                  {isSaving ? "Saving…" : "Save Settings"}
                </>
              )}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-[#FCA5A5] bg-[#FEF2F2] p-3 text-xs text-[#991B1B]">
            {error}
          </div>
        )}

        {/* 1. Feelings List */}
        <div className="mt-6">
          <label className="block text-sm font-bold text-[#141413]">
            1. Admin Feelings List ({feelings.length})
          </label>
          <p className="text-xs text-[#6E6C66]">
            Categories available in the song dropdown and generation wizards.
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            {feelings.map((feeling) => (
              <span
                key={feeling}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#D4D2CA] bg-[#FAF9F6] px-3 py-1.5 font-mono text-xs font-semibold text-[#141413]"
              >
                {feeling}
                <button
                  type="button"
                  onClick={() => handleRemoveFeeling(feeling)}
                  className="rounded p-0.5 text-[#8A877F] hover:bg-[#ECEBE6] hover:text-[#DC2626]"
                  title={`Remove ${feeling}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>

          <div className="mt-3 flex max-w-sm gap-2">
            <input
              type="text"
              aria-label="New feeling" value={newFeeling}
              onChange={(e) => setNewFeeling(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddFeeling();
                }
              }}
              placeholder="e.g. morning_tea"
              className="font-mono min-w-0 flex-1 rounded-lg border border-[#D4D2CA] bg-white px-3 py-1.5 text-xs text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
            />
            <button
              type="button"
              onClick={handleAddFeeling}
              className="inline-flex items-center gap-1 rounded-lg border border-[#1B3B6F] bg-[#EFF6FF] px-3 py-1.5 text-xs font-semibold text-[#1B3B6F] hover:bg-[#DBEAFE]"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Feeling
            </button>
          </div>
        </div>

        {/* 2. Lyric Line & Word Constraints */}
        <div className="mt-8 border-t border-[#ECEBE6] pt-6">
          <div className="flex items-center gap-2">
            <Sliders className="h-4 w-4 text-[#1B3B6F]" />
            <h3 className="text-sm font-bold text-[#141413]">
              2. Lyric Line &amp; Word Limits
            </h3>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold text-[#57554F]">
                Exact Lines Per Song
              </label>
              <input
                type="number"
                min={1}
                max={12}
                value={linesPerSong}
                onChange={(e) => setLinesPerSong(Number(e.target.value))}
                className="font-mono mt-1 w-full rounded-lg border border-[#D4D2CA] bg-white px-3 py-2 text-sm font-semibold text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-[#706E67]">
                Standard: 6 lines. Songs failing this count show red warnings.
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#57554F]">
                Maximum Words Per Line
              </label>
              <input
                type="number"
                min={1}
                max={15}
                value={maxWordsPerLine}
                onChange={(e) => setMaxWordsPerLine(Number(e.target.value))}
                className="font-mono mt-1 w-full rounded-lg border border-[#D4D2CA] bg-white px-3 py-2 text-sm font-semibold text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-[#706E67]">
                Standard: 5 words. Keeps vocal phrasing concise for 30s clips.
              </p>
            </div>
            <label className="block text-xs font-semibold text-[#57554F]">
              Rhyme scheme
              <select className="mt-1 w-full rounded-lg border border-[#D4D2CA] bg-white px-3 py-2"
                value={rhymeScheme} onChange={e => setRhymeScheme(e.target.value as typeof rhymeScheme)}>
                <option value="AABB">AABB — lines 1–2, 3–4, 5–6 rhyme (recommended)</option>
                <option value="ABAB">ABAB — alternating lines rhyme</option>
                <option value="MONO">MONO — every line ends on the same sound (قافية واحدة)</option>
                <option value="OFF">OFF — no rhyme check</option>
              </select>
            </label>
          </div>
        </div>

        {/* 3. Forbidden Words and Commercial Terms */}
        <div className="mt-8 border-t border-[#ECEBE6] pt-6">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-[#B91C1C]" />
            <h3 className="text-sm font-bold text-[#141413]">
              3. Forbidden Words &amp; Commercial Terms
            </h3>
          </div>
          <p className="mt-1 text-xs text-[#6E6C66]">
            Words strictly blocked by validation. Generation will not proceed if any of these words appear.
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            {forbiddenWords.map((word) => (
              <span
                key={word}
                dir="rtl"
                className="font-arabic inline-flex items-center gap-2 rounded-lg border border-[#FCA5A5] bg-[#FEF2F2] px-3 py-1 text-xs font-semibold text-[#991B1B]"
              >
                {word}
                <button
                  type="button"
                  onClick={() => handleRemoveForbiddenWord(word)}
                  className="rounded p-0.5 text-[#B91C1C] hover:bg-[#FEE2E2]"
                  title={`Remove ${word}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>

          <div className="mt-3 flex max-w-sm gap-2">
            <input
              type="text"
              dir="rtl"
              aria-label="New forbidden word" value={newForbiddenWord}
              onChange={(e) => setNewForbiddenWord(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddForbiddenWord();
                }
              }}
              placeholder="أضف كلمة ممنوعة..."
              className="font-arabic min-w-0 flex-1 rounded-lg border border-[#D4D2CA] bg-white px-3 py-1.5 text-sm text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
            />
            <button
              type="button"
              onClick={handleAddForbiddenWord}
              className="inline-flex items-center gap-1 rounded-lg border border-[#B91C1C] bg-[#FEF2F2] px-3 py-1.5 text-xs font-semibold text-[#B91C1C] hover:bg-[#FEE2E2]"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Word
            </button>
          </div>

          <div className="mt-4 space-y-2">
            <label className="flex items-center gap-2.5 text-xs text-[#141413]">
              <input
                type="checkbox"
                checked={blockSubstrings}
                onChange={(e) => setBlockSubstrings(e.target.checked)}
                className="h-4 w-4 accent-[#1B3B6F]"
              />
              <span>
                <strong>Block substring forms:</strong> also blocks words that contain any of the forbidden words as parts (e.g. لمتنا, طفات).
              </span>
            </label>

            <label className="flex items-center gap-2.5 text-xs text-[#141413]">
              <input
                type="checkbox"
                checked={noNumbersPricesBrands}
                onChange={(e) => setNoNumbersPricesBrands(e.target.checked)}
                className="h-4 w-4 accent-[#1B3B6F]"
              />
              <span>
                <strong>Block numbers, prices, and brand/product names:</strong> blocks digits (0-9, ٠-٩), currency terms (درهم, ريال, €), and commercial brand names.
              </span>
            </label>
          </div>
        </div>

        {/* 4. Model and Audio Specs */}
        <div className="mt-8 border-t border-[#ECEBE6] pt-6">
          <h3 className="text-sm font-bold text-[#141413]">
            4. Default Model &amp; Target Audio Spec
          </h3>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold text-[#57554F]">
                Default Generation Model
              </label>
              <select
                aria-label="Default generation model"
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                className="mt-1 w-full rounded-lg border border-[#D4D2CA] bg-white px-3 py-2 text-sm text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
              >
                <option value="lyria-3-clip-preview">
                  Lyria Clip (~30s preview) — Recommended
                </option>
                <option value="lyria-3.5">Lyria 3.5 (~40s full acoustic)</option>
              </select>
            </div>

            <label className="block text-xs font-semibold text-[#57554F]">
              Gemini model for lyrics and vocal checks
              <input value={textModel} maxLength={64} spellCheck={false} autoCapitalize="none"
                onChange={(event) => setTextModel(event.target.value)}
                className="mt-1 w-full rounded-lg border border-[#D4D2CA] bg-white px-3 py-2 font-mono" />
            </label>
            <label className="block text-xs font-semibold text-[#57554F]">
              Daily Gemini budget (USD, resets at 00:00 UTC)
              <input type="number" min={0} max={1000} step={0.01} value={budget}
                onChange={(event) => setBudget(Number(event.target.value))}
                className="mt-1 w-full rounded-lg border border-[#D4D2CA] bg-white px-3 py-2" />
            </label>
            <div>
              <label className="block text-xs font-semibold text-[#57554F]">
                Target Audio Clip Duration (seconds)
              </label>
              <input
                type="number"
                min={28}
                max={44}
                aria-label="Target audio clip duration in seconds"
                value={targetLength}
                onChange={(e) => setTargetLength(Number(e.target.value))}
                className="font-mono mt-1 w-full rounded-lg border border-[#D4D2CA] bg-white px-3 py-2 text-sm font-semibold text-[#141413] focus:border-[#1B3B6F] focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-[#706E67]">
                Mastering targets -14 LUFS and -1.0 dBTP.
              </p>
            </div>
          </div>
        </div>
      </div>
      <AutopilotPanel settings={autopilot} onChange={setAutopilot} />
    </div>
  );
}
