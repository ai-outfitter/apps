import { z } from "zod";

/** The provider owns the payload schema; the platform bounds and routes it. */
export const featureId = z.string().regex(/^[a-z][a-z0-9.-]{0,83}$/);
export const featureValue = z.strictObject({ available: z.boolean(), data: z.record(z.string(), z.unknown()) });
export type FeatureValue = z.infer<typeof featureValue>;
export type FeatureProvider = { installationId: string; origin: string; value: FeatureValue };
