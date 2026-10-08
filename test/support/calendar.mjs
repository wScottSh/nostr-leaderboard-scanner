/*
 * A fake OpenTimestamps calendar over HTTP, built with ots.js. POST /digest
 * answers a pending attestation for a leaf commitment; GET
 * /timestamp/<leaf> answers 404 until mine(height), then a Bitcoin-attested
 * path for that leaf. Sends CORS so the page in the e2e can use it.
 */
import { createServer } from 'node:http';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { newStamp, applyOp, serializeTimestamp } from '../../src/ots.js';

export function startCalendar() {
  const cal = { leaves: new Map(), height: 0, requests: [] };
  cal.mine = (height) => {
    cal.height = height;
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = new Uint8Array(Buffer.concat(chunks));
    cal.requests.push(`${req.method} ${req.url}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    if (req.method === 'POST' && req.url === '/digest' && body.length === 32) {
      const root = newStamp(body);
      const op = { tag: 0xf0, arg: crypto.getRandomValues(new Uint8Array(8)) };
      const mid = newStamp(applyOp(op, body));
      const leaf = newStamp(sha256(mid.msg));
      leaf.attestations.push({ type: 'pending', uri: cal.url });
      mid.ops.push({ op: { tag: 0x08 }, stamp: leaf });
      root.ops.push({ op, stamp: mid });
      cal.leaves.set(bytesToHex(leaf.msg), leaf.msg);
      return res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(serializeTimestamp(root));
    }
    const m = req.method === 'GET' && req.url.match(/^\/timestamp\/([0-9a-f]{64})$/);
    if (m && cal.height && cal.leaves.has(m[1])) {
      const stamp = newStamp(cal.leaves.get(m[1]));
      const block = newStamp(sha256(stamp.msg));
      block.attestations.push({ type: 'bitcoin', height: cal.height });
      stamp.ops.push({ op: { tag: 0x08 }, stamp: block });
      return res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(serializeTimestamp(stamp));
    }
    res.writeHead(404).end('Not found');
  });
  cal.close = () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    cal.url = `http://127.0.0.1:${server.address().port}`;
    resolve(cal);
  }));
}
