'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  setup: $('setup'), room: $('room'), videoUrl: $('videoUrl'), roomCode: $('roomCode'),
  createBtn: $('createBtn'), joinBtn: $('joinBtn'), setupError: $('setupError'),
  roomLabel: $('roomLabel'), connectionBadge: $('connectionBadge'), shareCard: $('shareCard'),
  inviteLink: $('inviteLink'), copyBtn: $('copyBtn'), shareBtn: $('shareBtn'),
  player: $('rutubePlayer'), playPauseBtn: $('playPauseBtn'), backBtn: $('backBtn'),
  forwardBtn: $('forwardBtn'), seek: $('seek'), currentTime: $('currentTime'),
  duration: $('duration'), roleText: $('roleText')
};

let peer = null;
let conn = null;
let isHost = false;
let playerReady = false;
let state = { videoId: '', time: 0, duration: 0, playing: false, updatedAt: Date.now() };
let suppressBroadcastUntil = 0;
let seekingLocally = false;
let activeRoomCode = '';
let reconnectTimer = null;
let peerReconnectTimer = null;
let lastPeerMessageAt = 0;
let intentionalClose = false;

const PEER_OPTIONS = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ]
  }
};

function randomRoom() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = 'KINO-';
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function extractRutubeId(value) {
  const text = String(value || '').trim();
  const patterns = [
    /rutube\.ru\/video\/([a-f0-9]{32})/i,
    /rutube\.ru\/play\/embed\/([a-f0-9]{32})/i,
    /rutube\.ru\/video\/([\w-]+)/i,
    /rutube\.ru\/play\/embed\/([\w-]+)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return '';
}

function cleanRoomCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);
}

function showError(message) { els.setupError.textContent = message; }

function setBadge(kind, text) {
  els.connectionBadge.className = `badge ${kind}`;
  els.connectionBadge.textContent = text;
}

function enterRoom(roomCode) {
  els.setup.classList.add('hidden');
  els.room.classList.remove('hidden');
  els.roomLabel.textContent = roomCode;
  els.roleText.textContent = isHost ? 'Ты создал комнату и управляешь просмотром.' : 'Ты подключился к комнате. Управлять просмотром можете оба.';
}

function buildInvite(roomCode, videoId) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = `join=${encodeURIComponent(roomCode)}&video=${encodeURIComponent(videoId)}`;
  return url.toString();
}

function loadPlayer(videoId) {
  state.videoId = videoId;
  playerReady = false;
  els.player.src = `https://rutube.ru/play/embed/${encodeURIComponent(videoId)}/?autoplay=false`;
}

function playerCommand(type, data = {}) {
  if (!els.player.contentWindow) return;
  els.player.contentWindow.postMessage(JSON.stringify({ type, data }), 'https://rutube.ru');
}

function broadcast(message) {
  if (conn && conn.open) conn.send(message);
}

function broadcastState(action) {
  state.updatedAt = Date.now();
  broadcast({ kind: 'state', action, state: { ...state } });
}

function applyRemoteState(remote, action = 'sync') {
  if (!remote || remote.videoId !== state.videoId) return;
  suppressBroadcastUntil = Date.now() + 1200;
  const networkLag = remote.playing ? Math.max(0, (Date.now() - remote.updatedAt) / 1000) : 0;
  const targetTime = Math.max(0, Number(remote.time || 0) + networkLag);
  state = { ...state, ...remote, time: targetTime };
  updateTimeline();
  if (!playerReady) return;
  if (action === 'seek' || Math.abs(targetTime - Number(els.seek.value)) > 2.5) {
    playerCommand('player:setCurrentTime', { time: targetTime });
  }
  playerCommand(remote.playing ? 'player:play' : 'player:pause');
  updatePlayButton();
}

function clearReconnectTimers() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (peerReconnectTimer) clearTimeout(peerReconnectTimer);
  reconnectTimer = null;
  peerReconnectTimer = null;
}

function scheduleGuestReconnect(delay = 1500) {
  if (isHost || intentionalClose || !activeRoomCode) return;
  if (reconnectTimer) return;
  setBadge('waiting', 'Переподключение…');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!peer || peer.destroyed) {
      startGuestPeer();
      return;
    }
    if (peer.disconnected) {
      try { peer.reconnect(); } catch { startGuestPeer(); return; }
    }
    if (!conn?.open) connectToHost();
  }, delay);
}

function ensureHostPeerConnected() {
  if (!isHost || intentionalClose || !peer || peer.destroyed || !peer.disconnected) return;
  try {
    setBadge('waiting', 'Восстановление комнаты…');
    peer.reconnect();
  } catch {
    startHostPeer();
  }
}

function attachConnection(connection) {
  if (conn && conn !== connection) {
    try { conn.close(); } catch {}
  }
  conn = connection;

  conn.on('open', () => {
    clearReconnectTimers();
    lastPeerMessageAt = Date.now();
    setBadge('online', 'Вдвоём');
    if (isHost) broadcast({ kind: 'hello', state: { ...state } });
    else broadcast({ kind: 'request-state' });
  });

  conn.on('data', (message) => {
    lastPeerMessageAt = Date.now();
    if (!message || typeof message !== 'object') return;
    if (message.kind === 'ping') {
      broadcast({ kind: 'pong', sentAt: message.sentAt });
      return;
    }
    if (message.kind === 'pong') return;
    if (message.kind === 'request-state' && isHost) broadcast({ kind: 'hello', state: { ...state } });
    if (message.kind === 'hello') {
      if (!state.videoId && message.state?.videoId) loadPlayer(message.state.videoId);
      applyRemoteState(message.state, 'seek');
    }
    if (message.kind === 'state') applyRemoteState(message.state, message.action);
  });

  conn.on('close', () => {
    if (intentionalClose) return;
    setBadge('waiting', isHost ? 'Ждём переподключения' : 'Связь прервалась…');
    if (!isHost) scheduleGuestReconnect(800);
  });

  conn.on('error', () => {
    if (intentionalClose) return;
    setBadge('waiting', 'Восстанавливаем связь…');
    if (!isHost) scheduleGuestReconnect(1000);
  });
}

function configurePeerEvents(instance) {
  instance.on('disconnected', () => {
    if (intentionalClose) return;
    if (isHost) {
      setBadge('waiting', 'Восстановление комнаты…');
      if (!peerReconnectTimer) {
        peerReconnectTimer = setTimeout(() => {
          peerReconnectTimer = null;
          ensureHostPeerConnected();
        }, 1000);
      }
    } else {
      scheduleGuestReconnect(1000);
    }
  });

  instance.on('close', () => {
    if (intentionalClose) return;
    setBadge('waiting', 'Перезапуск соединения…');
    if (isHost) setTimeout(startHostPeer, 1200);
    else scheduleGuestReconnect(1200);
  });
}

function startHostPeer() {
  if (!activeRoomCode || intentionalClose) return;
  try { if (peer && !peer.destroyed) peer.destroy(); } catch {}
  peer = new Peer(activeRoomCode.toLowerCase(), PEER_OPTIONS);
  configurePeerEvents(peer);
  peer.on('open', () => {
    setBadge(conn?.open ? 'online' : 'waiting', conn?.open ? 'Вдвоём' : 'Ждём второго');
  });
  peer.on('connection', (connection) => attachConnection(connection));
  peer.on('error', (error) => {
    if (intentionalClose) return;
    if (error.type === 'unavailable-id') {
      setBadge('waiting', 'Возвращаем комнату…');
      setTimeout(startHostPeer, 1800);
    } else if (error.type === 'network' || error.type === 'server-error' || error.type === 'socket-error') {
      setBadge('waiting', 'Восстановление комнаты…');
      setTimeout(ensureHostPeerConnected, 1200);
    } else {
      setBadge('offline', 'Ошибка комнаты');
    }
  });
}

function connectToHost() {
  if (isHost || intentionalClose || !peer?.open || conn?.open) return;
  const connection = peer.connect(activeRoomCode.toLowerCase(), { reliable: true, serialization: 'json' });
  attachConnection(connection);
  setTimeout(() => {
    if (!connection.open && conn === connection) {
      try { connection.close(); } catch {}
      scheduleGuestReconnect(1200);
    }
  }, 8000);
}

function startGuestPeer() {
  if (isHost || intentionalClose || !activeRoomCode) return;
  try { if (peer && !peer.destroyed) peer.destroy(); } catch {}
  peer = new Peer(undefined, PEER_OPTIONS);
  configurePeerEvents(peer);
  peer.on('open', connectToHost);
  peer.on('error', (error) => {
    if (intentionalClose) return;
    if (error.type === 'peer-unavailable') {
      setBadge('waiting', 'Хозяин переподключается…');
      scheduleGuestReconnect(1800);
    } else if (error.type === 'network' || error.type === 'server-error' || error.type === 'socket-error') {
      setBadge('waiting', 'Восстанавливаем связь…');
      scheduleGuestReconnect(1500);
    } else {
      setBadge('offline', 'Ошибка подключения');
      scheduleGuestReconnect(2500);
    }
  });
}

function createRoom() {
  const videoId = extractRutubeId(els.videoUrl.value);
  if (!videoId) return showError('Не удалось распознать ссылку Rutube. Скопируй полную ссылку на страницу видео.');
  showError('');
  isHost = true;
  const roomCode = randomRoom();
  state.videoId = videoId;
  enterRoom(roomCode);
  loadPlayer(videoId);
  const invite = buildInvite(roomCode, videoId);
  els.inviteLink.value = invite;
  setBadge('waiting', 'Ждём второго');

  activeRoomCode = roomCode;
  startHostPeer();
}

function joinRoom(roomCode, videoId = '') {
  const clean = cleanRoomCode(roomCode);
  if (!clean) return showError('Введи код комнаты или открой приглашение.');
  showError('');
  isHost = false;
  enterRoom(clean);
  els.shareCard.classList.add('hidden');
  if (videoId) loadPlayer(videoId);
  setBadge('waiting', 'Подключение…');

  activeRoomCode = clean;
  startGuestPeer();
}

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}

function updateTimeline() {
  if (!seekingLocally) els.seek.value = String(state.time || 0);
  els.seek.max = String(Math.max(1, state.duration || 1));
  els.currentTime.textContent = formatTime(state.time);
  els.duration.textContent = formatTime(state.duration);
}

function updatePlayButton() { els.playPauseBtn.textContent = state.playing ? '❚❚' : '▶'; }

function localAction(action, patch, command, data = {}) {
  state = { ...state, ...patch };
  suppressBroadcastUntil = Date.now() + 400;
  playerCommand(command, data);
  updatePlayButton();
  updateTimeline();
  broadcastState(action);
}

els.createBtn.addEventListener('click', createRoom);
els.joinBtn.addEventListener('click', () => joinRoom(els.roomCode.value));
els.copyBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(els.inviteLink.value);
  els.copyBtn.textContent = 'Скопировано';
  setTimeout(() => els.copyBtn.textContent = 'Копировать', 1500);
});
els.shareBtn.addEventListener('click', async () => {
  const data = { title: 'RUTUBE Вместе', text: 'Подключайся к совместному просмотру', url: els.inviteLink.value };
  if (navigator.share) await navigator.share(data);
  else await navigator.clipboard.writeText(els.inviteLink.value);
});
els.playPauseBtn.addEventListener('click', () => {
  const playing = !state.playing;
  localAction(playing ? 'play' : 'pause', { playing }, playing ? 'player:play' : 'player:pause');
});
els.backBtn.addEventListener('click', () => {
  const time = Math.max(0, state.time - 10);
  localAction('seek', { time }, 'player:setCurrentTime', { time });
});
els.forwardBtn.addEventListener('click', () => {
  const time = Math.min(state.duration || Infinity, state.time + 10);
  localAction('seek', { time }, 'player:setCurrentTime', { time });
});
els.seek.addEventListener('input', () => {
  seekingLocally = true;
  els.currentTime.textContent = formatTime(els.seek.value);
});
els.seek.addEventListener('change', () => {
  seekingLocally = false;
  const time = Number(els.seek.value);
  localAction('seek', { time }, 'player:setCurrentTime', { time });
});

window.addEventListener('message', (event) => {
  if (event.origin !== 'https://rutube.ru') return;
  let message;
  try { message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
  if (!message?.type) return;
  if (message.type === 'player:ready') {
    playerReady = true;
    playerCommand('player:showControls');
    if (!isHost) broadcast({ kind: 'request-state' });
  }
  if (message.type === 'player:durationChange') state.duration = Number(message.data?.duration || 0);
  if (message.type === 'player:currentTime') state.time = Number(message.data?.time ?? message.data?.currentTime ?? state.time);
  if (message.type === 'player:changeState') {
    const s = message.data?.state;
    if (s === 'playing') state.playing = true;
    if (s === 'pause' || s === 'paused' || s === 'completed' || s === 'stopped') state.playing = false;
    updatePlayButton();
    if (Date.now() > suppressBroadcastUntil && (s === 'playing' || s === 'pause' || s === 'paused')) broadcastState(state.playing ? 'play' : 'pause');
  }
  updateTimeline();
});

setInterval(() => {
  if (conn?.open) {
    broadcast({ kind: 'ping', sentAt: Date.now() });
    if (isHost && state.playing) broadcastState('heartbeat');
  } else if (!isHost && activeRoomCode) {
    scheduleGuestReconnect(500);
  } else if (isHost) {
    ensureHostPeerConnected();
  }
}, 5000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (isHost) ensureHostPeerConnected();
  else if (!conn?.open) scheduleGuestReconnect(200);
  else broadcast({ kind: 'request-state' });
});

window.addEventListener('online', () => {
  if (isHost) ensureHostPeerConnected();
  else scheduleGuestReconnect(200);
});

window.addEventListener('beforeunload', () => {
  intentionalClose = true;
  clearReconnectTimers();
  try { conn?.close(); } catch {}
  try { peer?.destroy(); } catch {}
});

(function bootFromHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const room = params.get('join');
  const video = params.get('video');
  if (room) joinRoom(room, video || '');
})();
