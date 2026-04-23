/**
 * Geo Challenge - Client App
 * Handles WS connection, screen routing, and game orchestration.
 */

(function() {
  'use strict';

  const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + (location.host || 'localhost:3000');
  let ws = null;
  let msgQueue = [];
  let myName = localStorage.getItem('geoName') || null;
  let roomId = null;
  let isHost = false;
  let isSpectator = false;
  let isConnected = false;
  let hasEverConnected = false;
  let gameState = 'LOBBY';
  let currentMode = 'highlight';
  let hasAnswered = false;
  let globe = null;
  let globeReady = false;
  let answeredPlayers = new Set();
  let pinThrottleTimer = null;
  let playerColorIndex = {};  // name -> index for pin colors

  console.log('[Geo] Script loaded. WS URL:', WS_URL);

  function getEl(id) {
    const el = document.getElementById(id);
    if (!el) console.warn('[Geo] Element not found:', id);
    return el;
  }

  const screens = {
    landing: getEl('screen-landing'),
    hostWait: getEl('screen-host-wait'),
    join: getEl('screen-join'),
    lobby: getEl('screen-lobby'),
    game: getEl('screen-game'),
  };

  const els = {
    btnStartRoom: getEl('btn-start-room'),
    btnJoinRoom: getEl('btn-join-room'),
    landingName: getEl('landing-name'),
    hostRoomId: getEl('host-room-id'),
    hostQrCode: getEl('host-qr-code'),
    hostRoomUrl: getEl('host-room-url'),
    hostWaitPlayerList: getEl('host-wait-player-list'),
    btnStartFromWait: getEl('btn-start-from-wait'),
    joinRoomId: getEl('join-room-id'),
    joinName: getEl('join-name'),
    btnJoin: getEl('btn-join'),
    btnBackToLanding: getEl('btn-back-to-landing'),
    joinStatus: getEl('join-status'),
    joinError: getEl('join-error'),
    lobbyPlayerList: getEl('lobby-player-list'),
    hostControls: getEl('host-controls'),
    guestWaiting: getEl('guest-waiting'),
    btnStart: getEl('btn-start'),
    lobbyQrCode: getEl('lobby-qr-code'),
    lobbyRoomUrl: getEl('lobby-room-url'),
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
    settingGuesses: getEl('setting-guesses'),
    settingChallenges: getEl('setting-challenges'),
    settingRowQuestions: getEl('setting-row-questions'),
    settingRowListsize: getEl('setting-row-listsize'),
    settingRowGuesses: getEl('setting-row-guesses'),
    settingRowChallenges: getEl('setting-row-challenges'),
    overlayGuessEnd: getEl('overlay-guess-end'),
    geTitle: getEl('ge-title'),
    geTable: getEl('ge-table'),
    geCountdown: getEl('ge-countdown'),
    overlayChallengeEnd: getEl('overlay-challenge-end'),
    ceTarget: getEl('ce-target'),
    ceRankings: getEl('ce-rankings'),
    challengeEndHostActions: getEl('challenge-end-host-actions'),
    challengeEndGuestWaiting: getEl('challenge-end-guest-waiting'),
    btnNextChallenge: getEl('btn-next-challenge'),
    btnEndChallengeGame: getEl('btn-end-challenge-game'),
    btnSkipQuestion: getEl('btn-skip-question'),
    btnSkipGuess: getEl('btn-skip-guess'),
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
  const connBar = document.getElementById('conn-bar');
  const connBarText = document.getElementById('conn-bar-text');
  let reconnectedFadeTimer = null;

  function setConnected(connected) {
    if (isConnected === connected) return;
    const wasEverConnected = hasEverConnected;
    isConnected = connected;
    if (connected) hasEverConnected = true;
    if (!connBar) return;
    clearTimeout(reconnectedFadeTimer);
    if (connected) {
      if (!wasEverConnected) return;
      connBar.classList.remove('hidden');
      connBar.classList.add('reconnected');
      connBarText.textContent = '✓ Reconnected';
      connBar.classList.add('visible');
      reconnectedFadeTimer = setTimeout(() => {
        connBar.classList.remove('visible');
        setTimeout(() => {
          connBar.classList.remove('reconnected');
          connBar.classList.add('hidden');
        }, 300);
      }, 2000);
    } else {
      connBar.classList.remove('reconnected', 'hidden');
      connBarText.textContent = '⚠ Connection lost — trying to reconnect...';
      connBar.classList.add('visible');
    }
  }

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
      setConnected(true);
      flushQueue();
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
      setConnected(false);
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
    if (connBar && connBar.classList.contains('visible')) {
      connBar.classList.remove('nudge');
      void connBar.offsetWidth;
      connBar.classList.add('nudge');
    }
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
        // Also update host-wait player list if we're on that screen
        if (screens.hostWait && screens.hostWait.classList.contains('active')) {
          renderHostWaitPlayerList(msg.players);
        }
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

      case 'roundStart':
        if (globe && globeReady) globe.clearAllPins();
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
        if (globe && globeReady) globe.clearAllPins();
        showScreen('lobby');
        updateLobbyVisibility();
        break;

      case 'playerAnswered':
        answeredPlayers.add(msg.name);
        updatePlayerChipsFromSet();
        break;

      case 'pinUpdate': {
        if (globe && globeReady) {
          const colorIdx = playerColorIndex[msg.name] ?? 0;
          globe.updateOtherPin(msg.name, msg.lng, msg.lat, colorIdx);
        }
        break;
      }
      case 'pinLocked': {
        if (globe && globeReady) globe.lockPinMarker(msg.name);
        answeredPlayers.add(msg.name);
        updatePlayerChipsFromSet();
        break;
      }
      case 'guessEnd':
        showGuessEnd(msg);
        break;
      case 'challengeEnd':
        showChallengeEnd(msg);
        break;

      case 'ping':
        send({ type: 'pong' });
        break;

      case 'roomClosed':
        console.log('[Geo] Room closed:', msg.reason);
        showScreen('landing');
        if (els.joinError) els.joinError.textContent = msg.reason || 'Room has ended. Please rejoin.';
        break;

      case 'error':
        console.error('[Geo] Server error:', msg.message);
        if (els.joinError) els.joinError.textContent = msg.message;
        break;
    }
  }

  // ------------------------------------------------------------------
  // Room Creation (Host)
  // ------------------------------------------------------------------
  async function doCreateRoom() {
    console.log('[Geo] Creating room...');
    try {
      const res = await fetch('/api/rooms', { method: 'POST' });
      const data = await res.json();
      if (!data.roomId) {
        console.error('[Geo] Failed to create room:', data);
        return;
      }
      roomId = data.roomId;
      console.log('[Geo] Room created:', roomId);

      // Update URL without reloading
      history.replaceState(null, '', `/?room=${roomId}`);

      // Show host wait screen
      if (els.hostRoomId) els.hostRoomId.textContent = roomId;
      if (els.hostQrCode) els.hostQrCode.src = data.qr;
      if (els.hostRoomUrl) els.hostRoomUrl.textContent = data.url;
      showScreen('hostWait');

      // Ensure WS is connected, then join
      connect();
      flushQueue();
      const name = els.landingName ? els.landingName.value.trim() : (myName || '');
      if (name) {
        localStorage.setItem('geoName', name);
        myName = name;
        send({ type: 'join', name, roomId });
      }
    } catch (e) {
      console.error('[Geo] Error creating room:', e);
    }
  }

  // ------------------------------------------------------------------
  // Join
  // ------------------------------------------------------------------
  function doJoin() {
    console.log('[Geo] doJoin called');
    const id = els.joinRoomId ? els.joinRoomId.value.trim().toUpperCase() : '';
    const name = els.joinName ? els.joinName.value.trim() : '';

    if (!id) {
      if (els.joinError) els.joinError.textContent = 'Please enter a Room ID.';
      return;
    }
    if (!name) {
      if (els.joinError) els.joinError.textContent = 'Please enter a name.';
      return;
    }

    if (els.joinError) els.joinError.textContent = '';
    roomId = id;
    localStorage.setItem('geoName', name);
    myName = name;
    send({ type: 'join', name, roomId });
  }

  // ------------------------------------------------------------------
  // Host Waiting Screen
  // ------------------------------------------------------------------
  function renderHostWaitPlayerList(players) {
    if (!els.hostWaitPlayerList) return;
    els.hostWaitPlayerList.innerHTML = '';
    const connected = players.filter(p => p.connected);
    if (connected.length === 0) {
      els.hostWaitPlayerList.innerHTML = '<p class="text-muted">Waiting for players...</p>';
      return;
    }
    for (const p of connected) {
      const div = document.createElement('div');
      div.className = 'player-item';
      let badges = '';
      if (p.isHost) badges += '<span class="host-badge">HOST</span>';
      div.innerHTML = `<span>${escapeHtml(p.name)}</span><span>${badges}</span>`;
      els.hostWaitPlayerList.appendChild(div);
    }
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
      loadLobbyQR();
    } else {
      els.hostControls && els.hostControls.classList.add('hidden');
      els.guestWaiting && els.guestWaiting.classList.remove('hidden');
    }
  }

  async function loadLobbyQR() {
    if (!roomId || !els.lobbyQrCode) return;
    try {
      const res = await fetch(`/api/rooms/${roomId}/qr`);
      const data = await res.json();
      if (els.lobbyQrCode) els.lobbyQrCode.src = data.qr;
      if (els.lobbyRoomUrl) els.lobbyRoomUrl.textContent = data.url;
    } catch (e) {
      console.error('Failed to load lobby QR', e);
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
    updateSettingsVisibility(settings.mode || 'highlight');
    if (els.settingGuesses)    els.settingGuesses.value    = String(settings.guessesPerChallenge ?? 5);
    if (els.settingChallenges) els.settingChallenges.value = String(settings.challengesPerGame ?? 5);
  }

  function onSettingChange(setting, value) {
    send({ type: 'updateSettings', setting, value });
  }

  function updateSettingsVisibility(mode) {
    const isProximity = mode === 'proximity';
    if (els.settingRowQuestions) els.settingRowQuestions.style.display = isProximity ? 'none' : '';
    if (els.settingRowListsize)  els.settingRowListsize.style.display  = isProximity ? 'none' : '';
    if (els.settingRowGuesses)   els.settingRowGuesses.style.display   = isProximity ? '' : 'none';
    if (els.settingRowChallenges) els.settingRowChallenges.style.display = isProximity ? '' : 'none';
  }

  // ------------------------------------------------------------------
  // Game
  // ------------------------------------------------------------------
  function updateHostGameActions() {
    if (!els.hostGameActions) return;
    if (!isHost || gameState === 'LOBBY') {
      els.hostGameActions.classList.add('hidden');
    } else {
      els.hostGameActions.classList.remove('hidden');
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

    if (msg.mode === 'proximity') {
      if (els.gamePrompt) els.gamePrompt.textContent = 'Where in the world is this country?';
      renderProximityQuestion(msg);
      return;
    }

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
    if (!els.answerPanel) return;
    els.answerPanel.innerHTML = '';
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.className = 'answer-btn';
      btn.textContent = opt;

      let triggered = false;
      const trigger = () => {
        if (triggered || hasAnswered) return;
        triggered = true;
        hasAnswered = true;
        btn.classList.add('selected');
        disableAllButtons();
        send({ type: 'answer', answer: opt });
      };

      btn.addEventListener('touchstart', () => {
        trigger();
      }, { passive: true });

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        trigger();
      });

      els.answerPanel.appendChild(btn);
    }
  }

  function renderProximityQuestion(msg) {
    if (!els.answerPanel) return;
    els.answerPanel.innerHTML = '';

    // Assign color indices to other players
    playerColorIndex = {};
    let idx = 0;
    if (lastPlayers) {
      for (const p of lastPlayers) {
        if (p.name !== myName) playerColorIndex[p.name] = idx++;
      }
    }

    globe.setDraggable(true);
    globe.setZoomable(true);
    globe.setMyPinName(myName);

    if (isSpectator) {
      const note = document.createElement('p');
      note.style.color = 'var(--text-muted)';
      note.textContent = 'Spectating — you can place a pin but it won\'t be counted.';
      els.answerPanel.appendChild(note);
      return;
    }

    const hint = document.createElement('p');
    hint.style.color = 'var(--text-muted)';
    hint.style.fontSize = '0.9rem';
    hint.textContent = 'Click the globe to place your pin. Then lock it in.';
    els.answerPanel.appendChild(hint);

    const lockBtn = document.createElement('button');
    lockBtn.className = 'btn-primary';
    lockBtn.id = 'btn-lock-pin';
    lockBtn.textContent = 'Confirm';
    lockBtn.disabled = true;
    lockBtn.style.marginTop = '0.5rem';
    els.answerPanel.appendChild(lockBtn);

    globe.onPinPlace = (lat, lng) => {
      lockBtn.disabled = false;
      clearTimeout(pinThrottleTimer);
      pinThrottleTimer = setTimeout(() => {
        send({ type: 'placePin', lat, lng });
      }, 300);
    };

    const lockTrigger = () => {
      if (lockBtn.disabled) return;
      lockBtn.disabled = true;
      lockBtn.textContent = 'Locked ✓';
      send({ type: 'lockPin' });
    };
    lockBtn.addEventListener('click', lockTrigger);
    lockBtn.addEventListener('touchstart', lockTrigger, { passive: true });
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

    const confirmTrigger = () => {
      if (!selected || hasAnswered) return;
      hasAnswered = true;
      confirmBtn.disabled = true;
      send({ type: 'answer', answer: selected });
    };

    confirmBtn.addEventListener('touchstart', () => {
      confirmTrigger();
    }, { passive: true });

    confirmBtn.addEventListener('click', (e) => {
      e.preventDefault();
      confirmTrigger();
    });
  }

  function disableAllButtons() {
    if (!els.answerPanel) return;
    for (const btn of els.answerPanel.querySelectorAll('button')) {
      btn.disabled = true;
      btn.classList.add('locked');
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
    if (els.btnSkipQuestion) els.btnSkipQuestion.classList.toggle('hidden', !isHost);
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

  function showGuessEnd(msg) {
    if (els.geTitle) {
      els.geTitle.textContent = msg.exactHit ? 'Exact Hit!' : 'Guess Complete';
    }

    if (els.geTable) {
      const sorted = [...msg.guesses].sort((a, b) => {
        if (a.distance === null) return 1;
        if (b.distance === null) return -1;
        return a.distance - b.distance;
      });

      const table = document.createElement('table');
      table.className = 'distance-table';
      table.innerHTML = '<thead><tr><th>Player</th><th>Location</th><th>Distance</th><th>Pts</th></tr></thead>';
      const tbody = document.createElement('tbody');

      for (const g of sorted) {
        const tr = document.createElement('tr');
        if (g.exactHit) tr.className = 'exact-hit';
        else if (g.distance === null) tr.className = 'no-pin';

        let location = '—';
        if (g.lat !== null && globe && globeReady) {
          const found = globe.findCountryAtPoint(g.lng, g.lat);
          location = found || 'Open Ocean';
        }

        const dist = g.distance === null ? '—'
          : g.distance === 0 ? '0 km ✓'
          : `${Math.round(g.distance).toLocaleString()} km`;

        tr.innerHTML = `
          <td>${escapeHtml(g.name)}</td>
          <td>${escapeHtml(location)}</td>
          <td>${dist}</td>
          <td>${g.points}</td>
        `;
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      els.geTable.innerHTML = '';
      els.geTable.appendChild(table);
    }

    if (globe && globeReady) globe.archivePins();

    if (els.overlayGuessEnd) els.overlayGuessEnd.classList.remove('hidden');
    if (!msg.challengeOver) {
      if (els.btnSkipGuess) els.btnSkipGuess.classList.toggle('hidden', !isHost);
      startGeCountdown();
    } else {
      if (els.geCountdown) els.geCountdown.style.display = 'none';
      if (els.btnSkipGuess) els.btnSkipGuess.classList.add('hidden');
    }
  }

  function startGeCountdown() {
    if (!els.geCountdown) return;
    els.geCountdown.style.display = '';
    els.geCountdown.classList.remove('animate');
    void els.geCountdown.offsetWidth;
    els.geCountdown.classList.add('animate');
  }

  function showChallengeEnd(msg) {
    if (els.overlayGuessEnd) els.overlayGuessEnd.classList.add('hidden');
    if (els.geCountdown) els.geCountdown.style.display = '';

    if (globe && globeReady) {
      globe.setDraggable(false);
      globe.clearAllPins();
      globe.highlightCountry(msg.targetName);
    }

    if (els.ceTarget) els.ceTarget.textContent = `Target: ${msg.targetName}`;

    if (els.ceRankings) {
      els.ceRankings.innerHTML = '';
      msg.rankings.forEach((r, i) => {
        const div = document.createElement('div');
        div.className = 'rank-item';
        let posClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
        div.innerHTML = `
          <div class="rank-pos ${posClass}">${i + 1}</div>
          <div style="flex:1;text-align:left">${escapeHtml(r.name)}</div>
          <div>${r.score} pts <span style="color:var(--text-muted);font-size:0.8em">(${r.totalScore} total)</span></div>
        `;
        els.ceRankings.appendChild(div);
      });
    }

    if (isHost) {
      if (els.challengeEndHostActions) {
        els.challengeEndHostActions.classList.remove('hidden');
        if (els.btnNextChallenge) {
          els.btnNextChallenge.style.display = msg.isLastChallenge ? 'none' : '';
        }
      }
      if (els.challengeEndGuestWaiting) els.challengeEndGuestWaiting.classList.add('hidden');
    } else {
      if (els.challengeEndHostActions) els.challengeEndHostActions.classList.add('hidden');
      if (els.challengeEndGuestWaiting) els.challengeEndGuestWaiting.classList.remove('hidden');
    }

    if (els.overlayChallengeEnd) els.overlayChallengeEnd.classList.remove('hidden');
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
    if (els.overlayGuessEnd)    els.overlayGuessEnd.classList.add('hidden');
    if (els.overlayChallengeEnd) els.overlayChallengeEnd.classList.add('hidden');
    if (els.geCountdown) els.geCountdown.style.display = '';
    if (els.btnSkipQuestion) els.btnSkipQuestion.classList.add('hidden');
    if (els.btnSkipGuess) els.btnSkipGuess.classList.add('hidden');
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

    // Landing screen
    if (els.btnStartRoom) {
      els.btnStartRoom.addEventListener('click', () => {
        doCreateRoom();
      });
    }
    if (els.btnJoinRoom) {
      els.btnJoinRoom.addEventListener('click', () => {
        // Carry over name from landing to join screen
        if (els.landingName && els.joinName) {
          els.joinName.value = els.landingName.value.trim();
        }
        showScreen('join');
      });
    }
    if (els.btnBackToLanding) {
      els.btnBackToLanding.addEventListener('click', () => {
        showScreen('landing');
      });
    }

    // Join screen
    if (els.btnJoin) {
      els.btnJoin.addEventListener('click', (e) => {
        e.preventDefault();
        console.log('[Geo] btnJoin click');
        doJoin();
      });
    }

    if (els.joinName) {
      els.joinName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doJoin();
      });
    }
    if (els.joinRoomId) {
      els.joinRoomId.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doJoin();
      });
    }

    // Pre-fill name
    const savedName = localStorage.getItem('geoName') || '';
    if (savedName) {
      if (els.joinName) els.joinName.value = savedName;
      if (els.landingName) els.landingName.value = savedName;
    }

    // Pre-fill room ID from URL
    const urlRoomId = new URLSearchParams(location.search).get('room');
    if (urlRoomId && els.joinRoomId) {
      els.joinRoomId.value = urlRoomId.toUpperCase();
    }

    // Host wait screen start button
    if (els.btnStartFromWait) {
      els.btnStartFromWait.addEventListener('click', () => {
        send({ type: 'startRound' });
      });
    }

    // Settings
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
        if (e.target.id === 'setting-mode') updateSettingsVisibility(e.target.value);
      });
    });

    const settingMapExtended = { 'setting-guesses': 'guessesPerChallenge', 'setting-challenges': 'challengesPerGame' };
    [els.settingGuesses, els.settingChallenges].forEach(el => {
      if (!el) return;
      el.addEventListener('change', (e) => {
        const key = settingMapExtended[e.target.id];
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
    if (els.btnNextChallenge)    els.btnNextChallenge.addEventListener('click', () => send({ type: 'startRound' }));
    if (els.btnEndChallengeGame) els.btnEndChallengeGame.addEventListener('click', () => send({ type: 'endGame' }));
    if (els.btnSkipQuestion) els.btnSkipQuestion.addEventListener('click', () => send({ type: 'skipToNext' }));
    if (els.btnSkipGuess)    els.btnSkipGuess.addEventListener('click', () => send({ type: 'skipToNext' }));

    if (els.btnChangeName) {
      els.btnChangeName.addEventListener('click', () => {
        const newName = els.changeNameInput ? els.changeNameInput.value.trim() : '';
        if (!newName) return;
        myName = newName;
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

    // If there's a room ID in the URL, show join screen directly
    if (urlRoomId) {
      showScreen('join');
    } else {
      showScreen('landing');
    }

    console.log('[Geo] init complete');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
