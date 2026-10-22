import { Pool, type PoolClient, type QueryResultRow } from "pg";

let pool: Pool | null = null;
const reportedDisconnects = new WeakSet<Error>();

function reportDisconnect(error: Error & { code?: string }) {
  if (reportedDisconnects.has(error)) return;
  reportedDisconnects.add(error);
  // Never log the pg error object: it can include a client and connection details.
  console.warn("[database] Connection lost. The API remains available; later requests can reconnect.", {
    code: typeof error.code === "string" && /^[A-Z0-9_]{2,40}$/.test(error.code) ? error.code : null,
  });
}

export function databaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured.");
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined });
    // pg removes failed idle clients before emitting this event. Handle it so
    // an internet outage cannot become an uncaught EventEmitter error.
    pool.on("error", reportDisconnect);
    // Checked-out clients lose pg-pool's idle error listener. A disconnect
    // between transaction queries must not crash the process either.
    pool.on("connect", client => client.on("error", reportDisconnect));
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
  return db().query<T>(text, values);
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await db().connect();
  try { await client.query("BEGIN"); const result = await fn(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
