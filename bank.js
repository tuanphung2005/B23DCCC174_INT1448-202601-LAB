'use strict';

const express = require('express');

const PORT = Number(process.env.PORT || 4002);
const DELAY_MS = Number(process.env.DELAY_MS || 0);
const FAIL_RATE = Number(process.env.FAIL_RATE || 0);
const DROP_RATE = Number(process.env.DROP_RATE || 0);
const LIMIT = 20_000_000;

const stats = { connections: 0, requests: 0, charges: 0, duplicates: 0 };
const byKey = new Map();
const refCount = new Map();
let nextCharge = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = express();
app.use(express.json());

app.post('/charges', async (req, res) => {
  stats.requests++;
  if (DELAY_MS > 0) await sleep(DELAY_MS);

  const { reference, amount } = req.body || {};
  const key = req.get('Idempotency-Key');

  if (key && byKey.has(key)) {
    return res.status(201).set('Idempotent-Replayed', 'true').json(byKey.get(key));
  }

  if (typeof reference !== 'string' || !reference || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount or reference' });
  }
  if (amount > LIMIT) {
    return res.status(402).json({ error: 'Amount exceeds limit of 20,000,000' });
  }

  if (Math.random() < FAIL_RATE) {
    return res.status(500).json({ error: 'Temporary bank error' });
  }

  const charge = { chargeId: `C${nextCharge++}`, reference, amount, status: 'CHARGED' };
  stats.charges++;
  const n = (refCount.get(reference) || 0) + 1;
  refCount.set(reference, n);
  if (n > 1) stats.duplicates++;
  if (key) byKey.set(key, charge);

  if (Math.random() < DROP_RATE) {
    console.log(`[bank] DROP after charging ${reference}`);
    return req.socket.destroy();
  }

  res.status(201).json(charge);
});

app.get('/stats', (req, res) => res.json(stats));

app.post('/reset', (req, res) => {
  stats.connections = stats.requests = stats.charges = stats.duplicates = 0;
  byKey.clear();
  refCount.clear();
  nextCharge = 1;
  res.json({ ok: true });
});

const server = app.listen(PORT, () => {
  console.log(`[bank] :${PORT} DELAY_MS=${DELAY_MS} FAIL_RATE=${FAIL_RATE} DROP_RATE=${DROP_RATE}`);
});
server.keepAliveTimeout = 5000;
server.on('connection', (socket) => {
  stats.connections++;
  console.log(`[bank] new TCP connection from port ${socket.remotePort} (total ${stats.connections})`);
});
