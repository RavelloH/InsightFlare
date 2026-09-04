/**
 * The shared collection shape used by paginated private/public dashboard
 * endpoints.
 */
export interface PaginationMeta {
  limit: number;
  returned: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface PaginatedCollection<T> {
  items: T[];
  pagination: PaginationMeta;
}
