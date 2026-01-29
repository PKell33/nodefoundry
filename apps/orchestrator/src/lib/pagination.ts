import type { Request } from 'express';

export interface PaginationParams {
  limit: number;
  offset: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Parse pagination parameters from request query.
 * Returns null if no pagination params provided (for backward compatibility).
 */
export function parsePaginationParams(req: Request): PaginationParams | null {
  const limitParam = req.query.limit;
  const offsetParam = req.query.offset;

  // If neither parameter is provided, return null for backward compatibility
  if (limitParam === undefined && offsetParam === undefined) {
    return null;
  }

  const limit = Math.min(
    Math.max(1, parseInt(String(limitParam), 10) || DEFAULT_LIMIT),
    MAX_LIMIT
  );
  const offset = Math.max(0, parseInt(String(offsetParam), 10) || 0);

  return { limit, offset };
}

/**
 * Apply pagination to an array of items.
 */
export function paginate<T>(items: T[], params: PaginationParams): T[] {
  return items.slice(params.offset, params.offset + params.limit);
}

/**
 * Create a paginated response.
 */
export function createPaginatedResponse<T>(
  data: T[],
  total: number,
  params: PaginationParams
): PaginatedResponse<T> {
  return {
    data,
    pagination: {
      total,
      limit: params.limit,
      offset: params.offset,
      hasMore: params.offset + data.length < total,
    },
  };
}

/**
 * Helper to handle backward-compatible pagination.
 * Returns the full array if no pagination params, otherwise returns paginated response.
 */
export function paginateOrReturnAll<T>(
  items: T[],
  params: PaginationParams | null
): T[] | PaginatedResponse<T> {
  if (!params) {
    return items;
  }

  const paginated = paginate(items, params);
  return createPaginatedResponse(paginated, items.length, params);
}
