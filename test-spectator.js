/**
 * Test spectator join and promotion after round end.
 */

const WebSocket = require('ws');
const BASE = 'ws://localhost:3000';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function connect(name, sessionId = null) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE);
    const messages = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name, sessionId })));
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
  send(p1.ws, { type: 'updateSettings', sessionId: p1.sid, setting: 'timerPerGuess', value: 2 });
  await delay(200);
  send(p1.ws, { type: 'updateSettings', sessionId: p1.sid, setting: 'questionsPerRound', value: 2 });
  await delay(200);
  send(p1.ws, { type: 'startRound', sessionId: p1.sid });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no q1')), 5000);
    const iv = setInterval(() => {
      const q = p1.messages.find(m => m.type === 'question');
      if (q) { clearTimeout(t); clearInterval(iv); resolve(); }
    }, 200);
  });

  const p3 = await connect('Charlie');
  await delay(300);
  const state3 = p3.messages.find(m => m.type === 'state');
  if (!state3.me.spectator) {
    console.error('ERROR: late joiner should be spectator');
    process.exit(1);
  }
  console.log('✓ Late joiner is spectator');

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no roundEnd')), 60000);
    const iv = setInterval(() => {
      const re = p1.messages.find(m => m.type === 'roundEnd');
      if (re) { clearTimeout(t); clearInterval(iv); resolve(re); }
    }, 300);
  });

  // Host starts next round to promote spectator
  send(p1.ws, { type: 'startRound', sessionId: p1.sid });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no roundStart for charlie')), 15000);
    const iv = setInterval(() => {
      const rs = p3.messages.filter(m => m.type === 'roundStart');
      if (rs.length >= 1) { clearTimeout(t); clearInterval(iv); resolve(); }
    }, 300);
  });
  await delay(500);

  const latestState = p3.messages.filter(m => m.type === 'state').pop();
  if (latestState && latestState.me && latestState.me.spectator) {
    console.error('ERROR: Charlie should no longer be spectator after round end');
    process.exit(1);
  }
  console.log('✓ Spectator promoted to active player after round end');

  p1.ws.close();
  p3.ws.close();
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
