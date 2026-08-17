'use strict';
/* ═══════════════════════════════════════════════════════════
   Solidarity in Action — Client Application
   All DOM access is deferred until DOMContentLoaded
═══════════════════════════════════════════════════════════ */

/* ── State (no DOM access here) ── */
let socket       = null;
let rtcManager   = null;
let localStream  = null;
let mySocketId   = null;
let myRole       = 'student';
let myName       = '';
let roomCode     = '';
let micOn        = true;
let camOn        = true;
let handRaised   = false;
let boardMode    = 'draw';
let tool         = 'pen';
let penColor     = '#1a1a2e';
let brushSize    = 3;
let drawing      = false;
let sx = 0, sy = 0;
let paths        = [];
let currentPath  = null;
let typeBlocks   = [];
let activeBlock  = null;
let fontFamily   = 'Roboto, sans-serif';
let fontSize     = 20;
let fmtBold=false, fmtItalic=false, fmtUnderline=false;
let audioCtx     = null;
let analyserNode = null;
let micTimer     = null;
let selfTileEl   = null;
let selfVideoEl  = null;
let ndiOn        = false;
let settingsOpen = false;
let brHistory=[], brHistIdx=-1, brCurrentUrl='';

/* Canvas refs — set after DOM ready */
let canvas = null;
let ctx    = null;

const participants = new Map();
const COLORS = ['#3c4043','#8ab4f8','#81c995','#f28b82','#fdd663',
                '#c58af9','#ff8a00','#4db6ac','#ef9a9a','#ce93d8'];

const BLOCKED_HOSTS = ['google.com','youtube.com','facebook.com','twitter.com',
  'instagram.com','linkedin.com','amazon.com','netflix.com','reddit.com','tiktok.com'];

/* ─────────────────────────────────────────────
   DOM READY — init canvas + event listeners
───────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  /* Canvas */
  canvas = document.getElementById('board');
  if (canvas) {
    ctx = canvas.getContext('2d');
    canvas.addEventListener('mousedown',  e => onDown(e));
    canvas.addEventListener('mousemove',  e => onMove(e));
    canvas.addEventListener('mouseup',    e => onUp(e));
    canvas.addEventListener('mouseleave', e => onUp(e));
    canvas.addEventListener('touchstart', e => { e.preventDefault(); onDown(e); }, {passive:false});
    canvas.addEventListener('touchmove',  e => { e.preventDefault(); onMove(e); }, {passive:false});
    canvas.addEventListener('touchend',   e => { e.preventDefault(); onUp(e);   }, {passive:false});
  }

  /* Board-container click for type-mode block placement */
  const bc = document.getElementById('board-container');
  if (bc) {
    bc.addEventListener('click', e => {
      if (boardMode !== 'type' || myRole !== 'teacher') return;
      if (e.target.closest('.type-block')) return;
      const r = bc.getBoundingClientRect();
      placeTypeBlock(e.clientX - r.left, e.clientY - r.top);
    });
  }

  /* Keyboard shortcuts */
  document.addEventListener('keydown', e => {
    if (myRole !== 'teacher') return;
    const tag = document.activeElement.tagName.toLowerCase();
    const ce  = document.activeElement.contentEditable === 'true';
    if (tag==='input'||tag==='textarea'||tag==='select'||ce) return;
    if (e.key==='d'||e.key==='D') { e.preventDefault(); switchMode('draw'); toast('✏️ Drawing Mode'); }
    if (e.key==='t'||e.key==='T') { e.preventDefault(); switchMode('type'); toast('⌨️ Typing Mode'); }
    if (e.key==='Escape' && boardMode==='type') switchMode('draw');
  });

  /* Window resize */
  window.addEventListener('resize', resizeCanvas);

  /* Chat enter key */
  const chatBox = document.getElementById('chat-box');
  if (chatBox) {
    chatBox.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
    });
  }

  /* Settings overlay backdrop */
  const so = document.getElementById('settings-overlay');
  if (so) so.addEventListener('click', closeSettings);

  console.log('Solidarity in Action — DOM ready ✓');
});

/* ─────────────────────────────────────────────
   JOIN
───────────────────────────────────────────── */
async function joinSession() {
  const nameEl = document.getElementById('jname');
  const codeEl = document.getElementById('jcode');
  const roleEl = document.getElementById('jrole');
  const btn    = document.getElementById('join-btn');

  myName   = nameEl ? nameEl.value.trim() : '';
  roomCode = codeEl ? codeEl.value.trim() : '';
  myRole   = roleEl ? roleEl.value        : 'student';

  if (!myName)   { alert('Please enter your name.');      return; }
  if (!roomCode) { alert('Please enter a session code.'); return; }

  if (btn) btn.textContent = 'Connecting…';

  /* Get camera + mic (non-blocking — join anyway even if denied) */
  await startLocalMedia();

  /* Connect to signalling server */
  socket = io({ transports: ['websocket','polling'] });
  bindSocketEvents();

  socket.on('connect', () => {
    mySocketId = socket.id;
    socket.emit('join-room', { roomCode, name: myName, role: myRole });
  });

  socket.on('connect_error', err => {
    if (btn) btn.textContent = 'Join now';
    alert('Cannot connect to server: ' + err.message);
  });
}

/* ─────────────────────────────────────────────
   CAMERA + MIC
───────────────────────────────────────────── */
async function startLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width:{ideal:1280}, height:{ideal:720}, facingMode:'user' },
      audio: { echoCancellation:true, noiseSuppression:true }
    });
    hideDeniedBanner();
  } catch(err) {
    console.warn('getUserMedia:', err.name, '—', err.message);
    showDeniedBanner();
    localStream = null;
  }
}

function showDeniedBanner() {
  const el = document.getElementById('media-denied');
  if (el) el.classList.add('show');
}
function hideDeniedBanner() {
  const el = document.getElementById('media-denied');
  if (el) el.classList.remove('show');
}
async function retryMedia() {
  hideDeniedBanner();
  await startLocalMedia();
  if (localStream) {
    if (rtcManager) rtcManager.updateStream(localStream);
    attachSelfVideo();
    startMicLevel();
  }
}

function attachSelfVideo() {
  if (!selfVideoEl || !localStream) return;
  selfVideoEl.srcObject = localStream;
  selfVideoEl.muted = true;
  selfVideoEl.play().catch(() => {});
  const ov = selfTileEl && selfTileEl.querySelector('.cam-off-overlay');
  if (ov) ov.style.display = 'none';
  selfVideoEl.style.display = 'block';
}

function startMicLevel() {
  if (!localStream) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    audioCtx     = new AC();
    const src    = audioCtx.createMediaStreamSource(localStream);
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 512;
    src.connect(analyserNode);
    const data = new Uint8Array(analyserNode.frequencyBinCount);
    micTimer = setInterval(() => {
      if (!micOn || !selfTileEl) return;
      analyserNode.getByteFrequencyData(data);
      const avg = data.reduce((a,b)=>a+b,0) / data.length;
      selfTileEl.classList.toggle('speaking', avg > 14);
    }, 100);
  } catch(e) { console.warn('AudioContext:', e); }
}

function stopLocalMedia() {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  localStream = null;
  if (micTimer) clearInterval(micTimer);
  if (audioCtx) audioCtx.close().catch(() => {});
}

function toggleMic() {
  micOn = !micOn;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micOn);
  updateMicBtn(micOn);
  const icon = selfTileEl && selfTileEl.querySelector('.mic-icon');
  if (icon) icon.textContent = micOn ? '🎙' : '🔇';
  if (socket) socket.emit('state-update', { micOn });
  toast(micOn ? 'Microphone on' : 'Microphone muted');
}

function toggleCam() {
  camOn = !camOn;
  if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = camOn);
  updateCamBtn(camOn);
  if (selfVideoEl) selfVideoEl.style.display = camOn ? 'block' : 'none';
  const ov   = selfTileEl && selfTileEl.querySelector('.cam-off-overlay');
  const icon = selfTileEl && selfTileEl.querySelector('.cam-icon');
  if (ov)   ov.style.display   = camOn ? 'none' : 'flex';
  if (icon) icon.textContent   = camOn ? '📷'   : '🚫';
  if (socket) socket.emit('state-update', { camOn });
  toast(camOn ? 'Camera on' : 'Camera off');
}

function updateMicBtn(on) {
  const b = document.getElementById('btn-mic');
  if (b) { b.classList.toggle('muted', !on); b.textContent = on ? '🎙' : '🔇'; }
}
function updateCamBtn(on) {
  const b = document.getElementById('btn-cam');
  if (b) { b.classList.toggle('muted', !on); b.textContent = on ? '📷' : '🚫'; }
}

/* ─────────────────────────────────────────────
   SOCKET EVENTS
───────────────────────────────────────────── */
function bindSocketEvents() {

  socket.on('joined', async ({ participant, participants: list, whiteboard, chat }) => {
    myRole     = participant.role;
    mySocketId = socket.id;

    /* Hide join screen, show app */
    const js = document.getElementById('join-screen');
    if (js) js.style.display = 'none';
    const nc = document.getElementById('nav-code');
    if (nc) nc.textContent = roomCode;
    const pc = document.getElementById('pcount');
    if (pc) pc.textContent = list.length;

    /* Build UI for this role */
    initUI();

    /* Build video tile grid */
    buildAllTiles(list);

    /* Replay whiteboard */
    for (const stroke of whiteboard) replayStroke(stroke);

    /* Replay chat */
    for (const msg of chat) renderChatMsg(msg);

    /* Start WebRTC mesh */
    rtcManager = new WebRTCManager(socket, localStream, onRemoteStream, onRemoteDisconnect);
    await rtcManager.loadIceConfig();
    await rtcManager.connectToAll(list, mySocketId);

    /* Attach own live video */
    attachSelfVideo();
    startMicLevel();

    toast(`Welcome, ${myName}! Joined as ${myRole === 'teacher' ? 'Teacher 👩‍🏫' : 'Student 👤'}`);
  });

  socket.on('join-error', ({ reason }) => {
    const btn = document.getElementById('join-btn');
    if (btn) btn.textContent = 'Join now';
    alert('Could not join: ' + reason);
    socket.disconnect();
    socket = null;
  });

  socket.on('role-downgraded', ({ reason }) => toast('ℹ️ ' + reason));

  socket.on('participant-joined', async ({ participant }) => {
    participants.set(participant.socketId, { ...participant, tileEl:null, videoEl:null });
    addTile(participant);
    updateCount();
    if (rtcManager) await rtcManager.createPeer(participant.socketId, true);
    addSystemMsg(`${participant.name} joined`);
  });

  socket.on('participant-left', ({ socketId }) => {
    const p = participants.get(socketId);
    if (p && p.tileEl) p.tileEl.remove();
    participants.delete(socketId);
    if (rtcManager) rtcManager._removePeer(socketId);
    updateCount();
    if (p) addSystemMsg(`${p.name} left`);
  });

  socket.on('participant-state', ({ socketId, micOn: m, camOn: c, handRaised: h }) => {
    const p = participants.get(socketId);
    if (!p) return;
    if (m !== undefined) p.micOn      = m;
    if (c !== undefined) p.camOn      = c;
    if (h !== undefined) p.handRaised = h;
    updateTileState(p);
  });

  socket.on('wb-stroke', stroke => replayStroke(stroke));
  socket.on('wb-text',   block  => replayTextBlock(block));
  socket.on('wb-clear',  ()     => { paths=[]; if(ctx&&canvas) ctx.clearRect(0,0,canvas.width,canvas.height); });
  socket.on('wb-undo',   ()     => { paths.pop(); redraw(); });

  socket.on('chat-msg', msg => renderChatMsg(msg));

  socket.on('mute-all', () => {
    micOn = false;
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);
    updateMicBtn(false);
    toast('🔇 Teacher muted everyone');
  });

  socket.on('lower-all-hands', () => {
    handRaised = false;
    const b = document.getElementById('btn-hand');
    if (b) b.classList.remove('active-btn');
    toast('✋ Teacher lowered all hands');
  });

  socket.on('kicked', ({ reason }) => { alert(reason); leaveSession(); });
  socket.on('teacher-left', () => toast('⚠️ The teacher has left the session'));

  socket.on('poll-launched', ({ question, options }) => {
    toast(`📊 Poll: ${question}`);
  });
  socket.on('poll-tally',  ({ tally, total }) => updatePollTally(tally, total));
  socket.on('poll-closed', () => {
    const p = document.getElementById('poll-panel');
    if (p) p.classList.remove('open');
  });

  socket.on('link-generated', data => handleNewLink(data));
  socket.on('link-revoked',   ({ token }) => toast('🚫 Link revoked'));
}

/* ─────────────────────────────────────────────
   REMOTE STREAMS (WebRTC callbacks)
───────────────────────────────────────────── */
function onRemoteStream(socketId, stream) {
  const p = participants.get(socketId);
  if (!p || !p.tileEl) return;
  let video = p.tileEl.querySelector('video.remote-video');
  if (!video) {
    video = document.createElement('video');
    video.autoplay    = true;
    video.playsInline = true;
    video.className   = 'remote-video';
    video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:8px;z-index:2';
    p.tileEl.appendChild(video);
  }
  video.srcObject = stream;
  video.play().catch(() => {});
  p.videoEl = video;
  const ov = p.tileEl.querySelector('.cam-off-overlay');
  if (ov) ov.style.display = 'none';
}

function onRemoteDisconnect(socketId) {
  const p = participants.get(socketId);
  if (!p || !p.tileEl) return;
  const video = p.tileEl.querySelector('video.remote-video');
  if (video) { video.srcObject = null; video.remove(); }
  const ov = p.tileEl.querySelector('.cam-off-overlay');
  if (ov) ov.style.display = 'flex';
}

/* ─────────────────────────────────────────────
   TILES
───────────────────────────────────────────── */
function buildAllTiles(list) {
  const col = document.getElementById('tiles-col');
  if (!col) return;
  col.innerHTML = '';

  const selfTile = makeSelfTile();
  col.appendChild(selfTile);
  selfTileEl  = selfTile;
  selfVideoEl = selfTile.querySelector('video');

  list.forEach(p => {
    if (p.socketId === mySocketId) return;
    participants.set(p.socketId, { ...p, tileEl:null, videoEl:null });
    addTile(p);
  });
}

function makeSelfTile() {
  const c    = COLORS[0];
  const init = (myName||'Me').split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2);
  const d    = document.createElement('div');
  d.className = 'tile';
  d.id = 'self-tile';

  const vid = document.createElement('video');
  vid.autoplay    = true;
  vid.playsInline = true;
  vid.muted       = true;
  vid.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:8px;transform:scaleX(-1);display:none;z-index:2';

  const overlay = document.createElement('div');
  overlay.className = 'cam-off-overlay';
  overlay.innerHTML = `<div class="tile-avatar" style="background:${c}">${init}</div><div class="tile-name">${escHtml(myName)} (You)</div>`;

  const icons = document.createElement('div');
  icons.className = 'tile-icons';
  icons.innerHTML = '<div class="t-icon mic-icon">🎙</div><div class="t-icon cam-icon">📷</div>';

  d.appendChild(vid);
  d.appendChild(overlay);
  d.appendChild(icons);

  if (myRole === 'teacher') {
    const crown = document.createElement('div');
    crown.style.cssText = 'position:absolute;top:4px;left:4px;font-size:11px;z-index:5';
    crown.textContent = '👑';
    d.appendChild(crown);
  }
  return d;
}

function addTile(p) {
  const col = document.getElementById('tiles-col');
  if (!col) return;
  const idx  = participants.size % COLORS.length;
  const c    = COLORS[idx];
  const init = p.name.split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2);
  const d    = document.createElement('div');
  d.className = 'tile' + (p.handRaised ? ' hand-up' : '');
  d.dataset.socketId = p.socketId;

  const overlay = document.createElement('div');
  overlay.className = 'cam-off-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `<div class="tile-avatar" style="background:${c}">${init}</div><div class="tile-name">${escHtml(p.name)}</div>`;

  const icons = document.createElement('div');
  icons.className = 'tile-icons';
  icons.innerHTML = `<div class="t-icon mic-icon">${p.micOn ? '🎙' : '🔇'}</div><div class="t-icon cam-icon">📷</div>`;

  d.appendChild(overlay);
  d.appendChild(icons);

  if (p.handRaised) {
    const flag = document.createElement('div');
    flag.className = 'hand-flag';
    flag.textContent = '✋';
    d.appendChild(flag);
  }

  if (myRole === 'teacher') {
    const menuBtn = document.createElement('button');
    menuBtn.className = 'tile-menu-btn';
    menuBtn.textContent = '⋯';
    menuBtn.onclick = e => { e.stopPropagation(); showParticipantMenu(p, menuBtn); };
    d.appendChild(menuBtn);
  }

  col.appendChild(d);
  const stored = participants.get(p.socketId) || { ...p };
  stored.tileEl = d;
  participants.set(p.socketId, stored);
}

function updateTileState(p) {
  if (!p.tileEl) return;
  const mic  = p.tileEl.querySelector('.mic-icon');
  const flag = p.tileEl.querySelector('.hand-flag');
  if (mic) mic.textContent = p.micOn ? '🎙' : '🔇';
  p.tileEl.classList.toggle('hand-up', !!p.handRaised);
  if (p.handRaised && !flag) {
    const f = document.createElement('div');
    f.className = 'hand-flag'; f.textContent = '✋';
    p.tileEl.appendChild(f);
  } else if (!p.handRaised && flag) {
    flag.remove();
  }
  if (p.videoEl) {
    p.videoEl.style.display = p.camOn ? 'block' : 'none';
    const ov = p.tileEl.querySelector('.cam-off-overlay');
    if (ov) ov.style.display = p.camOn ? 'none' : 'flex';
  }
}

function updateCount() {
  const el = document.getElementById('pcount');
  if (el) el.textContent = participants.size + 1;
}

function showParticipantMenu(p, btn) {
  const existing = document.getElementById('ptx-menu');
  if (existing) existing.remove();
  const menu = document.createElement('div');
  menu.id = 'ptx-menu';
  menu.style.cssText = 'position:fixed;background:#292b2f;border:1px solid #5f6368;border-radius:10px;padding:6px;z-index:500;min-width:160px';
  const r = btn.getBoundingClientRect();
  menu.style.top  = (r.bottom + 4) + 'px';
  menu.style.left = r.left + 'px';
  [
    { label: p.micOn ? '🔇 Mute' : '🎙 Unmute', fn: () => toast('Participant muted') },
    { label: '✕ Remove from session',            fn: () => { if(confirm(`Remove ${p.name}?`)) socket && socket.emit('teacher-kick', { targetSocketId: p.socketId }); } },
  ].forEach(item => {
    const row = document.createElement('button');
    row.textContent = item.label;
    row.style.cssText = 'display:block;width:100%;padding:8px 12px;border:none;background:transparent;color:#e8eaed;font-size:.78rem;text-align:left;cursor:pointer;border-radius:7px';
    row.onmouseenter = () => row.style.background='#3c4043';
    row.onmouseleave = () => row.style.background='transparent';
    row.onclick = () => { item.fn(); menu.remove(); };
    menu.appendChild(row);
  });
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once:true }), 50);
}

/* ─────────────────────────────────────────────
   WHITEBOARD
───────────────────────────────────────────── */
function resizeCanvas() {
  if (!canvas) return;
  const c = document.getElementById('board-container');
  if (!c) return;
  canvas.width  = c.clientWidth;
  canvas.height = c.clientHeight;
  redraw();
}

function redraw() {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const p of paths) renderPath(p);
}

function renderPath(p) {
  if (!ctx) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (p.type === 'free' || p.type === 'hl') {
    if (!p.pts || p.pts.length < 2) { ctx.restore(); return; }
    ctx.globalAlpha = p.type === 'hl' ? 0.35 : 1;
    ctx.strokeStyle = p.color; ctx.lineWidth = p.size;
    ctx.beginPath(); ctx.moveTo(p.pts[0][0], p.pts[0][1]);
    p.pts.slice(1).forEach(([x,y]) => ctx.lineTo(x, y));
    ctx.stroke();
  } else if (p.type === 'erase') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = p.size * 4;
    ctx.beginPath(); ctx.moveTo(p.pts[0][0], p.pts[0][1]);
    p.pts.slice(1).forEach(([x,y]) => ctx.lineTo(x, y));
    ctx.stroke();
  } else if (p.type === 'rect') {
    ctx.strokeStyle = p.color; ctx.lineWidth = p.size;
    ctx.strokeRect(p.x, p.y, p.w, p.h);
  } else if (p.type === 'circle') {
    ctx.strokeStyle = p.color; ctx.lineWidth = p.size;
    ctx.beginPath();
    ctx.ellipse(p.cx, p.cy, Math.abs(p.rx), Math.abs(p.ry), 0, 0, 2*Math.PI);
    ctx.stroke();
  } else if (p.type === 'arrow') {
    ctx.strokeStyle = p.color; ctx.fillStyle = p.color; ctx.lineWidth = p.size;
    ctx.beginPath(); ctx.moveTo(p.x1, p.y1); ctx.lineTo(p.x2, p.y2); ctx.stroke();
    const a = Math.atan2(p.y2-p.y1, p.x2-p.x1), l = 14+p.size;
    ctx.beginPath(); ctx.moveTo(p.x2, p.y2);
    ctx.lineTo(p.x2-l*Math.cos(a-.42), p.y2-l*Math.sin(a-.42));
    ctx.lineTo(p.x2-l*Math.cos(a+.42), p.y2-l*Math.sin(a+.42));
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function replayStroke(stroke) { paths.push(stroke); renderPath(stroke); }
function replayTextBlock(block) { placeTypeBlock(block.x, block.y, block); }

function getPos(e) {
  if (!canvas) return [0,0];
  const r = canvas.getBoundingClientRect();
  const s = e.touches ? e.touches[0] : e;
  return [s.clientX - r.left, s.clientY - r.top];
}

function onDown(e) {
  if (myRole !== 'teacher' || boardMode === 'type') return;
  const [x, y] = getPos(e);
  sx = x; sy = y; drawing = true;
  if (['pen','hl','eraser'].includes(tool)) {
    currentPath = { type: tool==='eraser'?'erase':tool, color:penColor, size:brushSize, pts:[[x,y]] };
    paths.push(currentPath);
  }
}

function onMove(e) {
  if (!drawing || myRole !== 'teacher' || !ctx) return;
  const [x, y] = getPos(e);
  if (['pen','hl','eraser'].includes(tool)) {
    currentPath.pts.push([x,y]); redraw();
  } else {
    redraw();
    ctx.save(); ctx.lineCap='round'; ctx.lineJoin='round';
    ctx.strokeStyle=penColor; ctx.lineWidth=brushSize;
    if      (tool==='rect')   ctx.strokeRect(sx,sy,x-sx,y-sy);
    else if (tool==='circle') { ctx.beginPath(); ctx.ellipse((sx+x)/2,(sy+y)/2,Math.abs(x-sx)/2,Math.abs(y-sy)/2,0,0,2*Math.PI); ctx.stroke(); }
    else if (tool==='arrow')  {
      ctx.fillStyle=penColor;
      ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(x,y); ctx.stroke();
      const a=Math.atan2(y-sy,x-sx),l=14+brushSize;
      ctx.beginPath(); ctx.moveTo(x,y);
      ctx.lineTo(x-l*Math.cos(a-.42),y-l*Math.sin(a-.42));
      ctx.lineTo(x-l*Math.cos(a+.42),y-l*Math.sin(a+.42));
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
}

function onUp(e) {
  if (!drawing || myRole !== 'teacher') { drawing=false; return; }
  const src = e.changedTouches ? {clientX:e.changedTouches[0].clientX,clientY:e.changedTouches[0].clientY} : e;
  const [x, y] = getPos(src);
  drawing = false;
  let stroke = null;
  if (tool==='rect')   stroke = {type:'rect',  color:penColor,size:brushSize,x:sx,y:sy,w:x-sx,h:y-sy};
  if (tool==='circle') stroke = {type:'circle',color:penColor,size:brushSize,cx:(sx+x)/2,cy:(sy+y)/2,rx:(x-sx)/2,ry:(y-sy)/2};
  if (tool==='arrow')  stroke = {type:'arrow', color:penColor,size:brushSize,x1:sx,y1:sy,x2:x,y2:y};
  if (stroke) { paths.push(stroke); redraw(); socket && socket.emit('wb-stroke', stroke); }
  else if (currentPath) { socket && socket.emit('wb-stroke', currentPath); }
  currentPath = null;
}

function clearBoard() {
  paths = [];
  typeBlocks.forEach(b => b.remove());
  typeBlocks = []; activeBlock = null;
  if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
  socket && socket.emit('wb-clear');
  toast('Board cleared');
}

function undoDraw() {
  if (activeBlock) { removeBlock(activeBlock); return; }
  if (paths.length) { paths.pop(); redraw(); socket && socket.emit('wb-undo'); }
}

function exportPNG() {
  if (!canvas) return;
  const tmp = document.createElement('canvas');
  tmp.width = canvas.width; tmp.height = canvas.height;
  const tc = tmp.getContext('2d');
  tc.fillStyle = '#ffffff'; tc.fillRect(0,0,tmp.width,tmp.height);
  tc.drawImage(canvas,0,0);
  typeBlocks.forEach(block => {
    const cont = block.querySelector('.type-content');
    if (!cont) return;
    const x=parseInt(block.style.left)||0, y=parseInt(block.style.top)||0;
    const fs=parseInt(cont.style.fontSize)||20;
    tc.save();
    tc.font=`${cont.style.fontStyle||'normal'} ${cont.style.fontWeight||'normal'} ${fs}px ${cont.style.fontFamily||'Roboto,sans-serif'}`;
    tc.fillStyle=cont.style.color||'#222';
    (cont.innerText||'').split('\n').forEach((line,i)=>tc.fillText(line,x,y+fs*(i+1)));
    tc.restore();
  });
  const a=document.createElement('a');
  a.download=`sia-board-${Date.now()}.png`;
  a.href=tmp.toDataURL('image/png'); a.click();
  toast('Board saved as PNG');
}

/* ─────────────────────────────────────────────
   MODE SWITCHER
───────────────────────────────────────────── */
function switchMode(mode) {
  boardMode = mode;
  const drawBtn = document.getElementById('mode-draw-btn');
  const typeBtn = document.getElementById('mode-type-btn');
  const drawCtl = document.getElementById('draw-controls');
  const typeCtl = document.getElementById('type-controls');
  const typeBar = document.getElementById('type-mode-bar');
  const bmi     = document.getElementById('board-mode-indicator');
  if (drawBtn) drawBtn.classList.toggle('active', mode==='draw');
  if (typeBtn) typeBtn.classList.toggle('active', mode==='type');
  if (drawCtl) drawCtl.style.display = mode==='draw' ? 'flex' : 'none';
  if (typeCtl) typeCtl.style.display = mode==='type' ? 'flex' : 'none';
  if (typeBar) typeBar.classList.toggle('show', mode==='type');
  if (mode==='draw') {
    if (canvas) { canvas.style.cursor='crosshair'; canvas.style.pointerEvents='all'; }
    const tl = document.getElementById('type-layer');
    if (tl) tl.style.pointerEvents='none';
    if (bmi) {
      const dot = bmi.querySelector('#bmi-dot');
      const lbl = bmi.querySelector('#bmi-label');
      const hnt = bmi.querySelector('#bmi-hint');
      if (dot) dot.style.background='var(--accent)';
      if (lbl) lbl.textContent='✏️ Drawing Mode';
      if (hnt) hnt.textContent='· draw, highlight or add shapes';
    }
    deselectAll();
  } else {
    if (canvas) { canvas.style.cursor='text'; canvas.style.pointerEvents='none'; }
    const tl = document.getElementById('type-layer');
    if (tl) tl.style.pointerEvents='all';
    if (bmi) {
      const dot = bmi.querySelector('#bmi-dot');
      const lbl = bmi.querySelector('#bmi-label');
      const hnt = bmi.querySelector('#bmi-hint');
      if (dot) dot.style.background='#c58af9';
      if (lbl) lbl.textContent='⌨️ Typing Mode';
      if (hnt) hnt.textContent='· click board to place text';
    }
  }
}

/* ─────────────────────────────────────────────
   TYPING BLOCKS
───────────────────────────────────────────── */
function placeTypeBlock(x, y, data) {
  const tl = document.getElementById('type-layer');
  if (!tl) return;
  const block = document.createElement('div');
  block.className = 'type-block selected';
  block.style.left = x + 'px'; block.style.top = y + 'px';

  const drag = document.createElement('span');
  drag.className = 'drag-handle'; drag.textContent = '⠿ move';

  const del = document.createElement('button');
  del.className = 'delete-handle'; del.textContent = '✕';
  del.onclick = e => { e.stopPropagation(); removeBlock(block); };

  const content = document.createElement('div');
  content.className = 'type-content';
  content.contentEditable = myRole === 'teacher' ? 'true' : 'false';
  content.spellcheck = true;

  if (data) {
    content.innerText           = data.text || '';
    content.style.fontFamily    = data.fontFamily || 'Roboto, sans-serif';
    content.style.fontSize      = (data.fontSize||20) + 'px';
    content.style.color         = data.color  || '#1a1a2e';
    content.style.fontWeight    = data.bold   ? 'bold'      : 'normal';
    content.style.fontStyle     = data.italic ? 'italic'    : 'normal';
    content.style.textDecoration= data.underline ? 'underline' : 'none';
  } else {
    content.style.fontFamily    = fontFamily;
    content.style.fontSize      = fontSize + 'px';
    content.style.color         = penColor;
    content.style.fontWeight    = fmtBold      ? 'bold'      : 'normal';
    content.style.fontStyle     = fmtItalic    ? 'italic'    : 'normal';
    content.style.textDecoration= fmtUnderline ? 'underline' : 'none';
  }
  content.style.lineHeight = '1.45'; content.style.minWidth = '40px';

  content.addEventListener('focus', () => { if (!content.innerText.trim()) content.innerText=''; });
  content.addEventListener('blur',  () => {
    if (!content.innerText.trim()) {
      content.innerHTML = '<span style="color:#9aa0a6;pointer-events:none">Start typing…</span>';
    }
    if (myRole==='teacher' && socket && !data) {
      socket.emit('wb-text', {
        x, y, text: content.innerText,
        fontFamily: content.style.fontFamily,
        fontSize: parseInt(content.style.fontSize)||20,
        color: content.style.color,
        bold: content.style.fontWeight==='bold',
        italic: content.style.fontStyle==='italic',
        underline: content.style.textDecoration.includes('underline'),
      });
    }
  });

  content.addEventListener('keydown', e => {
    if (e.key==='Escape') { content.blur(); deselectAll(); switchMode('draw'); }
    if ((e.ctrlKey||e.metaKey) && e.key==='b') { e.preventDefault(); toggleFmt('bold'); }
    if ((e.ctrlKey||e.metaKey) && e.key==='i') { e.preventDefault(); toggleFmt('italic'); }
    if ((e.ctrlKey||e.metaKey) && e.key==='u') { e.preventDefault(); toggleFmt('underline'); }
  });

  content.addEventListener('mousedown', e => e.stopPropagation());
  content.addEventListener('click',     e => { e.stopPropagation(); selectBlock(block); });

  block.appendChild(drag); block.appendChild(del); block.appendChild(content);
  tl.appendChild(block);
  typeBlocks.push(block);
  makeDraggable(block);
  selectBlock(block);
  setTimeout(() => { content.focus(); placeCursorAtEnd(content); }, 30);
}

function applyFontStyle(el) {
  el.style.fontFamily     = fontFamily;
  el.style.fontSize       = fontSize + 'px';
  el.style.color          = penColor;
  el.style.fontWeight     = fmtBold      ? 'bold'      : 'normal';
  el.style.fontStyle      = fmtItalic    ? 'italic'    : 'normal';
  el.style.textDecoration = fmtUnderline ? 'underline' : 'none';
}

function updateFontStyle() {
  const ff = document.getElementById('font-family');
  const fs = document.getElementById('font-size');
  if (ff) fontFamily = ff.value;
  if (fs) fontSize   = parseInt(fs.value) || 20;
  if (activeBlock) {
    const c = activeBlock.querySelector('.type-content');
    if (c) { c.style.fontFamily=fontFamily; c.style.fontSize=fontSize+'px'; }
  }
}

function toggleFmt(fmt) {
  if (fmt==='bold')      { fmtBold      = !fmtBold;      const b=document.getElementById('fmt-bold');      if(b)b.classList.toggle('on',fmtBold); }
  if (fmt==='italic')    { fmtItalic    = !fmtItalic;    const b=document.getElementById('fmt-italic');    if(b)b.classList.toggle('on',fmtItalic); }
  if (fmt==='underline') { fmtUnderline = !fmtUnderline; const b=document.getElementById('fmt-underline'); if(b)b.classList.toggle('on',fmtUnderline); }
  if (activeBlock) {
    const c = activeBlock.querySelector('.type-content');
    if (c) {
      c.style.fontWeight     = fmtBold      ? 'bold'      : 'normal';
      c.style.fontStyle      = fmtItalic    ? 'italic'    : 'normal';
      c.style.textDecoration = fmtUnderline ? 'underline' : 'none';
    }
  }
  try {
    if (fmt==='bold')      document.execCommand('bold');
    if (fmt==='italic')    document.execCommand('italic');
    if (fmt==='underline') document.execCommand('underline');
  } catch(e) {}
}

function setAlign(dir) {
  ['left','center','right'].forEach(d => {
    const b = document.getElementById('fmt-'+d);
    if (b) b.classList.toggle('on', d===dir);
  });
  if (activeBlock) {
    const c = activeBlock.querySelector('.type-content');
    if (c) c.style.textAlign = dir;
  }
}

function selectBlock(block)  { deselectAll(); block.classList.add('selected'); activeBlock=block; }
function deselectAll()       { typeBlocks.forEach(b=>b.classList.remove('selected')); activeBlock=null; }
function removeBlock(block)  { typeBlocks=typeBlocks.filter(b=>b!==block); if(activeBlock===block)activeBlock=null; block.remove(); }
function placeCursorAtEnd(el){ const r=document.createRange(),s=window.getSelection(); r.selectNodeContents(el); r.collapse(false); s.removeAllRanges(); s.addRange(r); }

function makeDraggable(block) {
  let ox=0,oy=0,bx=0,by=0,drag=false;
  block.addEventListener('mousedown', e => {
    if (e.target.classList.contains('type-content')||e.target.classList.contains('delete-handle')) return;
    drag=true; ox=e.clientX; oy=e.clientY;
    bx=parseInt(block.style.left)||0; by=parseInt(block.style.top)||0;
    block.style.cursor='grabbing';
  });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    block.style.left=Math.max(0,bx+e.clientX-ox)+'px';
    block.style.top =Math.max(0,by+e.clientY-oy)+'px';
  });
  document.addEventListener('mouseup', ()=>{ drag=false; block.style.cursor='move'; });
}

/* ─────────────────────────────────────────────
   DRAW TOOLS
───────────────────────────────────────────── */
function setDrawTool(t, el) {
  tool = t;
  document.querySelectorAll('#draw-controls .tb-btn').forEach(b=>b.classList.remove('active'));
  if (el) el.classList.add('active');
  if (canvas) canvas.style.cursor = t==='eraser' ? 'cell' : 'crosshair';
}

function setColor(c, el) {
  penColor = c;
  document.querySelectorAll('.tb-color').forEach(s=>s.classList.remove('on'));
  if (el) el.classList.add('on');
  if (activeBlock) {
    const cont = activeBlock.querySelector('.type-content');
    if (cont) cont.style.color = c;
  }
}

/* ─────────────────────────────────────────────
   CHAT
───────────────────────────────────────────── */
function sendMsg() {
  const box = document.getElementById('chat-box');
  const txt = box ? box.value.trim() : '';
  if (!txt || !socket) return;
  socket.emit('chat-msg', { text: txt });
  if (box) box.value = '';
}

function renderChatMsg(msg) {
  const msgs = document.getElementById('chat-msgs');
  if (!msgs) return;
  const c    = COLORS[Math.abs(hashStr(msg.name||'')) % COLORS.length];
  const init = (msg.name||'?').split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2);
  const t    = new Date(msg.ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  const div  = document.createElement('div');
  div.className = 'msg-row';
  div.innerHTML =
    `<div class="msg-av" style="background:${c}">${init}</div>` +
    `<div class="msg-body">` +
      `<div class="msg-sender${msg.role==='teacher'?' teacher-sender':''}">${escHtml(msg.name||'')}</div>` +
      `<div class="msg-bubble">${escHtml(msg.text||'')}</div>` +
      `<div class="msg-time">${t}</div>` +
    `</div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function addSystemMsg(text) {
  const msgs = document.getElementById('chat-msgs');
  if (!msgs) return;
  const div = document.createElement('div');
  div.style.cssText='text-align:center;font-size:.68rem;color:#5f6368;padding:4px 0';
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function hashStr(str) { let h=0; for(let i=0;i<str.length;i++)h=(h*31+str.charCodeAt(i))|0; return h; }
function escHtml(s)   { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/* ─────────────────────────────────────────────
   TEACHER ACTIONS
───────────────────────────────────────────── */
function muteAll()  { socket && socket.emit('teacher-mute-all');    toast('🔇 All participants muted'); }
function lowerAll() { socket && socket.emit('teacher-lower-hands'); toast('✋ All hands lowered'); }

function raiseHand() {
  handRaised = !handRaised;
  const b = document.getElementById('btn-hand');
  if (b) b.classList.toggle('active-btn', handRaised);
  socket && socket.emit('state-update', { handRaised });
  toast(handRaised ? '✋ Hand raised' : 'Hand lowered');
}

function togglePoll() {
  const p = document.getElementById('poll-panel');
  if (!p) return;
  p.classList.toggle('open');
  if (p.classList.contains('open') && myRole==='teacher') {
    socket && socket.emit('poll-launch', {
      question: 'Do you understand?',
      options: ['Yes ✅','Not yet 🤔','I have a question ✋']
    });
    toast('📊 Poll sent to all students');
  }
}

function updatePollTally(tally, total) {
  ['pb-yes','pb-no','pb-q'].forEach((id,i) => {
    const el = document.getElementById(id);
    if (!el) return;
    const key = Object.keys(tally)[i]||'';
    const pct = total>0 ? Math.round(((tally[key]||0)/total)*100) : 0;
    el.style.width = pct + '%';
  });
}

/* ─────────────────────────────────────────────
   INVITE LINKS
───────────────────────────────────────────── */
function generateLink() {
  if (myRole!=='teacher'||!socket) return;
  const le = document.getElementById('link-expiry');
  const lm = document.getElementById('link-max-uses');
  const ll = document.getElementById('link-label');
  socket.emit('generate-link', {
    label  : ll ? ll.value.trim()||'Class Session' : 'Class Session',
    expiryMs: le ? parseInt(le.value) : 2592000000,
    maxUses : lm ? parseInt(lm.value) : 0,
  });
}

function handleNewLink({ token, url, label, expiryTs, maxUses }) {
  const box = document.getElementById('link-result-box');
  const disp= document.getElementById('link-url-display');
  const exp = document.getElementById('link-meta-expiry');
  const use = document.getElementById('link-meta-uses');
  const lbl = document.getElementById('link-meta-label');
  if (box) box.style.display='';
  if (disp) disp.textContent = url;
  if (exp)  exp.textContent  = `⏱ Expires ${new Date(expiryTs).toLocaleDateString()}`;
  if (use)  use.textContent  = `👥 ${maxUses===0?'Unlimited':maxUses+' max'} uses`;
  if (lbl)  lbl.textContent  = `🏷 ${label}`;
  toast('🔗 Invite link generated');
}

function copyLatestLink() {
  const disp = document.getElementById('link-url-display');
  if (disp) navigator.clipboard.writeText(disp.textContent).then(()=>toast('Link copied!'));
}
function shareLatestLink() {
  const disp = document.getElementById('link-url-display');
  if (!disp) return;
  if (navigator.share) navigator.share({ title:'Join Solidarity in Action', url:disp.textContent }).catch(()=>{});
  else copyLatestLink();
}
function sendLinkToChat() {
  const disp = document.getElementById('link-url-display');
  if (!disp||!socket) return;
  socket.emit('chat-msg', { text:`📎 Class invite: ${disp.textContent}` });
  toast('Link posted to chat');
}

/* ─────────────────────────────────────────────
   PANELS / NAVIGATION
───────────────────────────────────────────── */
function openPanel(tab) {
  const sp = document.getElementById('side-panel');
  const tc = document.getElementById('tiles-col');
  if (sp) sp.classList.add('open');
  if (tc) tc.style.display='none';
  switchPanelTab(tab);
}
function closePanel() {
  const sp = document.getElementById('side-panel');
  const tc = document.getElementById('tiles-col');
  if (sp) sp.classList.remove('open');
  if (tc) tc.style.display='';
}
function switchPanelTab(tab) {
  ['chat','people'].forEach(t => {
    const tb = document.getElementById('ptab-'+t);
    const ct = document.getElementById(t+'-tab');
    if (tb) tb.classList.toggle('on', t===tab);
    if (ct) ct.style.display = t===tab ? 'flex' : 'none';
  });
}

function openSettings(tab) {
  const ov = document.getElementById('settings-overlay');
  const dr = document.getElementById('settings-drawer');
  const bt = document.getElementById('btn-settings');
  if (ov) ov.classList.add('open');
  if (dr) dr.classList.add('open');
  if (bt) bt.classList.add('active-btn');
  openSettingsTab(tab||'general');
}
function closeSettings() {
  const ov = document.getElementById('settings-overlay');
  const dr = document.getElementById('settings-drawer');
  const bt = document.getElementById('btn-settings');
  if (ov) ov.classList.remove('open');
  if (dr) dr.classList.remove('open');
  if (bt) bt.classList.remove('active-btn');
}
function openSettingsTab(tab) {
  document.querySelectorAll('.stab').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.stab-content').forEach(c=>c.classList.remove('active'));
  const tb=document.getElementById('stab-'+tab);
  const ct=document.getElementById('scont-'+tab);
  if (tb) tb.classList.add('active');
  if (ct) ct.classList.add('active');
  const icons  = {general:'⚙️',ndi:'📡',recording:'⏺',links:'🔗',integrations:'🔌',av:'🎙'};
  const titles = {general:'Settings',ndi:'NDI & Streaming',recording:'Recording',links:'Invite Links',integrations:'Integrations',av:'Audio & Video'};
  const iEl = document.getElementById('settings-title-icon');
  const tEl = document.getElementById('settings-title-text');
  if (iEl) iEl.textContent = icons[tab]||'⚙️';
  if (tEl) tEl.textContent = titles[tab]||'Settings';
}
function saveSettings() { toast('Settings saved ✓'); closeSettings(); }
function copySessionCode() { navigator.clipboard.writeText(roomCode).then(()=>toast('Session code copied: '+roomCode)); }

/* ─────────────────────────────────────────────
   NDI (UI stubs)
───────────────────────────────────────────── */
function openNDI()  { openSettings('ndi'); }
function closeNDI() { closeSettings(); }
function startNDI() {
  ndiOn=true;
  const n=(document.getElementById('ndi-name')||{}).value||'SIA-Classroom-1';
  const r=(document.getElementById('ndi-res')||{}).value||'1920×1080';
  const dot=document.getElementById('ndi-live-dot'), lb=document.getElementById('ndi-live-label');
  const sb=document.getElementById('ndi-start-btn'), sp=document.getElementById('ndi-stop-btn');
  if(dot)dot.classList.add('on');
  if(lb)lb.innerHTML=`NDI Output — <b style="color:var(--accent2)">● Streaming</b> · ${n} · ${r}`;
  if(sb)sb.style.display='none'; if(sp)sp.style.display='';
  toast('NDI output started');
}
function stopNDI() {
  ndiOn=false;
  const dot=document.getElementById('ndi-live-dot'), lb=document.getElementById('ndi-live-label');
  const sb=document.getElementById('ndi-start-btn'), sp=document.getElementById('ndi-stop-btn');
  if(dot)dot.classList.remove('on');
  if(lb)lb.textContent='NDI Output — Not streaming';
  if(sb)sb.style.display=''; if(sp)sp.style.display='none';
  toast('NDI output stopped');
}

/* ─────────────────────────────────────────────
   LEAVE
───────────────────────────────────────────── */
function leaveConfirm() { if (confirm('Leave this session?')) leaveSession(); }
function leaveSession() {
  stopLocalMedia();
  if (rtcManager) rtcManager.closeAll();
  if (socket)     { socket.disconnect(); socket=null; }
  const js=document.getElementById('join-screen');
  if (js) js.style.display='flex';
  clearBoard();
  const cm=document.getElementById('chat-msgs');
  if (cm) cm.innerHTML='';
  participants.clear();
  const tc=document.getElementById('tiles-col');
  if (tc) tc.innerHTML='';
}

/* ─────────────────────────────────────────────
   UI INIT (called after joined)
───────────────────────────────────────────── */
function initUI() {
  if (myRole === 'teacher') {
    const ttb = document.getElementById('teacher-toolbar');
    const tbar= document.getElementById('teacher-bar');
    if (ttb) ttb.classList.add('visible');
    if (tbar) tbar.classList.add('visible');
    ['poll-wrap','muteall-wrap','lower-wrap','rec-bar-wrap'].forEach(id => {
      const el=document.getElementById(id); if(el)el.style.display='';
    });
    const bTop=document.getElementById('btn-browse-top');
    if(bTop)bTop.style.display='flex';
    const tsc=document.getElementById('teacher-session-controls');
    if(tsc)tsc.style.display='';
    switchMode('draw');
  } else {
    const ttb=document.getElementById('teacher-toolbar');
    if(ttb)ttb.style.display='none';
    if(canvas){canvas.style.cursor='not-allowed'; canvas.title='Only the teacher can draw on the board';}
  }
  resizeCanvas();
}

/* ─────────────────────────────────────────────
   MISC
───────────────────────────────────────────── */
function toggleBoard() {
  const bc=document.getElementById('board-container');
  if(bc) bc.style.display=bc.style.display==='none'?'':'none';
}

function quickRecord()    { openSettings('recording'); }
function startRecording() { toast('Open Settings → Recording'); }
function pauseRecording() {}
function stopRecording()  {}

/* ─────────────────────────────────────────────
   BROWSER PANEL
───────────────────────────────────────────── */
function openBrowser() {
  if (myRole!=='teacher') return;
  const bp=document.getElementById('browser-panel');
  const ttb=document.getElementById('teacher-toolbar');
  const bmi=document.getElementById('board-mode-indicator');
  if(bp)bp.classList.add('open');
  if(ttb)ttb.style.display='none';
  if(bmi)bmi.style.display='none';
  if(!window._brLoaded){brLoad('https://www.wikipedia.org');window._brLoaded=true;}
  toast('Browser opened');
}
function closeBrowser() {
  const bp=document.getElementById('browser-panel');
  const ttb=document.getElementById('teacher-toolbar');
  const bmi=document.getElementById('board-mode-indicator');
  if(bp)bp.classList.remove('open');
  if(ttb)ttb.style.display='';
  if(bmi)bmi.style.display='';
  toast('Browser closed');
}
function brNavigate(){const el=document.getElementById('browser-url');if(!el)return;let r=el.value.trim();if(!r)return;let u=r;if(!/^https?:\/\//i.test(u)){if(/^[\w-]+\.[a-z]{2,}/.test(u))u='https://'+u;else u='https://www.google.com/search?q='+encodeURIComponent(r);}brLoad(u);}
function brLoad(url){brCurrentUrl=url;const el=document.getElementById('browser-url');if(el)el.value=url;brHistory=brHistory.slice(0,brHistIdx+1);brHistory.push(url);brHistIdx=brHistory.length-1;updateNavBtns();const blocked=BLOCKED_HOSTS.some(h=>url.includes(h));const loading=document.getElementById('browser-loading');const blockedEl=document.getElementById('browser-blocked');const iframe=document.getElementById('browser-iframe');if(blockedEl)blockedEl.classList.remove('show');if(iframe)iframe.style.display='block';if(blocked){if(iframe)iframe.style.display='none';if(loading)loading.classList.remove('show');try{const bn=document.getElementById('blocked-site-name');if(bn)bn.textContent=new URL(url).hostname;const oe=document.getElementById('open-ext-btn');if(oe)oe.dataset.href=url;}catch(e){}if(blockedEl)blockedEl.classList.add('show');return;}if(loading)loading.classList.add('show');try{const lt=document.getElementById('browser-loading-txt');if(lt)lt.textContent='Loading '+new URL(url).hostname+'…';}catch(e){}if(iframe){iframe.src='about:blank';setTimeout(()=>{iframe.src=url;iframe.onload=()=>{if(loading)loading.classList.remove('show');};iframe.onerror=()=>{if(loading)loading.classList.remove('show');if(iframe)iframe.style.display='none';if(blockedEl)blockedEl.classList.add('show');};},100);}}
function brBack(){if(brHistIdx>0){brHistIdx--;brCurrentUrl=brHistory[brHistIdx];const el=document.getElementById('browser-url');if(el)el.value=brCurrentUrl;updateNavBtns();const f=document.getElementById('browser-iframe');if(f)f.src=brCurrentUrl;}}
function brForward(){if(brHistIdx<brHistory.length-1){brHistIdx++;brCurrentUrl=brHistory[brHistIdx];const el=document.getElementById('browser-url');if(el)el.value=brCurrentUrl;updateNavBtns();const f=document.getElementById('browser-iframe');if(f)f.src=brCurrentUrl;}}
function brReload(){if(brCurrentUrl)brLoad(brCurrentUrl);}
function updateNavBtns(){const b=document.getElementById('br-back');const f=document.getElementById('br-fwd');if(b)b.disabled=brHistIdx<=0;if(f)f.disabled=brHistIdx>=brHistory.length-1;}
function openExternal(){const btn=document.getElementById('open-ext-btn');const url=(btn&&btn.dataset.href)||brCurrentUrl;if(url)window.open(url,'_blank','noopener');}

/* ─────────────────────────────────────────────
   TOAST
───────────────────────────────────────────── */
let _tt;
function toast(msg) {
  const el=document.getElementById('toast');
  if(!el)return;
  el.textContent=msg; el.classList.add('show');
  clearTimeout(_tt); _tt=setTimeout(()=>el.classList.remove('show'),3200);
}
