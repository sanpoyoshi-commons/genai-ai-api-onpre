import { z } from 'zod';

/** startTranscription 入力（上流 StartTranscriptionRequest 互換）。 */
export const startTranscriptionSchema = z.object({
  audioKey: z.string().min(1),
  speakerLabel: z.boolean(),
  maxSpeakers: z.number().int().positive(),
});
