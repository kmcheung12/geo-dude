/**
 * Shared constants for client and server.
 */

/** Messages sent from client (app.js) to server. */
export const ClientMessage = Object.freeze({
  JOIN:            'join',
  PONG:            'pong',
  UPDATE_SETTINGS: 'updateSettings',
  START_ROUND:     'startRound',
  END_GAME:        'endGame',
  RETURN_TO_LOBBY: 'returnToLobby',
  ANSWER:          'answer',
  PLAY_AGAIN:      'playAgain',
  CHANGE_NAME:     'changeName',
  PLACE_PIN:       'placePin',
  LOCK_PIN:        'lockPin',
  SKIP_TO_NEXT:    'skipToNext',
  PICK_COUNTRY:    'pickCountry',
});

/** Messages sent from server to client (app.js). */
export const ServerMessage = Object.freeze({
  ERROR:           'error',
  JOINED:          'joined',
  PING:            'ping',
  HOST_ASSIGNED:   'hostAssigned',
  PLAYERS:         'players',
  SETTINGS:        'settings',
  ROUND_START:     'roundStart',
  QUESTION:        'question',
  TICK:            'tick',
  PLAYER_ANSWERED: 'playerAnswered',
  PIN_UPDATE:      'pinUpdate',
  PIN_LOCKED:      'pinLocked',
  GUESS_END:       'guessEnd',
  CHALLENGE_END:   'challengeEnd',
  QUESTION_END:    'questionEnd',
  ROUND_END:       'roundEnd',
  GAME_END:        'gameEnd',
  LOBBY_RESET:     'lobbyReset',
  ROOM_CLOSED:     'roomClosed',
  RESTORE:         'restore',
  SPY_PICKING:     'spyPicking',
});

/** UI screen names used in showScreen(). */
export const Screen = Object.freeze({
  LANDING: 'landing',
  JOIN:    'join',
  LOBBY:   'lobby',
  GAME:    'game',
});

/** Server-side game state values. */
export const GameState = Object.freeze({
  LOBBY:        'LOBBY',
  SPY_PICKING:  'SPY_PICKING',
  QUESTION:     'QUESTION',
  QUESTION_END: 'QUESTION_END',
  ROUND_END:    'ROUND_END',
  GAME_END:     'GAME_END',
});
