/**
 * Zod validation schemas for incoming WebSocket events from browser clients.
 * Provides runtime validation to ensure message integrity.
 */

import { z } from 'zod';
import { wsLogger } from '../lib/logger.js';

// Log subscription schema
export const LogSubscriptionSchema = z.object({
  deploymentId: z.string().uuid('deploymentId must be a valid UUID'),
});

// Log unsubscription schema
export const LogUnsubscriptionSchema = z.object({
  deploymentId: z.string().uuid('deploymentId must be a valid UUID'),
  streamId: z.string().uuid().optional(),
});

// Type exports
export type ValidatedLogSubscription = z.infer<typeof LogSubscriptionSchema>;
export type ValidatedLogUnsubscription = z.infer<typeof LogUnsubscriptionSchema>;

/**
 * Validate and parse incoming browser client data with a Zod schema.
 * Returns the validated data or null if validation fails.
 */
export function validateBrowserEvent<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  eventName: string,
  clientIp?: string
): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    wsLogger.warn({
      clientIp,
      eventName,
      errors: result.error.issues.slice(0, 3), // Limit error details
    }, 'Invalid browser WebSocket event payload');
    return null;
  }
  return result.data;
}
