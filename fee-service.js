'use strict';

const express = require('express');
const http = require('http');

const PORT = Number(process.env.PORT || 4001);
const BANK_URL = process.env.BANK_URL || 'http://localhost:4002';
const KEEP_ALIVE = process.env.KEEP_ALIVE !== '0';
const DEADLINE_MS = Number(process.env.DEADLINE_MS || 4000);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 4);
const MIN_ATTEMPT_MS = 200;
const BACKOFF_MS = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const students = new Map();
let payments = new Map();
let seq = 0;
function resetData() {
  students.clear();
  students.set(1, { debt: 50_000_000, reserved: 0 });
  students.set(2, { debt: 0, reserved: 0 });
  students.set(3, { debt: 3_200_000, reserved: 0 });
  payments = new Map();
  seq = 0;
}
resetData();

const agent = new http.Agent({
  keepAlive: KEEP_ALIVE,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  timeout: 4000,
});

function postJson(baseUrl, path, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, baseUrl);
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          clearTimeout(timer);
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
          resolve({ status: res.statusCode, body: parsed });
        });
        res.on('error', (e) => { clearTimeout(timer); reject(e); });
        res.on('close', () => {
          if (!res.complete) { clearTimeout(timer); reject(Object.assign(new Error('response aborted'), { code: 'ECONNRESET' })); }
        });
      }
    );
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end(data);
  });
}

const NOT_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH']);
function neverConnected(e) {
  if (NOT_CONNECTED.has(e.code)) return true;

  return Array.isArray(e.errors) && e.errors.length > 0 && e.errors.every((x) => NOT_CONNECTED.has(x.code));
}

async function callBank(paymentId, amount) {
  const start = Date.now();
  let maybeCharged = false;
  let lastError = 'bank unavailable';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = DEADLINE_MS - (Date.now() - start);
    if (remaining < MIN_ATTEMPT_MS) break;

    try {
      const res = await postJson(
        BANK_URL,
        '/charges',
        { reference: paymentId, amount },
        { 'Idempotency-Key': paymentId },
        remaining
      );
      if (res.status === 201) return { kind: 'ok', body: res.body };
      if (res.status >= 500) {
        lastError = `bank returned ${res.status}`;
      } else {
        return { kind: 'rejected', status: res.status, body: res.body };
      }
    } catch (e) {
      if (neverConnected(e)) {
        lastError = 'cannot connect to bank';
        break;
      }
      maybeCharged = true;
      lastError = e.code === 'ETIMEDOUT' ? 'bank timed out' : `connection lost (${e.code || e.message})`;
    }
    await sleep(BACKOFF_MS);
  }
  return maybeCharged ? { kind: 'unknown', error: lastError } : { kind: 'unavailable', error: lastError };
}

const app = express();
app.use(express.json());

app.get('/students/:id/fees', (req, res) => {
  const id = Number(req.params.id);
  const s = students.get(id);
  if (!s) return res.status(404).json({ error: 'Student not found' });
  res.json({ studentId: id, debt: s.debt });
});

app.get('/payments/:id', (req, res) => {
  const p = payments.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Payment not found' });
  res.json(p);
});

app.post('/students/:id/payments', async (req, res) => {
  const studentId = Number(req.params.id);
  const s = students.get(studentId);
  if (!s) return res.status(404).json({ error: 'Student not found' });

  const amount = req.body && req.body.amount;
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive integer' });
  }

  if (amount > s.debt - s.reserved) {
    return res.status(409).json({ error: 'Amount exceeds outstanding debt' });
  }

  const payment = { paymentId: `P${++seq}`, studentId, amount, status: 'PROCESSING' };
  payments.set(payment.paymentId, payment);
  s.reserved += amount;

  let result;
  try {
    result = await callBank(payment.paymentId, amount);
  } catch (e) {
    result = { kind: 'unavailable', error: e.message };
  }
  s.reserved -= amount;

  const fail = (httpCode, status, error) => {
    payment.status = status;
    payment.error = error;
    return res.status(httpCode).json({ error, paymentId: payment.paymentId, status });
  };

  switch (result.kind) {
    case 'ok':
      s.debt -= amount;
      payment.status = 'PAID';
      payment.chargeId = result.body.chargeId;
      return res.status(201).json({ paymentId: payment.paymentId, status: 'PAID', chargeId: payment.chargeId, remainingDebt: s.debt });
    case 'rejected':
      return fail(result.status, 'FAILED', (result.body && result.body.error) || 'Bank rejected the payment');
    case 'unknown':
      return fail(504, 'PENDING', `Payment outcome unknown: ${result.error}`);
    default:
      return fail(503, 'FAILED', `Bank unavailable: ${result.error}`);
  }
});

app.post('/reset', (req, res) => { resetData(); res.json({ ok: true }); });

app.use((err, req, res, next) => res.status(400).json({ error: err.message }));

process.on('uncaughtException', (e) => console.error('[fee] uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('[fee] unhandledRejection', e));

app.listen(PORT, () => {
  console.log(`[fee] :${PORT} BANK_URL=${BANK_URL} KEEP_ALIVE=${KEEP_ALIVE} DEADLINE_MS=${DEADLINE_MS}`);
});
