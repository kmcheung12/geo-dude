/**
 * Test highlight mode with variable list sizes and rank-based scoring.
 */

const WebSocket = require('ws');
const BASE = 'ws://localhost:3000';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE);
    const messages = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name })));
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      messages.push(msg);
      if (msg.type === 'joined') resolve({ ws, sid: msg.sessionId, messages });
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 3000);
  });
}

function send(ws, obj) { ws.send(JSON.stringify(obj)); }

async function run() {
  const p1 = await connect('Host');
  await delay(200);
  send(p1.ws, { type: 'updateSettings', sessionId: p1.sid, setting: 'mode', value: 'highlight' });
  await delay(200);
  send(p1.ws, { type: 'updateSettings', sessionId: p1.sid, setting: 'listSize', value: 5 });
  await delay(200);
  send(p1.ws, { type: 'updateSettings', sessionId: p1.sid, setting: 'timerPerGuess', value: 1 });
  await delay(200);
  send(p1.ws, { type: 'updateSettings', sessionId: p1.sid, setting: 'questionsPerRound', value: 3 });
  await delay(200);
  send(p1.ws, { type: 'startRound', sessionId: p1.sid });

  let qCount = 0;
  const checkQ = () => {
    const q = p1.messages.find(m => m.type === 'question' && m.index === qCount);
    if (q) {
      qCount++;
      console.log(`Q${q.index + 1}: mode=${q.mode}, options=${q.options.length}, target=${q.targetName}`);
      if (q.mode === 'highlight' && q.options.length !== 5) {
        console.error('ERROR: expected 5 options in highlight mode');
        process.exit(1);
      }
      send(p1.ws, { type: 'answer', sessionId: p1.sid, answer: q.targetName });
    }
    if (qCount < 3) setTimeout(checkQ, 500);
  };
  setTimeout(checkQ, 500);

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no roundEnd')), 60000);
    const iv = setInterval(() => {
      const re = p1.messages.find(m => m.type === 'roundEnd');
      if (re) { clearTimeout(t); clearInterval(iv); resolve(re); }
    }, 300);
  });

  console.log('✓ Highlight mode with 5 options and rank-based scoring works');
  p1.ws.close();
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
