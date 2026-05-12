import { createGlobe } from './globe3d.js';
import { ClientMessage, ServerMessage, GameState, Screen } from '../shared/constants.js';
import { SpyWheelCanvas } from './spy-wheel.js';

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
  let hostName = localStorage.getItem('geoHost') || null;
  let roomId = null;
  let isHost = false;
  let isSpectator = false;
  let isConnected = false;
  let hasEverConnected = false;
  let hasPreviouslyConnected = false;
  let gameState = GameState.LOBBY;
  let currScreen = Screen.LANDING
  let currentMode = 'highlight';
  let hasAnswered = false;
  let globe = null;
  let globeReady = false;
  let globeLoadPromise = null;
  let answeredPlayers = new Set();
  let pinThrottleTimer = null;
  let playerColorIndex = {};  // name -> index for pin colors
  let spyWheel = null;
  let guesserWheel = null;
  let spyPinDebounceTimers = {};   // playerName -> setTimeout id
  let currentSpyName = null;
  let spyBannerTimer = null;

  console.log('[Geo] Script loaded. WS URL:', WS_URL);

  function getEl(id) {
    const el = document.getElementById(id);
    if (!el) console.warn('[Geo] Element not found:', id);
    return el;
  }

  const screens = {
    landing: getEl('screen-landing'),
    join: getEl('screen-join'),
    lobby: getEl('screen-lobby'),
    game: getEl('screen-game'),
  };

  const els = {
    btnStartRoom: getEl('btn-start-room'),
    btnJoinRoom: getEl('btn-join-room'),
    landingName: getEl('landing-name'),
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
    guestQrCode: getEl('guest-qr-code'),
    lobbyRoomUrl: getEl('lobby-room-url'),
    settingMode: getEl('setting-mode'),
    settingQuestions: getEl('setting-questions'),
    settingTimer: getEl('setting-timer'),
    settingListSize: getEl('setting-list-size'),
    settingPool: getEl('setting-pool'),
    gameQuestion: getEl('game-question'),
    gameTimer: getEl('game-timer'),
    gamePrompt: getEl('game-prompt'),
    answerPanel: getEl('answer-panel'),
    panelSpectatorWatch: getEl('panel-spectator-watch'),
    panelProximity: getEl('panel-proximity'),
    panelSelect: getEl('panel-select'),
    btnLockPin: getEl('btn-lock-pin'),
    btnConfirmSelect: getEl('btn-confirm-select'),
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
    guessEndHostActions: getEl('guess-end-host-actions'),
    btnSkipGuess: getEl('btn-skip-guess'),
    overlayChallengeEnd: getEl('overlay-challenge-end'),
    ceTarget: getEl('ce-target'),
    ceRankings: getEl('ce-rankings'),
    challengeEndHostActions: getEl('challenge-end-host-actions'),
    challengeEndGuestWaiting: getEl('challenge-end-guest-waiting'),
    btnNextChallenge: getEl('btn-next-challenge'),
    btnEndChallengeGame: getEl('btn-end-challenge-game'),
    overlaySpyPicking:     getEl('overlay-spy-picking'),
    spyNextBanner:         getEl('spy-next-banner'),
    spyPickingUi:          getEl('spy-picking-ui'),
    spyRoundLabel:         getEl('spy-round-label'),
    spyTurnLabel:          getEl('spy-turn-label'),
    spyWheelCanvas:        getEl('spy-wheel-canvas'),
    spySelectedLabel:      getEl('spy-selected-label'),
    btnSpySpin:            getEl('btn-spy-spin'),
    btnSpyConfirm:         getEl('btn-spy-confirm'),
    guesserWaitingUi:      getEl('guesser-waiting-ui'),
    guesserWheelCanvas:    getEl('guesser-wheel-canvas'),
    guesserWaitingLabel:   getEl('guesser-waiting-label'),
    panelSpyWatching:      getEl('panel-spy-watching'),
    spyPinToasts:          getEl('spy-pin-toasts'),
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

    if (!globe) return;
    if (name === Screen.LANDING) {
      globe.transitionTo('landing');
      if (globeReady) globe.startLobbyDemo(currentMode || 'highlight');
    } else if (name === Screen.LOBBY) {
      if (currScreen !== Screen.LOBBY) {
          globe.transitionTo('lobby');
      }
      if (globeReady) globe.startLobbyDemo(currentMode || 'highlight');
    } else if (name === Screen.GAME) {
      if (currScreen === Screen.LOBBY) {
          globe.stopLobbyDemo();
          globe.transitionTo('gameplay');
        }
    }
    currScreen = name;
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
      if (roomId && hasPreviouslyConnected && myName) {
        send({ type: ClientMessage.JOIN, name: myName, roomId });
      }
      flushQueue();
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type !== ServerMessage.PING) {
            console.log('[Geo] WS msg:', msg.type, msg);
        }
        handleMessage(msg);
      } catch (e) {
        console.error('[Geo] Invalid WS message', e, evt.data);
      }
    };

    ws.onclose = (evt) => {
      console.log('[Geo] WebSocket close', evt.code, evt.reason);
      setJoinStatus('Disconnected. Reconnecting...', true);
      hasPreviouslyConnected = true;
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
    gameState = msg.gameState;
    switch (msg.type) {
      case ServerMessage.JOINED:
        showScreen(Screen.LOBBY);
        myName = msg.name;
        if (hostName === myName) {
          isHost = true;
        }
        updateLobbyVisibility();
        localStorage.setItem('geoName', myName);
        localStorage.setItem('geoRoom', roomId);
        console.log('[Geo] Joined as:', myName);
        break;

      case ServerMessage.PLAYERS:
        renderPlayerList(msg.players);
        break;

      case ServerMessage.SETTINGS:
        updateSettingsUI(msg.settings);
        break;

      case ServerMessage.HOST_ASSIGNED:
        hostName = msg.hostName;
        localStorage.setItem('geoHost', hostName);
        if (hostName === myName) {
          isHost = true;
          updateLobbyVisibility();
          updateHostGameActions();
        }
        break;

      case ServerMessage.ROUND_START:
        if (globe && globeReady) globe.clearAllPins();
        break;

      case ServerMessage.QUESTION:
        showScreen(Screen.GAME);
        hideOverlays();
        hasAnswered = false;
        answeredPlayers.clear();
        currentMode = msg.mode;
        renderQuestion(msg);
        break;

      case ServerMessage.TICK:
        updateTimer(msg.remaining);
        if (msg.remaining > 0 && msg.remaining <= 5) {
          sounds.countdown(msg.remaining);
        }
        break;

      case ServerMessage.QUESTION_END:
        showQuestionEnd(msg);
        break;

      case ServerMessage.ROUND_END:
        showRoundEnd(msg);
        break;

      case ServerMessage.GAME_END:
        showGameEnd(msg);
        break;

      case ServerMessage.LOBBY_RESET:
        hideOverlays();
        if (globe && globeReady) globe.clearAllPins();
        showScreen(Screen.LOBBY);
        updateLobbyVisibility();
        break;

      case ServerMessage.PLAYER_ANSWERED:
        answeredPlayers.add(msg.name);
        break;

      case ServerMessage.PIN_UPDATE: {
        if (globe && globeReady) {
          const colorIdx = playerColorIndex[msg.name] ?? 0;
          globe.updateOtherPin(msg.name, msg.lng, msg.lat, colorIdx);
        }
        break;
      }
      case ServerMessage.PIN_LOCKED: {
        if (globe && globeReady) globe.lockPinMarker(msg.name);
        answeredPlayers.add(msg.name);
        break;
      }
      case ServerMessage.GUESS_END:
        showGuessEnd(msg);
        break;
      case ServerMessage.CHALLENGE_END:
        showChallengeEnd(msg);
        break;

      case ServerMessage.SPY_PICKING:
        showSpyPicking(msg);
        break;

      case ServerMessage.RESTORE:
        applyRestore(msg);
        break;

      case ServerMessage.PING:
        send({ type: ClientMessage.PONG });
        break;

      case ServerMessage.ROOM_CLOSED:
        console.log('[Geo] Room closed:', msg.reason);
        localStorage.removeItem('geoRoom');
        showScreen(Screen.LANDING);
        if (els.joinError) els.joinError.textContent = msg.reason || 'Room has ended. Please rejoin.';
        break;

      case ServerMessage.ERROR:
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

      // Ensure WS is connected, then join
      connect();
      flushQueue();
      const name = els.landingName ? els.landingName.value.trim() : (myName || '');
      send({ type: ClientMessage.JOIN, name, roomId });
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
    send({ type: ClientMessage.JOIN, name, roomId });
  }

  // ------------------------------------------------------------------
  // Host Waiting Screen
  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  // Lobby
  // ------------------------------------------------------------------
  function updateLobbyVisibility() {
    console.log('updateLobbyVisibility', isHost);
    const savedName = localStorage.getItem('geoName') || '';
    if (isHost) {
      els.hostControls && els.hostControls.classList.remove('hidden');
      els.guestWaiting && els.guestWaiting.classList.add('hidden');
    } else {
      els.hostControls && els.hostControls.classList.add('hidden');
      els.guestWaiting && els.guestWaiting.classList.remove('hidden');
    }
    loadLobbyQR();
  }

  async function loadLobbyQR() {
    if (!roomId || !els.lobbyQrCode) return;
    try {
      const res = await fetch(`/api/rooms/${roomId}/qr`);
      const data = await res.json();
      if (els.lobbyQrCode) els.lobbyQrCode.src = data.qr;
      if (els.guestQrCode) els.guestQrCode.src = data.qr;
      if (els.lobbyRoomUrl) els.lobbyRoomUrl.textContent = data.url;
    } catch (e) {
      console.error('Failed to load lobby QR', e);
    }
  }

  let editingName = false;

  function attachNameEdit(div, badges) {
    div.querySelector('.player-name-editable').addEventListener('click', () => {
      editingName = true;
      div.innerHTML = `
        <input class="player-name-input" type="text" maxlength="20" autocomplete="off" value="${escapeHtml(myName)}">
        <span class="player-name-badges">${badges}</span>
        <button class="player-name-confirm">Change</button>
      `;
      const input = div.querySelector('.player-name-input');
      input.focus();
      input.select();
      const confirm = () => {
        const newName = input.value.trim();
        if (!newName) return;
        myName = newName;
        localStorage.setItem('geoName', newName);
        editingName = false;
        send({ type: ClientMessage.CHANGE_NAME, name: newName });
      };
      div.querySelector('.player-name-confirm').addEventListener('click', confirm);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm(); });
      input.addEventListener('blur', () => {
        setTimeout(() => {
          if (editingName && !div.contains(document.activeElement)) {
            editingName = false;
            div.innerHTML = `
              <span class="player-name-editable" title="Click to change name">${escapeHtml(myName)}</span>
              <span>${badges}</span>
            `;
            attachNameEdit(div, badges);
          }
        }, 150);
      });
    });
  }

  function renderPlayerList(players) {
    if (!els.lobbyPlayerList) return;
    if (editingName) return;
    els.lobbyPlayerList.innerHTML = '';
    for (const p of players) {
      const div = document.createElement('div');
      div.className = 'player-item';
      let badges = '';
      if (p.isHost) badges += '<span class="host-badge">HOST</span>';
      if (p.spectator) badges += '<span class="spectator-badge">SPEC</span>';
      if (p.name === myName) {
        div.innerHTML = `
          <span class="player-name-editable" title="Click to change name">${escapeHtml(p.name)} ${!p.connected ? '(left)' : ''}</span>
          <span>${badges}</span>
        `;
        attachNameEdit(div, badges);
      } else {
        div.innerHTML = `
          <span>${escapeHtml(p.name)} ${!p.connected ? '(left)' : ''}</span>
          <span>${badges}</span>
        `;
      }
      els.lobbyPlayerList.appendChild(div);
    }
  }

  function updateSettingsUI(settings) {
    if (els.settingMode) els.settingMode.value = settings.mode || 'highlight';
    if (els.settingQuestions) els.settingQuestions.value = settings.questionsPerRound || 10;
    if (els.settingTimer) els.settingTimer.value = String(settings.timerPerGuess ?? 0);
    if (els.settingListSize) els.settingListSize.value = String(settings.listSize ?? 4);
    if (els.settingPool) els.settingPool.value = settings.optionPool || 'random';
    updateSettingsVisibility(settings.mode || 'highlight');
    if (els.settingGuesses)    els.settingGuesses.value    = String(settings.guessesPerChallenge ?? 5);
    if (els.settingChallenges) els.settingChallenges.value = String(settings.challengesPerGame ?? 5);
  }

  function onSettingChange(setting, value) {
    send({ type: ClientMessage.UPDATE_SETTINGS, setting, value });
  }

  function updateSettingsVisibility(mode) {
    const isProximity = mode === 'proximity' || mode === 'spy';
    if (els.settingRowQuestions) els.settingRowQuestions.style.display = isProximity ? 'none' : '';
    if (els.settingRowListsize)  els.settingRowListsize.style.display  = isProximity ? 'none' : '';
    if (els.settingRowGuesses)   els.settingRowGuesses.style.display   = isProximity ? '' : 'none';
    if (els.settingRowChallenges) els.settingRowChallenges.style.display = isProximity ? '' : 'none';
  }

  // ------------------------------------------------------------------
  // Game
  // ------------------------------------------------------------------
  function updateHostGameActions() {
    console.log('updateHostGameActions');
    if (!els.hostGameActions) return;
    if (!isHost || gameState === GameState.LOBBY) {
      els.hostGameActions.classList.add('hidden');
    } else {
      els.hostGameActions.classList.remove('hidden');
    }
  }

  function renderQuestion(msg) {
    if (els.gameQuestion) els.gameQuestion.textContent = `Question ${msg.index + 1}/${msg.totalQuestions}`;
    if (els.gameTimer) {
      els.gameTimer.textContent = msg.timeLimit > 0 ? (msg.timeRemaining ?? msg.timeLimit) : '∞';
      els.gameTimer.className = 'timer';
    }
    if (els.answerPanel) els.answerPanel.innerHTML = '';
    if (els.gamePrompt) els.gamePrompt.textContent = '';
    hasAnswered = false;
    answeredPlayers.clear();

    // Render UI immediately (answer buttons, panels)
    setupQuestion(msg);
    updateHostGameActions();
  }

  function setupQuestion(msg) {
    const target = msg.targetName;

    if (msg.mode === 'proximity' || msg.mode === 'spy') {
      if (els.gamePrompt) els.gamePrompt.textContent = 'Where in the world is this country?';
      renderProximityQuestion(msg);
      return;
    }

    if (isSpectator) {
      if (els.gamePrompt) els.gamePrompt.textContent = 'Spectator Mode';
      if (els.answerPanel) els.answerPanel.innerHTML = '';
      hideAnswerPanels();
      if (els.panelSpectatorWatch) els.panelSpectatorWatch.classList.remove('hidden');
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
    hideAnswerPanels();
    els.answerPanel.classList.remove('hidden');
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.className = 'answer-btn';
      btn.textContent = opt;
      btn.dataset.answer = opt;

      let triggered = false;
      const trigger = () => {
        if (triggered || hasAnswered) return;
        triggered = true;
        hasAnswered = true;
        btn.classList.add('selected');
        disableAllButtons();
        send({ type: ClientMessage.ANSWER, answer: opt });
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
    hideAnswerPanels();

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
      if (els.panelSpectatorWatch) els.panelSpectatorWatch.classList.remove('hidden');
      return;
    }

    if (els.panelProximity) els.panelProximity.classList.remove('hidden');
    const lockBtn = els.btnLockPin;
    if (lockBtn) {
      lockBtn.disabled = true;
      lockBtn.textContent = 'Confirm';
    }
    globe.onCountryClick = null;
    globe.onPinPlace = (lat, lng) => {
      if (lockBtn) lockBtn.disabled = false;
      clearTimeout(pinThrottleTimer);
      pinThrottleTimer = setTimeout(() => {
        send({ type: ClientMessage.PLACE_PIN, lat, lng });
      }, 300);
    };

    const lockTrigger = () => {
      if (!lockBtn || lockBtn.disabled) return;
      lockBtn.disabled = true;
      lockBtn.textContent = 'Locked ✓';
      send({ type: ClientMessage.LOCK_PIN });
    };
    if (lockBtn) {
      lockBtn.onclick = lockTrigger;
      lockBtn.ontouchstart = lockTrigger;
    }

    // If spy mode and this player is the spy, show watching panel instead of pin UI
    if (currentMode === 'spy' && myName === currentSpyName) {
      if (els.panelProximity) els.panelProximity.classList.add('hidden');
      if (els.panelSpyWatching) els.panelSpyWatching.classList.remove('hidden');
      globe.onPinPlace = null;  // spy cannot place pins
    }
  }

  function hideAnswerPanels() {
    for (const p of [els.answerPanel, els.panelSpectatorWatch, els.panelProximity, els.panelSelect, els.panelSpyWatching]) {
      if (p) p.classList.add('hidden');
    }
  }

  function renderSelectMode(target) {
    if (!els.answerPanel) return;
    els.answerPanel.innerHTML = '';
    hideAnswerPanels();
    if (els.panelSelect) els.panelSelect.classList.remove('hidden');

    const confirmBtn = els.btnConfirmSelect;
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Confirm';
    }

    let selected = null;
    
    globe.onPinPlace = null;
    globe.onCountryClick = (name) => {
      if (hasAnswered) return;
      selected = name;
      if (confirmBtn) confirmBtn.disabled = false;
    };

    const confirmTrigger = () => {
      if (!selected || hasAnswered) return;
      hasAnswered = true;
      if (confirmBtn) confirmBtn.disabled = true;
      send({ type: ClientMessage.ANSWER, answer: selected });
    };

    if (confirmBtn) {
      confirmBtn.ontouchstart = () => confirmTrigger();
      confirmBtn.onclick = (e) => { e.preventDefault(); confirmTrigger(); };
    }
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

  let lastPlayers = [];

  // ------------------------------------------------------------------
  // Overlays
  // ------------------------------------------------------------------
  function showQuestionEnd(msg) {
    // Mark answer buttons correct/wrong (highlight mode)
    if (els.answerPanel) {
      for (const btn of els.answerPanel.querySelectorAll('.answer-btn')) {
        if (btn.dataset.answer === msg.correctAnswer) {
          btn.classList.add('correct');
        } else if (btn.classList.contains('selected')) {
          btn.classList.add('wrong');
        }
      }
    }

    if (currentMode === 'select') {
      if (els.answerPanel) els.answerPanel.innerHTML = '';
      if (els.gamePrompt) els.gamePrompt.textContent = `Answer: ${msg.correctAnswer}`;
      if (globe && globeReady) {
        globe.setDraggable(false);
        globe.clearHighlight();
        globe.highlightCountry(msg.correctAnswer);
      }
      // fall through to show overlay with player results
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

    if (els.guessEndHostActions) {
      els.guessEndHostActions.classList.toggle('hidden', !(isHost && !msg.challengeOver));
    }
    if (els.overlayGuessEnd) els.overlayGuessEnd.classList.remove('hidden');
    if (!msg.challengeOver) {
      startGeCountdown();
    } else {
      if (els.geCountdown) els.geCountdown.style.display = 'none';
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

  function showSpyPicking(msg) {
    showScreen(Screen.GAME);
    hideOverlays();
    if (els.overlaySpyPicking) els.overlaySpyPicking.classList.remove('hidden');
    currentSpyName = msg.spyName;

    // Show 2s "next spy" banner if this isn't the very first pick
    if (msg.turnInRound > 1 || msg.round > 1) {
      showSpyBanner(msg.spyName === myName ? 'You are spy next' : `${escapeHtml(msg.spyName)} is spy next`, () => {
        renderSpyPickingScreen(msg, msg.spyName === myName);
      });
    } else {
      renderSpyPickingScreen(msg, msg.spyName === myName);
    }
  }

  function showSpyBanner(text, onDone) {
    if (!els.spyNextBanner) { onDone(); return; }
    if (spyBannerTimer) { clearTimeout(spyBannerTimer); spyBannerTimer = null; }
    els.spyNextBanner.textContent = text;
    els.spyNextBanner.classList.remove('hidden');
    if (els.spyPickingUi) els.spyPickingUi.classList.add('hidden');
    if (els.guesserWaitingUi) els.guesserWaitingUi.classList.add('hidden');
    spyBannerTimer = setTimeout(() => {
      spyBannerTimer = null;
      els.spyNextBanner.classList.add('hidden');
      onDone();
    }, 2000);
  }

  function renderSpyPickingScreen(msg, isSpy) {
    if (els.spyRoundLabel) els.spyRoundLabel.textContent = `Round ${msg.round}/${msg.totalRounds}`;
    if (els.spyTurnLabel) els.spyTurnLabel.textContent = `Turn ${msg.turnInRound}/${msg.totalTurns}`;

    if (isSpy) {
      if (els.spyPickingUi) els.spyPickingUi.classList.remove('hidden');
      if (els.guesserWaitingUi) els.guesserWaitingUi.classList.add('hidden');
      initSpyWheel();
    } else {
      if (els.spyPickingUi) els.spyPickingUi.classList.add('hidden');
      if (els.guesserWaitingUi) els.guesserWaitingUi.classList.remove('hidden');
      if (els.guesserWaitingLabel) {
        els.guesserWaitingLabel.textContent = `${escapeHtml(msg.spyName)} is choosing...`;
      }
      initGuesserWheel();
    }
  }

  function initSpyWheel() {
    if (spyWheel) spyWheel.stop();
    const canvas = els.spyWheelCanvas;
    if (!canvas) return;

    const size = window.innerWidth >= 800 ? 320 : 220;
    canvas.width  = size;
    canvas.height = size;

    const countries = (window.__gameCountries || []).map(c => ({ name: c.name, flag: '' }));
    if (!countries.length) return;

    spyWheel = new SpyWheelCanvas(canvas, countries);
    spyWheel.onSelect = (name) => {
      if (els.spySelectedLabel) els.spySelectedLabel.textContent = name || '';
      if (els.btnSpyConfirm) els.btnSpyConfirm.disabled = !name;
      if (globe && globeReady && name) globe.highlightCountry(name);
    };
    spyWheel.start();

    if (els.btnSpySpin) {
      els.btnSpySpin.onclick = () => spyWheel.spin();
    }
    if (els.btnSpyConfirm) {
      els.btnSpyConfirm.disabled = true;
      els.btnSpyConfirm.onclick = () => {
        const name = spyWheel.selectedName;
        if (!name) return;
        if (globe && globeReady) globe.clearHighlight();
        send({ type: ClientMessage.PICK_COUNTRY, name });
        spyWheel.stop();
      };
    }
  }

  function initGuesserWheel() {
    if (guesserWheel) stopGuesserWheel();
    const canvas = els.guesserWheelCanvas;
    if (!canvas) return;

    const size = window.innerWidth >= 800 ? 280 : 200;
    canvas.width  = size;
    canvas.height = size;

    // Blurred decorative version: use same countries but no labels
    const countries = (window.__gameCountries || []).map(() => ({ name: '', flag: '' }));
    if (!countries.length) return;

    guesserWheel = new SpyWheelCanvas(canvas, countries);
    const slowSpinId = setInterval(() => {
      if (!guesserWheel) return;
      guesserWheel.rotation += 0.005;
      guesserWheel._normalise();
    }, 16);
    guesserWheel._slowSpinId = slowSpinId;
    guesserWheel.start();
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

  // ------------------------------------------------------------------
  // Restore (reconnect state replay)
  // ------------------------------------------------------------------
  function applyRestore(msg) {
    // 1. Set local state flags
    isHost = msg.me.isHost;
    isSpectator = msg.me.spectator;
    gameState = msg.gameState;
    currentMode = msg.question?.mode ?? msg.settings.mode;

    // 2. Sync UI state
    updateSettingsUI(msg.settings);
    renderPlayerList(msg.players);
    updateHostGameActions();

    // 3. Show correct screen
    if (msg.gameState === GameState.LOBBY) {
      showScreen(Screen.LOBBY);
      updateLobbyVisibility();
      return;
    }
    showScreen(Screen.GAME);

    // 4. Render per-state
    switch (msg.gameState) {
      case GameState.QUESTION: {
        hideOverlays();
        renderQuestion(msg.question);
        // For proximity mode: replay other players' pins once globe is ready
        if (msg.question.mode === 'proximity' && msg.pins?.length) {
          // Build playerColorIndex from players list (same logic as renderProximityQuestion)
          playerColorIndex = {};
          let idx = 0;
          for (const p of msg.players) {
            if (p.name !== myName) playerColorIndex[p.name] = idx++;
          }
          const replayPins = () => {
            if (!globe || !globeReady) return;
            for (const pin of msg.pins) {
              if (pin.name !== myName) {
                const colorIdx = playerColorIndex[pin.name] ?? 0;
                globe.updateOtherPin(pin.name, pin.lng, pin.lat, colorIdx);
                if (pin.locked) globe.lockPinMarker(pin.name);
              }
            }
          };
          if (globe && globeReady) {
            replayPins();
          } else {
            // Globe will be ready after renderQuestion's load() promise resolves;
            // patch globeReady setter via polling is impractical, so we hook into
            // the existing pattern: renderQuestion creates the globe and calls
            // setupQuestion in the .then(). We schedule a one-shot check.
            const waitForGlobe = setInterval(() => {
              if (globe && globeReady) {
                clearInterval(waitForGlobe);
                clearTimeout(globeWaitTimeout);
                replayPins();
              }
            }, 100);
            const globeWaitTimeout = setTimeout(() => clearInterval(waitForGlobe), 10000);
          }
        }
        break;
      }

      case GameState.QUESTION_END: {
        hideOverlays();
        renderQuestion(msg.question);
        if (msg.lastGuessEnd !== null) {
          // Proximity mode QUESTION_END
          showGuessEnd(msg.lastGuessEnd);
          if (msg.pins?.length) {
            // Build playerColorIndex
            playerColorIndex = {};
            let idx = 0;
            for (const p of msg.players) {
              if (p.name !== myName) playerColorIndex[p.name] = idx++;
            }
            const replayPins = () => {
              if (!globe || !globeReady) return;
              for (const pin of msg.pins) {
                const colorIdx = pin.name === myName ? -1 : (playerColorIndex[pin.name] ?? 0);
                if (pin.name !== myName) globe.updateOtherPin(pin.name, pin.lng, pin.lat, colorIdx);
                if (pin.locked) globe.lockPinMarker(pin.name);
              }
              globe.archivePins();
            };
            if (globe && globeReady) {
              replayPins();
            } else {
              const waitForGlobe = setInterval(() => {
                if (globe && globeReady) {
                  clearInterval(waitForGlobe);
                  clearTimeout(globeWaitTimeout);
                  replayPins();
                }
              }, 100);
              const globeWaitTimeout = setTimeout(() => clearInterval(waitForGlobe), 10000);
            }
          }
        } else {
          // Highlight/select mode QUESTION_END
          showQuestionEnd(msg.lastQuestionEnd);
        }
        break;
      }

      case GameState.ROUND_END: {
        hideOverlays();
        if (msg.lastChallengeEnd !== null) {
          showChallengeEnd(msg.lastChallengeEnd);
        } else {
          showRoundEnd(msg.lastRoundEnd);
        }
        break;
      }

      case GameState.GAME_END: {
        showGameEnd(msg.lastGameEnd);
        break;
      }

      default:
        console.warn('[Geo] applyRestore: unhandled gameState', msg.gameState);
    }
  }

  function stopGuesserWheel() {
    if (guesserWheel) {
      if (guesserWheel._slowSpinId) clearInterval(guesserWheel._slowSpinId);
      guesserWheel.stop();
      guesserWheel = null;
    }
  }

  function hideOverlays() {
    for (const o of [
      els.overlayQuestionEnd, els.overlayRoundEnd, els.overlayGameEnd,
      els.overlayGuessEnd, els.overlayChallengeEnd, els.overlaySpyPicking,
    ]) {
      if (o) o.classList.add('hidden');
    }
    if (els.geCountdown) els.geCountdown.style.display = '';
    stopQeCountdown();
    stopGuesserWheel();
    if (spyWheel) { spyWheel.stop(); spyWheel = null; }
    if (globe && globeReady) globe.clearHighlight();
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
        showScreen(Screen.JOIN);
      });
    }
    if (els.btnBackToLanding) {
      els.btnBackToLanding.addEventListener('click', () => {
        showScreen(Screen.LANDING);
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
    const savedRoomId = localStorage.getItem('geoRoom');
    if (!urlRoomId && savedRoomId && els.joinRoomId) {
      els.joinRoomId.value = savedRoomId;
      roomId = savedRoomId;
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
        if (e.target.id === 'setting-mode') {
          updateSettingsVisibility(e.target.value);
          currentMode = e.target.value;
          if (globeReady && screens.lobby && screens.lobby.classList.contains('active')) {
            globe.startLobbyDemo(e.target.value);
          }
        }
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

    // Stepper controls
    document.addEventListener('click', (e) => {
      const dec = e.target.closest('.stepper-dec');
      const inc = e.target.closest('.stepper-inc');
      if (!dec && !inc) return;
      const stepper = (dec || inc).closest('.stepper');
      if (!stepper) return;
      const input = stepper.querySelector('input[type="number"]');
      if (!input) return;
      const min = input.min !== '' ? Number(input.min) : -Infinity;
      const max = input.max !== '' ? Number(input.max) : Infinity;
      const current = Number(input.value);
      const next = dec ? Math.max(min, current - 1) : Math.min(max, current + 1);
      if (next !== current) {
        input.value = next;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    if (els.btnStart) els.btnStart.addEventListener('click', () => send({ type: ClientMessage.START_ROUND }));
    if (els.btnEndGame) els.btnEndGame.addEventListener('click', () => send({ type: ClientMessage.END_GAME }));
    if (els.btnNextRound) els.btnNextRound.addEventListener('click', () => send({ type: ClientMessage.START_ROUND }));
    if (els.btnReturnLobby) els.btnReturnLobby.addEventListener('click', () => send({ type: ClientMessage.RETURN_TO_LOBBY }));
    if (els.btnPlayAgain) els.btnPlayAgain.addEventListener('click', () => send({ type: ClientMessage.PLAY_AGAIN }));
    if (els.btnNextChallenge)    els.btnNextChallenge.addEventListener('click', () => send({ type: ClientMessage.START_ROUND }));
    if (els.btnEndChallengeGame) els.btnEndChallengeGame.addEventListener('click', () => send({ type: ClientMessage.END_GAME }));
    if (els.qeCountdown) {
      const skipQuestion = () => { if (isHost) send({ type: ClientMessage.SKIP_TO_NEXT }); };
      els.qeCountdown.addEventListener('click', skipQuestion);
      els.qeCountdown.addEventListener('touchstart', skipQuestion, { passive: true });
    }
    if (els.geCountdown) {
      const skipGuess = () => { if (isHost) send({ type: ClientMessage.SKIP_TO_NEXT }); };
      els.geCountdown.addEventListener('click', skipGuess);
      els.geCountdown.addEventListener('touchstart', skipGuess, { passive: true });
    }
    if (els.btnSkipGuess) {
      els.btnSkipGuess.addEventListener('click', () => send({ type: ClientMessage.SKIP_TO_NEXT }));
    }

    // Eager globe initialisation
    try {
      const globeCanvas = document.getElementById('globe-3d');
      globe = createGlobe(globeCanvas);

      globeLoadPromise = globe.load('/data/countries-110m.json', '/data/micro-countries.json').then(() => {
        globeReady = true;
        globe.startLobbyDemo(currentMode || 'highlight');
      }).catch(e => {
        console.error('[Geo] Globe data load failed:', e);
        globeReady = false;
      });
    } catch (e) {
      console.error('[Geo] Globe init failed:', e);
      globeLoadPromise = Promise.resolve();
    }

    connect();

    fetch('/api/countries')
      .then(r => r.json())
      .then(list => { window.__gameCountries = list; })
      .catch(() => { console.warn('[spy] Failed to load country list — spy wheel will be empty'); });

    // If there's a room ID in the URL, show join screen directly
    if (urlRoomId) {
      showScreen(Screen.JOIN);
    } else {
      showScreen(Screen.LANDING);
    }

    console.log('[Geo] init complete');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
