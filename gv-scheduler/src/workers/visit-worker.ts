import 'dotenv/config';
import { Pool } from 'pg';

// ---- ENV ----
const POSTGRES_URL = process.env.POSTGRES_URL;
if (!POSTGRES_URL) {
  throw new Error('POSTGRES_URL missing. Create gv-scheduler/.env with it.');
}
const SCHEDULER_URL = process.env.SCHEDULER_URL || 'http://127.0.0.1:4005/schedule';
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 10000);
const TZ_DEFAULT = process.env.TZ_DEFAULT || 'America/New_York';

// Railway here = NO SSL
const pool = new Pool({ connectionString: POSTGRES_URL, ssl: false });

// ---- CORE: take pending rows -> call /schedule -> mark scheduled/failed ----
async function claimBatch(limit = 8) {
  const sql = `
    WITH next AS (
      SELECT id FROM public.visits
      WHERE status = 'pending'
      ORDER BY created_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public.visits v
       SET status='processing', updated_at=NOW()
     FROM next
    WHERE v.id = next.id
    RETURNING v.*;`;
  const { rows } = await pool.query(sql, [limit]);
  return rows as any[];
}

async function scheduleOne(v: any) {
  const payload: Record<string, any> = {
    email: v.email,
    tz: v.tz || TZ_DEFAULT,
    externalKey: v.external_key,
  };
  if (v.label) payload.label = v.label;

  try {
    const res = await fetch(SCHEDULER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(async () => ({ ok: false, raw: await res.text() }));
    if (!res.ok || !data.ok) throw new Error(`Scheduler ${res.status}: ${JSON.stringify(data)}`);

    await pool.query(
      `UPDATE public.visits
         SET status='scheduled',
             event_id=$1, invite_link=$2, when_text=$3, updated_at=NOW()
       WHERE id=$4`,
      [data.eventId || null, data.htmlLink || null, data.whenText || null, v.id]
    );
    console.log(`✓ scheduled #${v.id} -> ${data.whenText || 'scheduled'}`);
  } catch (err: any) {
    await pool.query(
      `UPDATE public.visits SET status='failed', updated_at=NOW() WHERE id=$1`,
      [v.id]
    );
    console.error(`✗ failed #${v.id}:`, err?.message || err);
  }
}

async function loop() {
  try {
    const batch = await claimBatch(8);
    for (const v of batch) await scheduleOne(v);
  } catch (e: any) {
    console.error('worker loop error:', e?.message || e);
  } finally {
    setTimeout(loop, POLL_MS);
  }
}

process.on('SIGINT', async () => { console.log('\n[worker] bye'); await pool.end(); process.exit(0); });

console.log('[worker] up with', { SCHEDULER_URL, POLL_MS, TZ_DEFAULT });
loop();
