// Zod schemas for clicks configuration validation

import { z } from "zod";

/**
 * Schema for a single click configuration.
 */
export const ClickConfigSchema = z.object({
  id: z
    .string()
    .min(1, "Click ID is required")
    .regex(/^[a-z0-9-]+$/, "Click ID must be lowercase alphanumeric with dashes"),
  name: z.string().min(1, "Click name is required"),
  instructions: z.string().min(1, "Instructions are required"),
  intervalMinutes: z
    .number()
    .int()
    .positive("Interval must be a positive integer")
    .max(1440, "Interval cannot exceed 24 hours (1440 minutes)"),
  alertCriteria: z.string().optional(),
  enabled: z.boolean().optional().default(true),
  model: z.string().optional(),
});

/**
 * Schema for clicks.json file.
 */
export const ClicksFileSchema = z.object({
  clicks: z.array(ClickConfigSchema).min(1, "At least one click is required"),
  alertChannel: z.string().optional(),
});

/**
 * Schema for click state.
 */
export const ClickStateSchema = z.object({
  clickId: z.string(),
  lastRunTime: z.number(),
  lastResult: z.enum(["OK", "ALERT", "ERROR"]).optional(),
  lastSummary: z.string().optional(),
  lastAlertTime: z.number().optional(),
  consecutiveFailures: z.number().int().min(0),
});

/**
 * Schema for clicks state file.
 */
export const ClicksStateFileSchema = z.record(z.string(), ClickStateSchema);

/**
 * Validate a clicks.json file.
 */
export function validateClicksFile(data: unknown): {
  success: boolean;
  data?: z.infer<typeof ClicksFileSchema>;
  errors?: string[];
} {
  const result = ClicksFileSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.issues.map(
      (i) => `${i.path.join(".")}: ${i.message}`
    ),
  };
}

/**
 * Validate click state file.
 */
export function validateClicksStateFile(data: unknown): {
  success: boolean;
  data?: z.infer<typeof ClicksStateFileSchema>;
  errors?: string[];
} {
  const result = ClicksStateFileSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.issues.map(
      (i) => `${i.path.join(".")}: ${i.message}`
    ),
  };
}
