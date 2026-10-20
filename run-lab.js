#!/usr/bin/env node

const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const ROOT = __dirname;

const FEE_PORT = 4001;
const BANK_PORT = 4002;
const ALT_FEE_PORT = 4011;
const FEE = `http://localhost:${FEE_PORT}`;
const BANK = `http://localhost:${BANK_PORT}`;

const BUDGET_MS = 4500;
const PAYMENT_100K = 100_000;
const SMALL = 1_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
let scenarioName = 'general';

function check(name, pass, detail) {
  checks.push({ scenario: scenarioName, name, pass: !!pass, detail: detail == null ? '' : String(detail) });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail ? '  -- ' + detail : ''}`);
  return !!pass;
}

function info(msg) {
  console.log(`  ...   ${msg}`);
}

function section(title) {
  scenarioName = title;
  console.log(`\n=== ${title} ===`);
}

async function req(url, { method = 'GET', body, timeout = 10_000, headers = {} } = {}) {
  const started = Date.now();
  try {
    const r = await fetch(url, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await r.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    return { http: r.status, body: parsed, ms: Date.now() - started };
  } catch (e) {
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    return {
      http: 0,
      body: { error: timedOut ? 'client timeout' : e.message },
      ms: Date.now() - started,
      networkError: e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.name,
    };
  }
}

const pay = (amount, student = 1, base = FEE) =>
  req(`${base}/students/${student}/payments`, { method: 'POST', body: { amount } });

const fees = (student = 1, base = FEE) => req(`${base}/students/${student}/fees`);
const bankStats = async () => (await req(`${BANK}/stats`)).body || {};
const resetAll = async () => {
  await req(`${BANK}/reset`, { method: 'POST' });
  await req(`${FEE}/reset`, { method: 'POST' });
};

async function batch(total, concurrency, amount, { student = 1, base = FEE } = {}) {
  const out = [];
  let next = 0;
  const worker = async () => {
    while (next < total) {
      next += 1;
      out.push(await pay(amount, student, base));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

const summarise = (rs) => {
  const by = {};
  for (const r of rs) {
    const k = `${r.http}/${r.body?.status || '-'}`;
    by[k] = (by[k] || 0) + 1;
  }
  const paid = rs.filter((r) => r.http === 201 && r.body?.status === 'PAID').length;
  const maxMs = rs.length ? Math.max(...rs.map((r) => r.ms)) : 0;
  const avgMs = rs.length ? Math.round(rs.reduce((a, r) => a + r.ms, 0) / rs.length) : 0;
  return { by, paid, maxMs, avgMs, total: rs.length };
};

const ACTIVE = new Set();
let shuttingDown = false;

function spawnService(logName, file, env) {
  const child = spawn(process.execPath, [path.join(ROOT, file)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const tail = [];
  const capture = (d) => {
    tail.push(d.toString());
    if (tail.length > 20) tail.shift();
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  const svc = { name: logName, child, tail, exited: false };
  child.on('exit', (code, signal) => {
    svc.exited = true;
    svc.code = code;
    svc.signal = signal;
    if (!shuttingDown && !svc.stopping && code !== 0) {
      console.log(`  !! ${logName} exited unexpectedly (code=${code})`);
      for (const line of tail) process.stdout.write(`     | ${line}`);
    }
  });
  ACTIVE.add(svc);
  return svc;
}

async function stopService(svc) {
  if (!svc) return;
  svc.stopping = true;
  if (!svc.exited) {
    svc.child.kill();
    const exited = await Promise.race([once(svc.child, 'exit').then(() => true), sleep(3000).then(() => false)]);
    if (!exited) {
      try {
        spawnSync('taskkill', ['/pid', String(svc.child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {}
      await sleep(200);
    }
  }
  ACTIVE.delete(svc);
}

async function stopAll() {
  for (const svc of [...ACTIVE]) await stopService(svc);
}

async function waitFor(url, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await req(url, { timeout: 800 });
    if (r.http >= 200 && r.http < 500) return true;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label} (${url})`);
}

const startBank = async (env = {}, logName = 'bank') => {
  const svc = spawnService(logName, 'bank.js', { PORT: String(BANK_PORT), ...env });
  await waitFor(`${BANK}/stats`, 'bank /stats');
  return svc;
};

const startFee = async (env = {}, port = FEE_PORT, logName = 'fee') => {
  const svc = spawnService(logName, 'fee-service.js', { PORT: String(port), ...env });
  await waitFor(`http://localhost:${port}/students/1/fees`, 'fee /fees');
  return svc;
};

function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port);
  });
}

async function scenario1() {
  section('Scenario 1 - bank is down, then comes back');
  const fee = await startFee({}, FEE_PORT, 'fee-s1');
  const before = (await fees()).body?.debt;

  const down = await pay(PAYMENT_100K);
  check('payment while bank is down returns 503', down.http === 503, `${down.http}`);
  check('503 comes back in < 1500 ms', down.ms < 1500, `${down.ms} ms`);
  check(
    'error body has error + paymentId + status FAILED',
    typeof down.body?.error === 'string' && !!down.body?.paymentId && down.body?.status === 'FAILED',
    JSON.stringify(down.body)
  );

  const list = await fees();
  check('fee service survived (GET /students/1/fees = 200)', list.http === 200, `${list.http} in ${list.ms} ms`);
  check('GET /fees stays fast (< 300 ms)', list.ms < 300, `${list.ms} ms`);
  check('debt unchanged after the 503', list.body?.debt === before, `${before} -> ${list.body?.debt}`);

  info('starting the bank now (fee service is NOT restarted)');
  const bank = await startBank({}, 'bank-s1');
  const up = await pay(PAYMENT_100K);
  check('payment after bank restart returns 201 PAID', up.http === 201 && up.body?.status === 'PAID', `${up.http} ${up.body?.status} in ${up.ms} ms`);
  const afterDebt = (await fees()).body?.debt;
  check('debt decreased by exactly the paid amount', before - afterDebt === PAYMENT_100K, `${before} -> ${afterDebt}`);

  await stopService(fee);
  const feeAlt = await startFee({ BANK_URL: 'http://localhost:4999' }, ALT_FEE_PORT, 'fee-s1-alt');
  const altDown = await pay(PAYMENT_100K, 1, `http://localhost:${ALT_FEE_PORT}`);
  check(
    'BANK_URL=http://localhost:4999 -> still 503 FAILED, < 1.5 s',
    altDown.http === 503 && altDown.body?.status === 'FAILED' && altDown.ms < 1500,
    `${altDown.http} ${altDown.body?.status} in ${altDown.ms} ms`
  );
  const altFees = await fees(1, `http://localhost:${ALT_FEE_PORT}`);
  check('alt fee service still serves GET /fees', altFees.http === 200, `${altFees.http}`);

  await stopService(feeAlt);
  await stopService(bank);
}

async function scenario2() {
  section('Scenario 2 - bank answers in 5 s (overload)');
  const bank = await startBank({ DELAY_MS: '5000' }, 'bank-s2');
  const fee = await startFee({}, FEE_PORT, 'fee-s2');
  await resetAll();
  const debt0 = (await fees()).body?.debt;

  const one = await pay(PAYMENT_100K);
  check('single payment returns 504 PENDING', one.http === 504 && one.body?.status === 'PENDING', `${one.http} ${one.body?.status} in ${one.ms} ms`);
  check('single payment answers in <= 4500 ms', one.ms <= BUDGET_MS, `${one.ms} ms`);

  const probe = { max: 0, n: 0, errors: 0 };
  let probing = true;
  const probeTask = (async () => {
    while (probing) {
      const r = await fees();
      if (r.http !== 200) probe.errors += 1;
      probe.max = Math.max(probe.max, r.ms);
      probe.n += 1;
      await sleep(40);
    }
  })();

  const results = await batch(20, 20, PAYMENT_100K);
  probing = false;
  await probeTask;
  const s = summarise(results);

  check('all 20 concurrent payments are 504 PENDING', results.every((r) => r.http === 504 && r.body?.status === 'PENDING'), JSON.stringify(s.by));
  check('slowest payment stays <= 4500 ms', s.maxMs <= BUDGET_MS, `max ${s.maxMs} ms, avg ${s.avgMs} ms`);
  check('GET /fees under load is < 300 ms', probe.n > 0 && probe.max < 300 && probe.errors === 0, `max ${probe.max} ms over ${probe.n} probes`);

  const debt1 = (await fees()).body?.debt;
  check('debt not reduced for PENDING payments', debt1 === debt0, `${debt0} -> ${debt1}`);

  await stopService(fee);
  await stopService(bank);
}

async function runScenario3({ keepAlive, logSuffix }) {
  const bank = await startBank({}, `bank-s3${logSuffix}`);
  const fee = await startFee(keepAlive ? {} : { KEEP_ALIVE: '0' }, FEE_PORT, `fee-s3${logSuffix}`);
  await resetAll();
  const debt0 = (await fees()).body?.debt;

  const t0 = Date.now();
  const results = await batch(200, 10, SMALL);
  const elapsed = Date.now() - t0;
  const s = summarise(results);
  const stats = await bankStats();
  const debt1 = (await fees()).body?.debt;

  info(`200 payments in ${elapsed} ms, ${(200 / (elapsed / 1000)).toFixed(0)} payments/s, connections so far ${stats.connections}`);

  await sleep(6000);
  const afterIdle = await batch(5, 1, SMALL);
  const idlePaid = afterIdle.filter((r) => r.http === 201).length;
  const statsEnd = await bankStats();

  const out = {
    keepAlive,
    elapsed,
    perSecond: Math.round(200 / (elapsed / 1000)),
    paid: s.paid,
    connections: stats.connections,
    connectionsEnd: statsEnd.connections,
    requests: stats.requests,
    idlePaid,
    debtDrop: debt0 - debt1,
    maxMs: s.maxMs,
    by: s.by,
  };

  await stopService(fee);
  await stopService(bank);
  return out;
}

async function scenario3() {
  section('Scenario 3 - connection reuse (before / after)');
  info('BEFORE: fee service with KEEP_ALIVE=0 (one TCP connection per call)');
  const before = await runScenario3({ keepAlive: false, logSuffix: '-before' });
  info(`before: ${before.elapsed} ms, ${before.connections} TCP connections, ${before.paid}/200 paid`);
  check('BEFORE run: 200/200 paid', before.paid === 200, `${before.paid}/200 (${JSON.stringify(before.by)})`);
  check('BEFORE run shows the problem: connections > 20', before.connections > 20, `${before.connections} connections`);

  info('AFTER: fee service with keep-alive (default)');
  const after = await runScenario3({ keepAlive: true, logSuffix: '-after' });
  info(`after: ${after.elapsed} ms, ${after.connections} TCP connections, ${after.paid}/200 paid`);

  check('AFTER run: 200/200 payments paid', after.paid === 200, `${after.paid}/200 (${JSON.stringify(after.by)})`);
  check('AFTER run: TCP connections <= 20', after.connections <= 20, `${after.connections} connections`);
  check('AFTER run: still works after 6 s idle (bank closed old sockets)', after.idlePaid === 5, `${after.idlePaid}/5`);
  check('AFTER run: every payment within 4500 ms', after.maxMs <= BUDGET_MS, `max ${after.maxMs} ms`);
  check(
    'connection count improved vs. before (same load)',
    after.connections < before.connections,
    `${before.connections} -> ${after.connections} (${Math.round((1 - after.connections / before.connections) * 100)}% fewer)`
  );
}

async function scenario4a() {
  section('Scenario 4a - bank charges then drops the connection (DROP_RATE=0.3)');
  const bank = await startBank({ DROP_RATE: '0.3' }, 'bank-s4a');
  const fee = await startFee({}, FEE_PORT, 'fee-s4a');
  await resetAll();
  const debt0 = (await fees()).body?.debt;

  const results = await batch(60, 1, SMALL);
  const s = summarise(results);
  const stats = await bankStats();
  const debt1 = (await fees()).body?.debt;

  const bad = results.filter((r) => !(r.http === 201 && r.body?.status === 'PAID'));
  check('>= 54/60 payments PAID', s.paid >= 54, `${s.paid}/60 ${JSON.stringify(s.by)}`);
  check('bank duplicates = 0', (stats.duplicates || 0) === 0, `duplicates=${stats.duplicates}, charges=${stats.charges}, replays=${stats.requests - 60}`);
  check(
    'any failed payment is 504 PENDING (never 500/402)',
    bad.every((r) => r.http === 504 && r.body?.status === 'PENDING'),
    bad.length ? JSON.stringify(summarise(bad).by) : 'none failed'
  );
  check('debt fell by exactly paid x 1000', debt0 - debt1 === s.paid * SMALL, `${debt0 - debt1} vs ${s.paid * SMALL}`);
  check('no payment exceeded 4500 ms', s.maxMs <= BUDGET_MS, `max ${s.maxMs} ms`);
  check('retry-after-drop actually happened (same key replayed)', stats.requests > 60, `${stats.requests} charge requests for 60 payments`);
  check('bank charged exactly once per payment reference', stats.charges === 60, `${stats.charges} charges`);

  await stopService(fee);
  await stopService(bank);
}

async function scenario4b() {
  section('Scenario 4b - bank fails 500 before charging (FAIL_RATE=0.3)');
  const bank = await startBank({ FAIL_RATE: '0.3' }, 'bank-s4b');
  const fee = await startFee({}, FEE_PORT, 'fee-s4b');
  await resetAll();
  const debt0 = (await fees()).body?.debt;

  const results = await batch(60, 1, SMALL);
  const s = summarise(results);
  const stats = await bankStats();
  const debt1 = (await fees()).body?.debt;

  const failed = results.filter((r) => r.http !== 201);
  check('>= 54/60 payments PAID', s.paid >= 54, `${s.paid}/60 ${JSON.stringify(s.by)}`);
  check('no double charge (duplicates = 0)', (stats.duplicates || 0) === 0, `duplicates=${stats.duplicates}`);
  check('bank charged exactly once per paid payment', stats.charges === s.paid, `charges=${stats.charges}, paid=${s.paid}`);
  check('debt fell by exactly paid x 1000', debt0 - debt1 === s.paid * SMALL, `${debt0 - debt1} vs ${s.paid * SMALL}`);
  check('transient 500s were retried', stats.requests > 60, `${stats.requests} charge requests for 60 payments`);
  check(
    'payments that still failed are 503 FAILED (certainly not charged)',
    failed.every((r) => r.http === 503 && r.body?.status === 'FAILED'),
    failed.length ? JSON.stringify(summarise(failed).by) : 'none failed'
  );
  check('no payment exceeded 4500 ms', s.maxMs <= BUDGET_MS, `max ${s.maxMs} ms`);

  await stopService(fee);
  await stopService(bank);
}

async function scenario4c() {
  section('Scenario 4c - bank rejects over the 20,000,000 limit');
  const bank = await startBank({}, 'bank-s4c');
  const fee = await startFee({}, FEE_PORT, 'fee-s4c');
  await resetAll();
  const debt0 = (await fees()).body?.debt;

  const big = await pay(25_000_000);
  const stats = await bankStats();
  const debt1 = (await fees()).body?.debt;

  check('25,000,000 payment returns 402', big.http === 402, `${big.http}`);
  check('status is FAILED and body has error + paymentId', big.body?.status === 'FAILED' && !!big.body?.error && !!big.body?.paymentId, JSON.stringify(big.body));
  check('bank received exactly 1 charge request (no retry on 402)', stats.requests === 1, `requests=${stats.requests}, charges=${stats.charges}`);
  check('nothing was charged', stats.charges === 0, `charges=${stats.charges}`);
  check('debt unchanged', debt1 === debt0, `${debt0} -> ${debt1}`);
  check('answered in <= 4500 ms', big.ms <= BUDGET_MS, `${big.ms} ms`);

  await stopService(fee);
  await stopService(bank);
}

function printSummary() {
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.length - passed;

  console.log(`\n================ SUMMARY ================`);
  console.log(`${passed}/${checks.length} checks passed${failed ? `, ${failed} FAILED` : ''}`);
  for (const c of checks.filter((x) => !x.pass)) console.log(`  FAIL  ${c.scenario} :: ${c.name} -- ${c.detail}`);
}

(async () => {
  const wanted = process.argv.slice(2).filter((a) => /^[1-4a-c]+$/.test(a));
  const only = (n) => wanted.length === 0 || wanted.some((w) => w.includes(n));

  const busy = [];
  for (const p of [FEE_PORT, BANK_PORT, ALT_FEE_PORT]) {
    if (!(await portIsFree(p))) busy.push(p);
  }
  if (busy.length) {
    console.error(`Port(s) already in use: ${busy.join(', ')}.`);
    console.error('Stop the running services first:  Get-NetTCPConnection -LocalPort 4001,4002 -State Listen');
    process.exit(1);
  }

  const t0 = Date.now();
  try {
    if (only('1')) await scenario1();
    if (only('2')) await scenario2();
    if (only('3')) await scenario3();
    if (only('4')) {
      await scenario4a();
      await scenario4b();
      await scenario4c();
    }
  } catch (e) {
    console.error('\nHARNESS ERROR:', e && e.stack ? e.stack : e);
    checks.push({ scenario: scenarioName, name: 'harness completed', pass: false, detail: String(e && e.message) });
  } finally {
    shuttingDown = true;
    await stopAll();
    printSummary();
    console.log(`\ntotal wall clock: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  process.exit(checks.some((c) => !c.pass) ? 1 : 0);
})();
