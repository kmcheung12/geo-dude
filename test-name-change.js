/**
 * Test name change in lobby.
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
  const p1 = await connect('Alice');
  const p2 = await connect('Bob');
  await delay(200);

  // P1 changes name
  send(p1.ws, { type: 'changeName', sessionId: p1.sid, name: 'AliceWonder' });
  await delay(200);

  const playersMsg = p2.messages.filter(m => m.type === 'players').pop();
  const alice = playersMsg.players.find(p => p.sessionId === p1.sid);
  if (alice.name !== 'AliceWonder') throw new Error(`Expected AliceWonder, got ${alice.name}`);
  console.log('✓ Name change broadcast to all players');

  // P2 changes name
  send(p2.ws, { type: 'changeName', sessionId: p2.sid, name: 'BobTheBuilder' });
  await delay(200);

  const playersMsg2 = p1.messages.filter(m => m.type === 'players').pop();
  const bob = playersMsg2.players.find(p => p.sessionId === p2.sid);
  if (bob.name !== 'BobTheBuilder') throw new Error(`Expected BobTheBuilder, got ${bob.name}`);
  console.log('✓ Name change works for non-host too');

  p1.ws.close();
  p2.ws.close();
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
