/**
 * Quick smoke test: verify join flow works end-to-end.
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

async function run() {
  const p1 = await connect('Alice');
  await delay(200);
  const state = p1.messages.find(m => m.type === 'state');
  if (!state) throw new Error('No state after join');
  if (state.gameState !== 'LOBBY') throw new Error(`Expected LOBBY, got ${state.gameState}`);
  if (!state.me.isHost) throw new Error('First player should be host');
  console.log('✓ Join flow works: got to lobby as host');

  const p2 = await connect('Bob');
  await delay(200);
  const state2 = p2.messages.find(m => m.type === 'state');
  if (!state2) throw new Error('No state after join for Bob');
  if (state2.me.isHost) throw new Error('Bob should not be host');
  console.log('✓ Second player joined as guest');

  // Reconnect test
  const p1Reconnect = await connect('AliceAgain', p1.sid);
  await delay(200);
  if (p1Reconnect.sid !== p1.sid) throw new Error('Session ID mismatch on reconnect');
  console.log('✓ Reconnect works');

  p1.ws.close();
  p2.ws.close();
  p1Reconnect.ws.close();
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
