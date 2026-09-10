import { z } from "zod";

export const privacyModeSchema = z.enum(["standard", "aggregate"]);
export type PrivacyMode = z.infer<typeof privacyModeSchema>;
