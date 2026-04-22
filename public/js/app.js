/**
 * Geo Challenge - Client App
 * Handles WS connection, screen routing, and game orchestration.
 */

(function() {
  'use strict';

  const WS_URL = `ws://${location.host || 'localhost:3000'}`;
  let ws = null;
  let msgQueue = [];
  let myName = localStorage.getItem('geoName') || null;
  let isHost = false;
  let isSpectator = false;
  let gameState = 'LOBBY';
  let currentMode = 'highlight';
  let hasAnswered = false;
  let globe = null;
  let globeReady = false;
  let answeredPlayers = new Set();

  console.log('[Geo] Script loaded. WS URL:', WS_URL);

  function getEl(id) {
    const el = document.getElementById(id);
    if (!el) console.warn('[Geo] Element not found:', id);
    return el;
  }

  const screens = {
    join: getEl('screen-join'),
    lobby: getEl('screen-lobby'),
    game: getEl('screen-game'),
  };

  const els = {
    joinName: getEl('join-name'),
    btnJoin: getEl('btn-join'),
    joinStatus: getEl('join-status'),
    joinError: getEl('join-error'),
    joinQrCode: getEl('join-qr-code'),
    joinRoomUrl: getEl('join-room-url'),
    lobbyPlayerList: getEl('lobby-player-list'),
    hostControls: getEl('host-controls'),
    guestWaiting: getEl('guest-waiting'),
    btnStart: getEl('btn-start'),
    qrCode: getEl('qr-code'),
    roomUrl: getEl('room-url'),
    settingMode: getEl('setting-mode'),
    settingQuestions: getEl('setting-questions'),
    settingTimer: getEl('setting-timer'),
    settingListSize: getEl('setting-list-size'),
    settingPool: getEl('setting-pool'),
    gameRound: getEl('game-round'),
    gameQuestion: getEl('game-question'),
    gameTimer: getEl('game-timer'),
    playerChips: getEl('player-chips'),
    globeWrapper: getEl('globe-wrapper'),
    gamePrompt: getEl('game-prompt'),
    scoreboard: getEl('scoreboard'),
    answerPanel: getEl('answer-panel'),
    hostGameActions: getEl('host-game-actions'),
    btnEndGame: getEl('btn-end-game'),
    overlayQuestionEnd: getEl('overlay-question-end'),
    qeAnswer: getEl('qe-answer'),
    qeAnswers: getEl('qe-answers'),
    qeCountdown: getEl('qe-countdown'),
    overlayRoundEnd: getEl('overlay-round-end'),
    roundRankings: getEl('round-rankings'),
    roundEndHostActions: getEl('round-end-host-actions'),
    roundEndGuestWaiting: getEl('round-end-guest-waiting'),
    btnNextRound: getEl('btn-next-round'),
    btnReturnLobby: getEl('btn-return-lobby'),
    overlayGameEnd: getEl('overlay-game-end'),
    finalRankings: getEl('final-rankings'),
    btnPlayAgain: getEl('btn-play-again'),
    changeNameInput: getEl('change-name-input'),
    btnChangeName: getEl('btn-change-name'),
  };

  // ------------------------------------------------------------------
  // Sound Effects (Web Audio API)
  // ------------------------------------------------------------------
  let audioCtx = null;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) {
    console.warn('[Geo] AudioContext not available');
  }

  function playTone(freq, duration, type = 'sine', gain = 0.1) {
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    gainNode.gain.setValueAtTime(gain, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  }

  const sounds = {
    countdown: (remaining) => {
      const freq = remaining === 1 ? 880 : 440;
      playTone(freq, 0.05, 'sine', 0.08);
    },
    correct: () => {
      playTone(523, 0.15, 'sine', 0.12);
      setTimeout(() => playTone(659, 0.15, 'sine', 0.12), 120);
    },
    wrong: () => {
      playTone(300, 0.3, 'square', 0.08);
      setTimeout(() => playTone(150, 0.3, 'square', 0.08), 150);
    },
  };

  // ------------------------------------------------------------------
  // Screens
  // ------------------------------------------------------------------
  function showScreen(name) {
    console.log('[Geo] showScreen:', name);
    Object.values(screens).forEach(s => s && s.classList.remove('active'));
    if (screens[name]) screens[name].classList.add('active');
  }

  // ------------------------------------------------------------------
  // WebSocket
  // ------------------------------------------------------------------
  function setJoinStatus(text, isError) {
    if (!els.joinStatus) return;
    els.joinStatus.textContent = text;
    els.joinStatus.style.color = isError ? 'var(--danger)' : 'var(--text-muted)';
  }

  function flushQueue() {
    while (msgQueue.length && ws && ws.readyState === WebSocket.OPEN) {
      const m = msgQueue.shift();
      ws.send(JSON.stringify(m));
      console.log('[Geo] Flushed queued message:', m.type);
    }
  }

  function connect() {
    console.log('[Geo] Connecting to', WS_URL);
    setJoinStatus('Connecting...');

    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      console.error('[Geo] Failed to create WebSocket:', e);
      setJoinStatus('Connection failed: ' + e.message, true);
      return;
    }

    ws.onopen = () => {
      console.log('[Geo] WebSocket open');
      setJoinStatus('Connected');
      flushQueue();
      // Join is now explicit — user must click the Join button.
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        console.log('[Geo] WS msg:', msg.type, msg);
        handleMessage(msg);
      } catch (e) {
        console.error('[Geo] Invalid WS message', e, evt.data);
      }
    };

    ws.onclose = (evt) => {
      console.log('[Geo] WebSocket close', evt.code, evt.reason);
      setJoinStatus('Disconnected. Reconnecting...', true);
      setTimeout(connect, 1500);
    };

    ws.onerror = (err) => {
      console.error('[Geo] WebSocket error', err);
      setJoinStatus('Connection error. Retrying...', true);
    };
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const data = JSON.stringify(msg);
      ws.send(data);
      console.log('[Geo] Sent:', msg.type);
      return true;
    }
    console.log('[Geo] Queueing message (WS not open):', msg.type);
    msgQueue.push(msg);
    return false;
  }

  // ------------------------------------------------------------------
  // Message Handling
  // ------------------------------------------------------------------
  function handleMessage(msg) {
    switch (msg.type) {
      case 'joined':
        myName = msg.name;
        localStorage.setItem('geoName', myName);
        console.log('[Geo] Joined as:', myName);
        break;

      case 'state':
        gameState = msg.gameState;
        isHost = msg.me && msg.me.isHost;
        isSpectator = msg.me && msg.me.spectator;
        updateSettingsUI(msg.settings);
        if (gameState === 'LOBBY') {
          showScreen('lobby');
          updateLobbyVisibility();
        } else if (['PRE_ROUND', 'QUESTION', 'QUESTION_END', 'ROUND_END', 'GAME_END'].includes(gameState)) {
          showScreen('game');
        }
        updateHostGameActions();
        break;

      case 'players':
        renderPlayerList(msg.players);
        updatePlayerChips(msg.players);
        break;

      case 'settings':
        updateSettingsUI(msg.settings);
        break;

      case 'hostAssigned':
        if (msg.hostName === myName) {
          isHost = true;
          updateLobbyVisibility();
          updateHostGameActions();
        }
        break;

      case 'question':
        hideOverlays();
        hasAnswered = false;
        answeredPlayers.clear();
        currentMode = msg.mode;
        renderQuestion(msg);
        break;

      case 'tick':
        updateTimer(msg.remaining);
        if (msg.remaining > 0 && msg.remaining <= 5) {
          sounds.countdown(msg.remaining);
        }
        break;

      case 'questionEnd':
        showQuestionEnd(msg);
        break;

      case 'roundEnd':
        showRoundEnd(msg);
        break;

      case 'gameEnd':
        showGameEnd(msg);
        break;

      case 'lobbyReset':
        hideOverlays();
        showScreen('lobby');
        updateLobbyVisibility();
        break;

      case 'playerAnswered':
        answeredPlayers.add(msg.name);
        updatePlayerChipsFromSet();
        break;

      case 'ping':
        send({ type: 'pong' });
        break;

      case 'roomClosed':
        console.log('[Geo] Room closed:', msg.reason);
        showScreen('join');
        if (els.joinError) els.joinError.textContent = msg.reason || 'Room has ended. Please rejoin.';
        break;

      case 'error':
        console.error('[Geo] Server error:', msg.message);
        if (els.joinError) els.joinError.textContent = msg.message;
        break;
    }
  }

  // ------------------------------------------------------------------
  // Join
  // ------------------------------------------------------------------
  function doJoin() {
    console.log('[Geo] doJoin called');
    const name = els.joinName ? els.joinName.value.trim() : '';
    if (!name) {
      if (els.joinError) els.joinError.textContent = 'Please enter a name.';
      return;
    }
    if (els.joinError) els.joinError.textContent = '';
    localStorage.setItem('geoName', name);
    myName = name;
    send({ type: 'join', name });
  }

  // ------------------------------------------------------------------
  // Lobby
  // ------------------------------------------------------------------
  function updateLobbyVisibility() {
    const savedName = localStorage.getItem('geoName') || '';
    if (els.changeNameInput && !els.changeNameInput.value.trim()) {
      els.changeNameInput.value = savedName;
    }
    if (isHost) {
      els.hostControls && els.hostControls.classList.remove('hidden');
      els.guestWaiting && els.guestWaiting.classList.add('hidden');
      loadQR();
    } else {
      els.hostControls && els.hostControls.classList.add('hidden');
      els.guestWaiting && els.guestWaiting.classList.remove('hidden');
    }
  }

  function renderPlayerList(players) {
    if (!els.lobbyPlayerList) return;
    els.lobbyPlayerList.innerHTML = '';
    for (const p of players) {
      const div = document.createElement('div');
      div.className = 'player-item';
      let badges = '';
      if (p.isHost) badges += '<span class="host-badge">HOST</span>';
      if (p.spectator) badges += '<span class="spectator-badge">SPEC</span>';
      div.innerHTML = `
        <span>${escapeHtml(p.name)} ${!p.connected ? '(left)' : ''}</span>
        <span>${badges}</span>
      `;
      els.lobbyPlayerList.appendChild(div);
    }

    if (gameState !== 'LOBBY') {
      renderScoreboard(players);
    }
  }

  function updateSettingsUI(settings) {
    if (els.settingMode) els.settingMode.value = settings.mode || 'highlight';
    if (els.settingQuestions) els.settingQuestions.value = settings.questionsPerRound || 10;
    if (els.settingTimer) els.settingTimer.value = String(settings.timerPerGuess ?? 30);
    if (els.settingListSize) els.settingListSize.value = String(settings.listSize ?? 4);
    if (els.settingPool) els.settingPool.value = settings.optionPool || 'random';
  }

  function onSettingChange(setting, value) {
    send({ type: 'updateSettings', setting, value });
  }

  async function loadQR() {
    try {
      const res = await fetch('/api/qr');
      const data = await res.json();
      if (els.qrCode) els.qrCode.src = data.qr;
      if (els.roomUrl) els.roomUrl.textContent = data.url;
      if (els.joinQrCode) els.joinQrCode.src = data.qr;
      if (els.joinRoomUrl) els.joinRoomUrl.textContent = data.url;
    } catch (e) {
      console.error('Failed to load QR', e);
    }
  }

  // ------------------------------------------------------------------
  // Game
  // ------------------------------------------------------------------
  function updateHostGameActions() {
    if (els.hostGameActions) {
      els.hostGameActions.classList.toggle('hidden', !isHost || gameState === 'LOBBY');
    }
  }

  function renderQuestion(msg) {
    if (els.gameRound) els.gameRound.textContent = `Round ${msg.round}`;
    if (els.gameQuestion) els.gameQuestion.textContent = `Question ${msg.index + 1}/${msg.totalQuestions}`;
    if (els.gameTimer) {
      els.gameTimer.textContent = msg.timeLimit > 0 ? (msg.timeRemaining ?? msg.timeLimit) : '∞';
      els.gameTimer.className = 'timer';
    }
    if (els.answerPanel) els.answerPanel.innerHTML = '';
    if (els.gamePrompt) els.gamePrompt.textContent = '';
    answeredPlayers.clear();
    updatePlayerChipsFromSet();

    if (!globe) {
      globe = createGlobe(els.globeWrapper);
      globe.load('/data/countries-110m.json').then(() => {
        globeReady = true;
        setupQuestion(msg);
        updateHostGameActions();
      });
    } else if (globeReady) {
      globe.clearHighlight();
      setupQuestion(msg);
      updateHostGameActions();
    }
  }

  function setupQuestion(msg) {
    const target = msg.targetName;

    if (isSpectator) {
      if (els.gamePrompt) els.gamePrompt.textContent = 'Spectator Mode';
      const note = document.createElement('p');
      note.style.color = 'var(--text-muted)';
      note.textContent = 'You are watching. Next round you can play!';
      if (els.answerPanel) {
        els.answerPanel.innerHTML = '';
        els.answerPanel.appendChild(note);
      }
      if (msg.mode === 'highlight') {
        globe.setZoomable(true);
        globe.setDraggable(false);
        globe.highlightCountry(target);
      } else {
        globe.setZoomable(true);
        globe.setDraggable(true);
        if (els.gamePrompt) els.gamePrompt.textContent = `Find: ${target} (Spectating)`;
      }
      return;
    }

    if (msg.mode === 'highlight') {
      globe.setZoomable(true);
      globe.setDraggable(false);
      globe.highlightCountry(target);
      if (els.gamePrompt) els.gamePrompt.textContent = 'Which country is highlighted?';
      renderAnswerButtons(msg.options, target);
    } else {
      globe.setZoomable(true);
      globe.setDraggable(true);
      if (els.gamePrompt) els.gamePrompt.textContent = `Find: ${target}`;
      renderSelectMode(target);
    }
  }

  function renderAnswerButtons(options, target) {
    if (document.activeElement) document.activeElement.blur();
    if (!els.answerPanel) return;
    els.answerPanel.innerHTML = '';
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.className = 'answer-btn';
      btn.textContent = opt;
      btn.addEventListener('click', () => {
        if (hasAnswered) return;
        hasAnswered = true;
        disableAllButtons();
        send({ type: 'answer', answer: opt });
      });
      els.answerPanel.appendChild(btn);
    }
  }

  function renderSelectMode(target) {
    if (!els.answerPanel) return;
    els.answerPanel.innerHTML = '';
    const hint = document.createElement('p');
    hint.style.color = 'var(--text-muted)';
    hint.style.fontSize = '0.9rem';
    hint.textContent = 'Click a country on the globe to select it.';
    els.answerPanel.appendChild(hint);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn-primary';
    confirmBtn.textContent = 'Confirm Selection';
    confirmBtn.disabled = true;
    confirmBtn.style.marginTop = '0.5rem';
    els.answerPanel.appendChild(confirmBtn);

    let selected = null;

    globe.onCountryClick = (name) => {
      if (hasAnswered) return;
      selected = name;
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm Selection';
    };

    confirmBtn.addEventListener('click', () => {
      if (!selected || hasAnswered) return;
      hasAnswered = true;
      confirmBtn.disabled = true;
      send({ type: 'answer', answer: selected });
    });
  }

  function disableAllButtons() {
    if (!els.answerPanel) return;
    for (const btn of els.answerPanel.querySelectorAll('button')) {
      btn.disabled = true;
    }
  }

  function updateTimer(remaining) {
    if (!els.gameTimer) return;
    els.gameTimer.textContent = remaining;
    els.gameTimer.classList.remove('warning', 'danger');
    if (remaining <= 0) {
      els.gameTimer.classList.add('danger');
      disableAllButtons();
      hasAnswered = true;
    } else if (remaining <= 5) {
      els.gameTimer.classList.add('danger');
    } else if (remaining <= 10) {
      els.gameTimer.classList.add('warning');
    }
  }

  // ------------------------------------------------------------------
  // Player Chips
  // ------------------------------------------------------------------
  let lastPlayers = [];

  function updatePlayerChips(players) {
    lastPlayers = players.filter(p => p.connected && !p.spectator);
    updatePlayerChipsFromSet();
  }

  function updatePlayerChipsFromSet() {
    if (!els.playerChips) return;
    els.playerChips.innerHTML = '';
    for (const p of lastPlayers) {
      const chip = document.createElement('div');
      chip.className = 'player-chip' + (answeredPlayers.has(p.name) ? ' answered' : '');
      chip.innerHTML = `
        <span>${escapeHtml(p.name)}</span>
        <span class="chip-score">${p.score}</span>
        <span class="chip-check">&#10003;</span>
      `;
      els.playerChips.appendChild(chip);
    }
  }

  // ------------------------------------------------------------------
  // Scoreboard
  // ------------------------------------------------------------------
  function renderScoreboard(players) {
    if (!els.scoreboard) return;
    els.scoreboard.innerHTML = '<h4>Scores</h4>';
    const sorted = players.slice().sort((a, b) => b.score - a.score);
    for (const p of sorted) {
      if (!p.connected) continue;
      const row = document.createElement('div');
      row.className = 'score-row';
      row.innerHTML = `<span>${escapeHtml(p.name)}</span><span>${p.score}</span>`;
      els.scoreboard.appendChild(row);
    }
  }

  // ------------------------------------------------------------------
  // Overlays
  // ------------------------------------------------------------------
  function showQuestionEnd(msg) {
    // In "Find a country" mode, highlight the correct answer on the globe instead of showing a popup
    if (currentMode === 'select') {
      if (els.answerPanel) els.answerPanel.innerHTML = '';
      if (els.gamePrompt) els.gamePrompt.textContent = `Answer: ${msg.correctAnswer}`;
      if (globe && globeReady) {
        globe.setDraggable(false);
        globe.clearHighlight();
        globe.highlightCountry(msg.correctAnswer);
      }
      let myCorrect = false;
      if (msg.playerAnswers && msg.playerAnswers[myName]) {
        myCorrect = msg.playerAnswers[myName].correct;
      }
      if (myCorrect) sounds.correct();
      else if (!isSpectator) sounds.wrong();
      return;
    }

    // "Name the country" mode: show the overlay with correct answer text
    if (els.qeAnswer) els.qeAnswer.textContent = `Correct answer: ${msg.correctAnswer}`;
    if (els.qeAnswers) {
      els.qeAnswers.innerHTML = '';
      let myCorrect = false;
      for (const [playerName, data] of Object.entries(msg.playerAnswers)) {
        if (playerName === myName && data.correct) myCorrect = true;
        const div = document.createElement('div');
        div.className = 'qe-item';
        const icon = data.correct ? '<span class="correct-icon">&#10003;</span>' : '<span class="wrong-icon">&#10007;</span>';
        div.innerHTML = `<span>${escapeHtml(data.name)}: ${data.answer ? escapeHtml(data.answer) : '—'}</span> ${icon}`;
        els.qeAnswers.appendChild(div);
      }
      if (myCorrect) sounds.correct();
      else if (!isSpectator) sounds.wrong();
    }
    if (els.overlayQuestionEnd) els.overlayQuestionEnd.classList.remove('hidden');
    startQeCountdown();
  }

  function startQeCountdown() {
    if (!els.qeCountdown) return;
    els.qeCountdown.classList.remove('animate');
    void els.qeCountdown.offsetWidth;
    els.qeCountdown.classList.add('animate');
  }

  function stopQeCountdown() {
    if (!els.qeCountdown) return;
    els.qeCountdown.classList.remove('animate');
  }

  function showRoundEnd(msg) {
    if (els.overlayQuestionEnd) els.overlayQuestionEnd.classList.add('hidden');
    if (els.roundRankings) {
      els.roundRankings.innerHTML = '';
      msg.rankings.forEach((r, i) => {
        const div = document.createElement('div');
        div.className = 'rank-item';
        let posClass = '';
        if (i === 0) posClass = 'gold';
        else if (i === 1) posClass = 'silver';
        else if (i === 2) posClass = 'bronze';
        div.innerHTML = `
          <div class="rank-pos ${posClass}">${i + 1}</div>
          <div style="flex:1;text-align:left">${escapeHtml(r.name)}</div>
          <div style="font-weight:700">${r.score} pts</div>
        `;
        els.roundRankings.appendChild(div);
      });
    }

    if (isHost) {
      els.roundEndHostActions && els.roundEndHostActions.classList.remove('hidden');
      els.roundEndGuestWaiting && els.roundEndGuestWaiting.classList.add('hidden');
    } else {
      els.roundEndHostActions && els.roundEndHostActions.classList.add('hidden');
      els.roundEndGuestWaiting && els.roundEndGuestWaiting.classList.remove('hidden');
    }

    if (els.overlayRoundEnd) els.overlayRoundEnd.classList.remove('hidden');
  }

  function showGameEnd(msg) {
    if (els.overlayRoundEnd) els.overlayRoundEnd.classList.add('hidden');
    if (els.finalRankings) {
      els.finalRankings.innerHTML = '';
      msg.finalRankings.forEach((r, i) => {
        const div = document.createElement('div');
        div.className = 'rank-item';
        let posClass = '';
        if (i === 0) posClass = 'gold';
        else if (i === 1) posClass = 'silver';
        else if (i === 2) posClass = 'bronze';
        div.innerHTML = `
          <div class="rank-pos ${posClass}">${i + 1}</div>
          <div style="flex:1;text-align:left">${escapeHtml(r.name)}</div>
          <div style="font-weight:700">${r.totalScore} pts</div>
        `;
        els.finalRankings.appendChild(div);
      });
    }
    if (els.overlayGameEnd) els.overlayGameEnd.classList.remove('hidden');
    if (els.btnPlayAgain) els.btnPlayAgain.classList.toggle('hidden', !isHost);
  }

  function hideOverlays() {
    if (els.overlayQuestionEnd) els.overlayQuestionEnd.classList.add('hidden');
    if (els.overlayRoundEnd) els.overlayRoundEnd.classList.add('hidden');
    if (els.overlayGameEnd) els.overlayGameEnd.classList.add('hidden');
    stopQeCountdown();
  }

  // ------------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------------
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------
  function init() {
    console.log('[Geo] init() running');

    if (els.btnJoin) {
      els.btnJoin.addEventListener('click', (e) => {
        e.preventDefault();
        console.log('[Geo] btnJoin click');
        doJoin();
      });
      console.log('[Geo] btnJoin handler attached');
    } else {
      console.error('[Geo] btnJoin not found!');
    }

    if (els.joinName) {
      els.joinName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doJoin();
      });
    }

    if (localStorage.getItem('geoName') && els.joinName) {
      els.joinName.value = localStorage.getItem('geoName');
    }

    // Load QR on join screen too
    loadQR();

    const settingMap = {
      'setting-mode': 'mode',
      'setting-timer': 'timerPerGuess',
      'setting-list-size': 'listSize',
      'setting-pool': 'optionPool',
    };

    [els.settingMode, els.settingTimer, els.settingListSize, els.settingPool].forEach(el => {
      if (!el) return;
      el.addEventListener('change', (e) => {
        const key = settingMap[e.target.id];
        if (key) onSettingChange(key, e.target.value);
      });
    });

    if (els.settingQuestions) {
      els.settingQuestions.addEventListener('change', (e) => {
        onSettingChange('questionsPerRound', e.target.value);
      });
    }

    if (els.btnStart) els.btnStart.addEventListener('click', () => send({ type: 'startRound' }));
    if (els.btnEndGame) els.btnEndGame.addEventListener('click', () => send({ type: 'endGame' }));
    if (els.btnNextRound) els.btnNextRound.addEventListener('click', () => send({ type: 'startRound' }));
    if (els.btnReturnLobby) els.btnReturnLobby.addEventListener('click', () => send({ type: 'returnToLobby' }));
    if (els.btnPlayAgain) els.btnPlayAgain.addEventListener('click', () => send({ type: 'playAgain' }));

    if (els.btnChangeName) {
      els.btnChangeName.addEventListener('click', () => {
        const newName = els.changeNameInput ? els.changeNameInput.value.trim() : '';
        if (!newName) return;
        localStorage.setItem('geoName', newName);
        send({ type: 'changeName', name: newName });
      });
    }
    if (els.changeNameInput) {
      els.changeNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && els.btnChangeName) els.btnChangeName.click();
      });
    }

    connect();
    showScreen('join');
    console.log('[Geo] init complete');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
