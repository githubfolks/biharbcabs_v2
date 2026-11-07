import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

let pool: Pool | null = null;

export function getDbPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    
    if (connectionString) {
      pool = new Pool({
        connectionString,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });
    } else {
      pool = new Pool({
        host: process.env.PGHOST || 'localhost',
        port: parseInt(process.env.PGPORT || '5432', 10),
        database: process.env.PGDATABASE || 'biharcabs_crm',
        user: process.env.PGUSER || 'vikram',
        password: process.env.PGPASSWORD || undefined,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });
    }

    pool.on('error', (err) => {
      console.error('[PostgreSQL] Unexpected error on idle client:', err);
    });
  }

  return pool;
}

export async function query<R extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<R>> {
  const p = getDbPool();
  const start = Date.now();
  try {
    const res = await p.query<R>(text, params);
    const duration = Date.now() - start;
    if (duration > 500) {
      console.warn(`[Slow Query ${duration}ms]: ${text.slice(0, 100)}`);
    }
    return res;
  } catch (error) {
    console.error(`[DB Query Error]: ${text}`, error);
    throw error;
  }
}

/**
 * Execute a callback within an isolated PostgreSQL transaction.
 * Supports row-level locks (e.g., SELECT ... FOR UPDATE) for atomic dispatch.
 */
export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const p = getDbPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

