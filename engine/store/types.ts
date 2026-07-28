/**
 * Values a query parameter may take.
 *
 * Deliberately our own union rather than the driver's: callers must never see
 * driver types, so the driver stays swappable behind this module.
 */
export type SqlValue = string | number | bigint | null | Uint8Array;

export type SqlParams = readonly SqlValue[] | Readonly<Record<string, SqlValue>>;

/**
 * The persistence surface every other layer uses.
 *
 * Domain schema, selectors and the query API are not here — they belong to the
 * knowledge-base layer. This is the mechanism only.
 */
export interface Store {
  /** Executes statements that return nothing. */
  exec(sql: string): void;
  /** Runs a single statement, returning how many rows it changed. */
  run(sql: string, params?: SqlParams): number;
  all<T>(sql: string, params?: SqlParams): T[];
  get<T>(sql: string, params?: SqlParams): T | undefined;
  /**
   * Runs `fn` atomically. Nested calls join the outer transaction through a
   * savepoint, so a helper that opens a transaction stays safe to call from
   * inside one.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
  /** Schema version currently applied to this database. */
  readonly schemaVersion: number;
}

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

export class SchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `Knowledge base is at schema version ${found}, but this build supports ${supported}. ` +
        "Upgrade the tool, or rebuild the knowledge base from source.",
    );
    this.name = "SchemaTooNewError";
  }
}
