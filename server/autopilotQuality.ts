import { z } from "zod";
import { audioFailures } from "../src/lib/songRepair.ts";

const quality = z.object({
  duration_seconds: z.number(),
  lufs: z.number(),
  true_peak_db: z.number(),
  words_heard_pct: z.number().max(100),
  voice_start: z.number(),
  voice_end: z.number(),
  missing_words: z.array(z.string()),
  extra_words: z.array(z.string()),
  repeated_words: z.array(z.string()).optional(),
});

export function autopilotTakeQualifies(take: unknown) {
  const parsed = quality.safeParse(take);
  return parsed.success && audioFailures(parsed.data).length === 0;
}
