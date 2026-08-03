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

let isHost = false;
let playerReady = false;
let state = { videoId: '', time: 0, duration: 0, playing: false, updatedAt: Date.now() };
let suppressBroadcastUntil = 0;
let seekingLocally = false;
let activeRoomCode = '';
let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let lastMessageAt = 0;
let intentionalClose = false;
const clientId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/-/g, '');

// Публичный ретранслятор сообщений. Комната использует случайный topic.
const RELAY_BASE = 'https://ntfy.sh';
const RELAY_WS = 'wss://ntfy.sh';

function randomRoom() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = 'KINO-';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
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
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
}
function topicFor(roomCode) { return `rutube-vmeste-v3-${roomCode.toLowerCase().replace(/[^a-z0-9-]/g, '')}`; }
function showError(message) { els.setupError.textContent = message; }
function setBadge(kind, text) {
  els.connectionBadge.className = `badge ${kind}`;
  els.connectionBadge.textContent = text;
}
function enterRoom(roomCode) {
  els.setup.classList.add('hidden');
  els.room.classList.remove('hidden');
  els.roomLabel.textContent = roomCode;
  els.roleText.textContent = isHost ? 'Ты создал комнату. Управлять просмотром можете оба.' : 'Ты подключился к комнате. Управлять просмотром можете оба.';
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

async function publish(payload) {
  if (!activeRoomCode || intentionalClose) return;
  const envelope = { ...payload, sender: clientId, room: activeRoomCode, sentAt: Date.now() };
  try {
    const response = await fetch(`${RELAY_BASE}/${encodeURIComponent(topicFor(activeRoomCode))}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(envelope),
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    setBadge('waiting', 'Восстановление связи…');
    scheduleReconnect(900);
  }
}

function broadcastState(action) {
  state.updatedAt = Date.now();
  publish({ kind: 'state', action, state: { ...state } });
}

function applyRemoteState(remote, action = 'sync') {
  if (!remote?.videoId) return;
  if (!state.videoId) loadPlayer(remote.videoId);
  if (remote.videoId !== state.videoId) return;
  suppressBroadcastUntil = Date.now() + 1400;
  const lag = remote.playing ? Math.max(0, (Date.now() - Number(remote.updatedAt || Date.now())) / 1000) : 0;
  const targetTime = Math.max(0, Number(remote.time || 0) + lag);
  state = { ...state, ...remote, time: targetTime };
  updateTimeline();
  if (!playerReady) return;
  if (action === 'seek' || action === 'hello' || Math.abs(Number(els.seek.value) - targetTime) > 2.5) {
    playerCommand('player:setCurrentTime', { time: targetTime });
  }
  playerCommand(remote.playing ? 'player:play' : 'player:pause');
  updatePlayButton();
}

function handleRelayEvent(raw) {
  let event;
  try { event = JSON.parse(raw); } catch { return; }
  if (event.event === 'open') {
    lastMessageAt = Date.now();
    setBadge('online', 'Соединение есть');
    publish({ kind: 'request-state' });
    if (isHost) publish({ kind: 'hello', state: { ...state } });
    return;
  }
  if (event.event !== 'message' || !event.message) return;
  let message;
  try { message = JSON.parse(event.message); } catch { return; }
  if (!message || message.sender === clientId || message.room !== activeRoomCode) return;
  lastMessageAt = Date.now();
  setBadge('online', 'Вдвоём');
  if (message.kind === 'request-state' && state.videoId) publish({ kind: 'hello', state: { ...state } });
  if (message.kind === 'hello') applyRemoteState(message.state, 'hello');
  if (message.kind === 'state') applyRemoteState(message.state, message.action);
  if (message.kind === 'presence') publish({ kind: 'presence-reply' });
  if (message.kind === 'presence-reply') setBadge('online', 'Вдвоём');
}

function closeSocket() {
  if (socket) {
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    try { socket.close(); } catch {}
  }
  socket = null;
}
function scheduleReconnect(delay = 1200) {
  if (intentionalClose || reconnectTimer || !activeRoomCode) return;
  setBadge('waiting', 'Переподключение…');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectRelay();
  }, delay);
}
function connectRelay() {
  if (!activeRoomCode || intentionalClose) return;
  closeSocket();
  setBadge('waiting', 'Подключение…');
  const topic = encodeURIComponent(topicFor(activeRoomCode));
  try { socket = new WebSocket(`${RELAY_WS}/${topic}/ws?since=all`); }
  catch { scheduleReconnect(1500); return; }
  socket.onmessage = (event) => handleRelayEvent(event.data);
  socket.onerror = () => setBadge('waiting', 'Восстановление связи…');
  socket.onclose = () => { if (!intentionalClose) scheduleReconnect(900); };
}

function createRoom() {
  const videoId = extractRutubeId(els.videoUrl.value);
  if (!videoId) return showError('Не удалось распознать ссылку Rutube. Скопируй полную ссылку на страницу видео.');
  showError('');
  isHost = true;
  activeRoomCode = randomRoom();
  state.videoId = videoId;
  enterRoom(activeRoomCode);
  loadPlayer(videoId);
  els.inviteLink.value = buildInvite(activeRoomCode, videoId);
  setBadge('waiting', 'Создаём комнату…');
  connectRelay();
}
function joinRoom(roomCode, videoId = '') {
  const clean = cleanRoomCode(roomCode);
  if (!clean) return showError('Введи код комнаты или открой приглашение.');
  showError('');
  isHost = false;
  activeRoomCode = clean;
  enterRoom(clean);
  els.shareCard.classList.add('hidden');
  if (videoId) loadPlayer(videoId);
  setBadge('waiting', 'Подключение…');
  connectRelay();
}

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(value / 3600), m = Math.floor((value % 3600) / 60), s = value % 60;
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
  suppressBroadcastUntil = Date.now() + 500;
  playerCommand(command, data);
  updatePlayButton(); updateTimeline(); broadcastState(action);
}

els.createBtn.addEventListener('click', createRoom);
els.joinBtn.addEventListener('click', () => joinRoom(els.roomCode.value));
els.copyBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(els.inviteLink.value);
  els.copyBtn.textContent = 'Скопировано'; setTimeout(() => els.copyBtn.textContent = 'Копировать', 1500);
});
els.shareBtn.addEventListener('click', async () => {
  const data = { title: 'RUTUBE Вместе', text: 'Подключайся к совместному просмотру', url: els.inviteLink.value };
  if (navigator.share) await navigator.share(data); else await navigator.clipboard.writeText(els.inviteLink.value);
});
els.playPauseBtn.addEventListener('click', () => {
  const playing = !state.playing;
  localAction(playing ? 'play' : 'pause', { playing }, playing ? 'player:play' : 'player:pause');
});
els.backBtn.addEventListener('click', () => {
  const time = Math.max(0, state.time - 10); localAction('seek', { time }, 'player:setCurrentTime', { time });
});
els.forwardBtn.addEventListener('click', () => {
  const time = Math.min(state.duration || Infinity, state.time + 10); localAction('seek', { time }, 'player:setCurrentTime', { time });
});
els.seek.addEventListener('input', () => { seekingLocally = true; els.currentTime.textContent = formatTime(els.seek.value); });
els.seek.addEventListener('change', () => {
  seekingLocally = false; const time = Number(els.seek.value); localAction('seek', { time }, 'player:setCurrentTime', { time });
});

window.addEventListener('message', (event) => {
  if (event.origin !== 'https://rutube.ru') return;
  let message; try { message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
  if (!message?.type) return;
  if (message.type === 'player:ready') {
    playerReady = true; playerCommand('player:showControls'); publish({ kind: 'request-state' });
  }
  if (message.type === 'player:durationChange') state.duration = Number(message.data?.duration || 0);
  if (message.type === 'player:currentTime') state.time = Number(message.data?.time ?? message.data?.currentTime ?? state.time);
  if (message.type === 'player:changeState') {
    const s = message.data?.state;
    if (s === 'playing') state.playing = true;
    if (['pause','paused','completed','stopped'].includes(s)) state.playing = false;
    updatePlayButton();
    if (Date.now() > suppressBroadcastUntil && ['playing','pause','paused'].includes(s)) broadcastState(state.playing ? 'play' : 'pause');
  }
  updateTimeline();
});

heartbeatTimer = setInterval(() => {
  if (!activeRoomCode) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) scheduleReconnect(100);
  else {
    publish({ kind: 'presence' });
    if (state.playing) broadcastState('heartbeat');
    if (Date.now() - lastMessageAt > 20000) setBadge('online', 'Соединение есть');
  }
}, 5000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && activeRoomCode) {
    if (!socket || socket.readyState !== WebSocket.OPEN) connectRelay();
    else publish({ kind: 'request-state' });
  }
});
window.addEventListener('online', () => { if (activeRoomCode) connectRelay(); });
window.addEventListener('beforeunload', () => {
  intentionalClose = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  closeSocket();
});

(function bootFromHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const room = params.get('join'), video = params.get('video');
  if (room) joinRoom(room, video || '');
})();
