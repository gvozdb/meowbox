/**
 * Compile-time compatibility facade for historical system migrations.
 *
 * These sources are immutable release records: several reference fields that
 * were intentionally removed from the current Prisma schema.  At runtime the
 * runner loads their already compiled artifacts only to verify checksums and
 * never executes them once recorded.  Mapping this package to a permissive
 * facade keeps a current-schema build from forcing edits to applied migration
 * sources.  The emitted JavaScript still imports the real @prisma/client.
 */
declare module '@prisma/client' {
  interface HistoricalDelegate {
    findMany(...args: any[]): Promise<any[]>;
    findUnique(...args: any[]): Promise<any>;
    findFirst(...args: any[]): Promise<any>;
    create(...args: any[]): Promise<any>;
    createMany(...args: any[]): Promise<any>;
    update(...args: any[]): Promise<any>;
    updateMany(...args: any[]): Promise<any>;
    upsert(...args: any[]): Promise<any>;
    delete(...args: any[]): Promise<any>;
    deleteMany(...args: any[]): Promise<any>;
  }

  interface HistoricalSiteRow {
    [field: string]: any;
    name: string;
    nginxRateLimitEnabled: boolean | null;
    nginxRateLimitRps: number | null;
    domains: any[];
  }

  interface HistoricalSiteDelegate extends HistoricalDelegate {
    findMany(...args: any[]): Promise<HistoricalSiteRow[]>;
  }

  interface HistoricalSystemMigration {
    id: string;
    checksum: string;
    ok: boolean;
    errorLog: string | null;
    appliedAt: Date;
    durationMs: number;
  }

  interface HistoricalSystemMigrationDelegate extends HistoricalDelegate {
    findMany(...args: any[]): Promise<HistoricalSystemMigration[]>;
    findUnique(...args: any[]): Promise<HistoricalSystemMigration | null>;
  }

  export class PrismaClient {
    public constructor(...args: unknown[]);
    public [delegate: string]: any;
    public $connect(): Promise<void>;
    public $disconnect(): Promise<void>;
    public $queryRaw<T = unknown>(...args: unknown[]): Promise<T>;
    public $queryRawUnsafe<T = unknown>(...args: unknown[]): Promise<T>;
    public $executeRaw(...args: unknown[]): Promise<number>;
    public $executeRawUnsafe(...args: unknown[]): Promise<number>;
    public $transaction<T>(...args: unknown[]): Promise<T>;
    public site: HistoricalSiteDelegate;
    public systemMigration: HistoricalSystemMigrationDelegate;
  }
}
