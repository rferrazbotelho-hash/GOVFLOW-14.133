import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { get, put } from '@vercel/blob';
import { closeDb, getDb, getDefaultDbPath, isServerlessRuntime } from './database.js';

const BLOB_DB_PATHNAME = 'govflow/db/govflow.sqlite.gz';
const SQLITE_MAGIC = 'SQLite format 3\0';

let lastKnownEtag: string | null = null;
let pendingPull: Promise<void> | null = null;
let syncQueue: Promise<void> = Promise.resolve();

function withSyncLock<T>(task: () => Promise<T>): Promise<T> {
  const run = syncQueue.then(task, task);
  syncQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function isServerlessBlobSyncEnabled(): boolean {
  return (
    isServerlessRuntime() &&
    Boolean(String(process.env.BLOB_READ_WRITE_TOKEN || '').trim()) &&
    process.env.GOVFLOW_DISABLE_BLOB_SYNC !== '1' &&
    process.env.NODE_ENV !== 'test'
  );
}

export function getDbTotalChanges(): number {
  try {
    const row = getDb().prepare('SELECT total_changes() AS c').get() as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const arrayBuffer = await new Response(stream).arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function replaceLocalSqliteFile(sqliteBytes: Buffer): void {
  if (
    sqliteBytes.length < 100 ||
    sqliteBytes.subarray(0, SQLITE_MAGIC.length).toString('utf8') !== SQLITE_MAGIC
  ) {
    throw new Error('Snapshot SQLite remoto inválido ou corrompido.');
  }

  const dbPath = getDefaultDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const incomingPath = `${dbPath}.incoming-${crypto.randomUUID().slice(0, 8)}`;
  fs.writeFileSync(incomingPath, sqliteBytes);

  closeDb();
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    if (fs.existsSync(sidecar)) {
      try {
        fs.unlinkSync(sidecar);
      } catch {
        // ignore cleanup race
      }
    }
  }
  fs.renameSync(incomingPath, dbPath);
  getDb();
}

export async function pullServerlessDbIfUpdated(): Promise<void> {
  if (!isServerlessBlobSyncEnabled()) return;
  if (pendingPull) return pendingPull;

  pendingPull = withSyncLock(async () => {
    try {
      const result = await get(BLOB_DB_PATHNAME, {
        access: 'private',
        useCache: false,
        ...(lastKnownEtag ? { ifNoneMatch: lastKnownEtag } : {})
      });

      if (!result) {
        return;
      }
      if (result.statusCode === 304) {
        lastKnownEtag = result.blob.etag || lastKnownEtag;
        return;
      }
      if (result.statusCode === 200 && result.stream) {
        const gz = await streamToBuffer(result.stream);
        const raw = zlib.gunzipSync(gz);
        replaceLocalSqliteFile(raw);
        lastKnownEtag = result.blob.etag;
      }
    } catch (err: any) {
      console.warn('[GOVFLOW Blob Sync Pull]', err?.message || err);
    }
  }).finally(() => {
    pendingPull = null;
  });

  return pendingPull;
}

export async function pushServerlessDbSnapshot(): Promise<void> {
  if (!isServerlessBlobSyncEnabled()) return;

  await withSyncLock(async () => {
    const snapPath = path.join(os.tmpdir(), `govflow-snap-${crypto.randomUUID().slice(0, 8)}.db`);
    try {
      const db = getDb();
      const escaped = snapPath.replace(/'/g, "''");
      db.exec(`VACUUM INTO '${escaped}'`);
      const raw = fs.readFileSync(snapPath);
      const gz = zlib.gzipSync(raw, { level: 6 });

      const putResult = await put(BLOB_DB_PATHNAME, gz, {
        access: 'private',
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: 'application/gzip',
        cacheControlMaxAge: 60
      });
      lastKnownEtag = putResult.etag;
    } catch (err: any) {
      console.warn('[GOVFLOW Blob Sync Push]', err?.message || err);
    } finally {
      if (fs.existsSync(snapPath)) {
        try {
          fs.unlinkSync(snapPath);
        } catch {
          // ignore
        }
      }
    }
  });
}
