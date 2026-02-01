/**
 * Form validation schemas using Zod.
 * Provides reusable validation schemas for common form fields.
 */

import { z } from 'zod';

/**
 * Username validation rules:
 * - 3-32 characters
 * - Alphanumeric with underscores and hyphens
 * - Must start with a letter
 */
export const usernameSchema = z
  .string()
  .min(3, 'Username must be at least 3 characters')
  .max(32, 'Username must not exceed 32 characters')
  .regex(/^[a-zA-Z]/, 'Username must start with a letter')
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'Username can only contain letters, numbers, underscores, and hyphens');

/**
 * Password validation rules:
 * - Minimum 8 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one number
 */
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number');

/**
 * Simple password for login (less strict - just non-empty)
 */
export const loginPasswordSchema = z
  .string()
  .min(1, 'Password is required');

/**
 * Login form schema (less strict validation - server validates)
 */
export const loginFormSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: loginPasswordSchema,
});

/**
 * Setup/registration form schema (stricter validation)
 */
export const setupFormSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
});

/**
 * Server name validation (for adding servers)
 */
export const serverNameSchema = z
  .string()
  .min(1, 'Server name is required')
  .max(64, 'Server name must not exceed 64 characters')
  .regex(/^[a-z0-9]/, 'Server name must start with a lowercase letter or number')
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, 'Server name can only contain lowercase letters, numbers, and hyphens');

/**
 * Hostname validation (IP or domain)
 */
export const hostnameSchema = z
  .string()
  .min(1, 'Hostname is required')
  .refine((val) => {
    // Check if valid IP address
    const ipRegex = /^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    // Check if valid hostname
    const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    return ipRegex.test(val) || hostnameRegex.test(val);
  }, 'Invalid hostname or IP address');

/**
 * Port number validation
 */
export const portSchema = z
  .number()
  .int('Port must be a whole number')
  .min(1, 'Port must be at least 1')
  .max(65535, 'Port must not exceed 65535');

/**
 * Helper type to infer form data from schema
 */
export type LoginFormData = z.infer<typeof loginFormSchema>;
export type SetupFormData = z.infer<typeof setupFormSchema>;
