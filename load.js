'use strict';

const FEE = process.env.FEE_URL || 'http://localhost:4001';
const BANK = process.env.BANK_URL || 'http://localhost:4002';
const TOTAL = Number(process.env.TOTAL || 200);
const CONC = Number(process.env.CONC || 10);
const AMOUNT = Number(process.env.AMOUNT || 1000);
const STUDENT = Number(process.env.STUDENT || 1);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (url, opts) => (await fetch(url, opts)).json();

async function pay() {
  const t = Date.now();
  try {
    const r = await fetch(`${FEE}/students/${STUDENT}/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: AMOUNT }),
    });
    const body = await r.json().catch(() => ({}));
    return { http: r.status, status: body.status, ms: Date.now() - t };
  } catch (e) {
    return { http: 0, status: 'CLIENT_ERROR', ms: Date.now() - t };
  }
}

async function runBatch(total, conc) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < total) { next++; results.push(await pay()); }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  return results;
}

(async () => {
  if (!process.env.NO_RESET) {
    await fetch(`${BANK}/reset`, { method: 'POST' });
    await fetch(`${FEE}/reset`, { method: 'POST' });
  }
  const debtBefore = (await getJson(`${FEE}/students/${STUDENT}/fees`)).debt;

  const probe = { max: 0, n: 0 };
  let probing = !!process.env.PROBE;
  const probeLoop = (async () => {
    while (probing) {
      const t = Date.now();
      await fetch(`${FEE}/students/${STUDENT}/fees`).then((r) => r.text()).catch(() => {});
      probe.max = Math.max(probe.max, Date.now() - t);
      probe.n++;
      await sleep(100);
    }
  })();

  console.log(`Sending ${TOTAL} payments of ${AMOUNT}đ, ${CONC} concurrent ...`);
  const t0 = Date.now();
  const results = await runBatch(TOTAL, CONC);
  const elapsed = Date.now() - t0;
  probing = false;
  await probeLoop;

  const byHttp = {};
  results.forEach((r) => { const k = `${r.http}/${r.status}`; byHttp[k] = (byHttp[k] || 0) + 1; });
  const paid = results.filter((r) => r.http === 201).length;
  const maxMs = Math.max(...results.map((r) => r.ms));
  const avgMs = Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length);
  const debtAfter = (await getJson(`${FEE}/students/${STUDENT}/fees`)).debt;
  const stats = await getJson(`${BANK}/stats`);

  console.log('\n===== RESULT =====');
  console.log(`total time        : ${elapsed} ms (${(TOTAL / (elapsed / 1000)).toFixed(1)} payments/s)`);
  console.log(`success (201 PAID): ${paid}/${TOTAL}`);
  console.log('http/status       :', byHttp);
  console.log(`latency avg / max : ${avgMs} ms / ${maxMs} ms   (max must be <= 4500)`);
  if (process.env.PROBE) console.log(`GET /fees max     : ${probe.max} ms over ${probe.n} probes   (must be < 300)`);
  console.log(`debt drop         : ${debtBefore - debtAfter}  expected ${paid * AMOUNT}  ${debtBefore - debtAfter === paid * AMOUNT ? 'OK' : 'MISMATCH!'}`);
  console.log('bank /stats       :', stats, '(connections includes 1-2 from this script)');

  if (process.env.IDLE_TEST) {
    console.log('\nIdle 6s so the bank closes old connections ...');
    await sleep(6000);
    const more = await runBatch(5, 1);
    console.log('after idle        :', more.map((r) => `${r.http}/${r.status}`).join(', '));
    console.log('bank /stats       :', await getJson(`${BANK}/stats`));
  }
})();
