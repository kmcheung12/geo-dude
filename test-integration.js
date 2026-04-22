/**
 * Integration test script for Geo Challenge server.
 */

const WebSocket = require('ws');
const BASE = 'ws://localhost:3000';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function connect(name, sessionId = null) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE);
    let sid = null;
    const messages = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name, sessionId })));
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      messages.push(msg);
      if (msg.type === 'joined') { sid = msg.sessionId; resolve({ ws, sid, messages, name }); }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Connect timeout')), 3000);
  });
}

function waitForMessage(client, type, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const idx = client.messages.findIndex(m => m.type === type);
      if (idx >= 0) { resolve(client.messages[idx]); return; }
      if (Date.now() - start > timeout) { reject(new Error(`Timeout waiting for ${type}`)); return; }
      setTimeout(check, 200);
    };
    check();
  });
}

function send(ws, obj) { ws.send(JSON.stringify(obj)); }

async function runTests() {
  console.log('--- Test 1: Join & Host Election ---');
  const p1 = await connect('Alice');
  await delay(300);
  if (!p1.messages.find(m => m.type === 'state').me.isHost) throw new Error('First player should be host');
  console.log('✓ Alice is host');

  const p2 = await connect('Bob');
  await delay(300);
  if (p2.messages.find(m => m.type === 'state').me.isHost) throw new Error('Second player should not be host');
  console.log('✓ Bob is not host');

  console.log('\n--- Test 2: Settings Update ---');
  send(p1.ws, { type: 'updateSettings', sessionId: p1.sid, setting: 'mode', value: 'select' });
  await delay(300);
  if (p2.messages.find(m => m.type === 'settings').settings.mode !== 'select') throw new Error('Settings not broadcast');
  console.log('✓ Settings broadcast to all players');

  console.log('\n--- Test 3: Start Round ---');
  send(p1.ws, { type: 'updateSettings', sessionId: p1.sid, setting: 'timerPerGuess', value: 1 });
  await delay(200);
  send(p1.ws, { type: 'updateSettings', sessionId: p1.sid, setting: 'questionsPerRound', value: 3 });
  await delay(200);
  send(p1.ws, { type: 'startRound', sessionId: p1.sid });
  const q1 = await waitForMessage(p1, 'question');
  console.log('Question received:', q1.mode, 'target:', q1.targetName);
  console.log('✓ Round started with first question');

  console.log('\n--- Test 4: Answer & Question End ---');
  const answer1 = q1.mode === 'highlight' ? q1.options.find(o => o === q1.targetName) : q1.targetName;
  send(p1.ws, { type: 'answer', sessionId: p1.sid, answer: answer1 });
  send(p2.ws, { type: 'answer', sessionId: p2.sid, answer: answer1 });
  const qe = await waitForMessage(p1, 'questionEnd');
  const p1Score = qe.scores.find(s => s.sessionId === p1.sid).score;
  const p2Score = qe.scores.find(s => s.sessionId === p2.sid).score;
  if (p1Score + p2Score !== 3) throw new Error(`Rank scoring wrong: P1=${p1Score}, P2=${p2Score}`);
  console.log('✓ Rank-based scoring correct:', p1Score, p2Score);

  console.log('\n--- Test 5: Round End ---');
  const re = await waitForMessage(p1, 'roundEnd');
  if (re.rankings.length !== 2) throw new Error('Expected 2 rankings');
  console.log('✓ Round completed with rankings');

  console.log('\n--- Test 6: Host End Game from Round End ---');
  send(p1.ws, { type: 'endGame', sessionId: p1.sid });
  const ge = await waitForMessage(p1, 'gameEnd');
  if (!ge.finalRankings) throw new Error('Should show game end');
  console.log('✓ Host ended game from round end');

  console.log('\n--- Test 7: Return to Lobby ---');
  send(p1.ws, { type: 'returnToLobby', sessionId: p1.sid });
  await delay(300);
  const lobbyMsg = p1.messages.find(m => m.type === 'lobbyReset');
  if (!lobbyMsg) throw new Error('Should return to lobby');
  console.log('✓ Returned to lobby');

  console.log('\n--- Test 8: Host Disconnect & Failover ---');
  p1.ws.close();
  await delay(600);
  const hostMsg = p2.messages.find(m => m.type === 'hostAssigned');
  if (!hostMsg || hostMsg.hostId !== p2.sid) throw new Error('Host should failover to Bob');
  console.log('✓ Host failed over to Bob');

  p2.ws.close();

  console.log('\n=== ALL TESTS PASSED ===');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
