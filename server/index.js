'use strict';
require('dotenv').config();

const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const path         = require('path');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const { v4: uuid } = require('uuid');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  maxHttpBufferSize: 2e6   // 2 MB — for whiteboard stroke batches
});

const PORT = process.env.PORT || 3000;

/* ─────────────────────────────────────────────
   MIDDLEWARE
───────────────────────────────────────────── */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc : ["'self'"],
      scriptSrc  : ["'self'", "'unsafe-inline'"],
      styleSrc   : ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc    : ["'self'", 'https://fonts.gstatic.com'],
      connectSrc : ["'self'", 'wss:', 'ws:'],
      mediaSrc   : ["'self'", 'blob:'],
      imgSrc     : ["'self'", 'data:', 'blob:'],
    }
  }
}));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Rate limiting for API routes
const limiter = rateLimit({ windowMs: 60_000, max: 120 });
app.use('/api', limiter);

/* ─────────────────────────────────────────────
   IN-MEMORY STORE
   In production replace with Redis or a DB
───────────────────────────────────────────── */

/**
 * rooms  : Map<roomCode, Room>
 * Room   : { code, teacherId, participants: Map<socketId, Participant>,
 *            whiteboard: DrawEvent[], chat: ChatMsg[],
 *            inviteLinks: Map<token, InviteLink> }
 *
 * Participant: { id, socketId, name, role, micOn, camOn, handRaised }
 */
const rooms = new Map();

function getOrCreateRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      teacherId   : null,
      participants: new Map(),
      whiteboard  : [],      // full stroke history
      chat        : [],
      inviteLinks : new Map(),
      pollState   : null,
    });
  }
  return rooms.get(code);
}

function roomParticipantList(room) {
  return [...room.participants.values()].map(p => ({
    id        : p.id,
    socketId  : p.socketId,
    name      : p.name,
    role      : p.role,
    micOn     : p.micOn,
    camOn     : p.camOn,
    handRaised: p.handRaised,
  }));
}

/* ─────────────────────────────────────────────
   REST API
───────────────────────────────────────────── */

// ICE config delivered to clients
app.get('/api/ice-config', (_req, res) => {
  const iceServers = [
    { urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' },
  ];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls      : process.env.TURN_URL,
      username  : process.env.TURN_USERNAME  || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  res.json({ iceServers });
});

// Validate an invite link token before the client shows the join form
app.get('/api/validate-link/:token', (req, res) => {
  const { token } = req.params;
  let found = null;
  for (const room of rooms.values()) {
    if (room.inviteLinks.has(token)) {
      found = { room: room.code, link: room.inviteLinks.get(token) };
      break;
    }
  }
  if (!found) return res.status(404).json({ valid: false, reason: 'not_found' });
  const lnk = found.link;
  if (lnk.revoked)               return res.json({ valid: false, reason: 'revoked' });
  if (Date.now() > lnk.expiryTs) return res.json({ valid: false, reason: 'expired' });
  if (lnk.maxUses > 0 && lnk.usedCount >= lnk.maxUses)
                                  return res.json({ valid: false, reason: 'used_up' });
  res.json({ valid: true, roomCode: found.room, label: lnk.label });
});

// Serve the single-page app for all non-API routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

/* ─────────────────────────────────────────────
   SOCKET.IO  —  SIGNALLING + ROOM EVENTS
───────────────────────────────────────────── */
io.on('connection', socket => {

  /* ── JOIN ROOM ── */
  socket.on('join-room', ({ roomCode, name, role, token }) => {
    const room = getOrCreateRoom(roomCode);

    // Max 150 participants
    if (room.participants.size >= 150) {
      socket.emit('join-error', { reason: 'Room is full (150 participants).' });
      return;
    }

    // Validate invite token if provided
    if (token) {
      const lnk = room.inviteLinks.get(token);
      if (!lnk || lnk.revoked || Date.now() > lnk.expiryTs ||
          (lnk.maxUses > 0 && lnk.usedCount >= lnk.maxUses)) {
        socket.emit('join-error', { reason: 'Invite link is expired or invalid.' });
        return;
      }
      lnk.usedCount++;
    }

    // Only one teacher per room
    if (role === 'teacher') {
      if (room.teacherId && room.teacherId !== socket.id) {
        // demote to student
        role = 'student';
        socket.emit('role-downgraded', { reason: 'A teacher is already in this room. You joined as a student.' });
      } else {
        room.teacherId = socket.id;
      }
    }

    const participant = {
      id        : uuid(),
      socketId  : socket.id,
      name,
      role,
      micOn     : true,
      camOn     : true,
      handRaised: false,
    };
    room.participants.set(socket.id, participant);
    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    // Send current state to the joiner
    socket.emit('joined', {
      participant,
      participants: roomParticipantList(room),
      whiteboard  : room.whiteboard,
      chat        : room.chat.slice(-100),   // last 100 messages
      pollState   : room.pollState,
    });

    // Tell everyone else a new person arrived
    socket.to(roomCode).emit('participant-joined', { participant });

    console.log(`[${roomCode}] ${name} (${role}) joined — ${room.participants.size} total`);
  });

  /* ─────────────────────────────────────────
     WebRTC SIGNALLING
     Each pair of peers exchange:
       offer  → answer → ICE candidates
  ───────────────────────────────────────── */

  // Sender creates offer and sends to a specific peer
  socket.on('rtc-offer', ({ to, offer }) => {
    io.to(to).emit('rtc-offer', { from: socket.id, offer });
  });

  // Receiver answers
  socket.on('rtc-answer', ({ to, answer }) => {
    io.to(to).emit('rtc-answer', { from: socket.id, answer });
  });

  // ICE candidates trickled
  socket.on('rtc-ice', ({ to, candidate }) => {
    io.to(to).emit('rtc-ice', { from: socket.id, candidate });
  });

  /* ─────────────────────────────────────────
     WHITEBOARD (teacher only)
  ───────────────────────────────────────── */
  socket.on('wb-stroke', (stroke) => {
    const room = getRoom(socket);
    if (!room) return;
    if (!isTeacher(socket, room)) return;
    room.whiteboard.push(stroke);
    socket.to(room.code).emit('wb-stroke', stroke);
  });

  socket.on('wb-text', (block) => {
    const room = getRoom(socket);
    if (!room) return;
    if (!isTeacher(socket, room)) return;
    room.whiteboard.push({ type: 'text-block', ...block });
    socket.to(room.code).emit('wb-text', block);
  });

  socket.on('wb-clear', () => {
    const room = getRoom(socket);
    if (!room) return;
    if (!isTeacher(socket, room)) return;
    room.whiteboard = [];
    socket.to(room.code).emit('wb-clear');
  });

  socket.on('wb-undo', () => {
    const room = getRoom(socket);
    if (!room) return;
    if (!isTeacher(socket, room)) return;
    room.whiteboard.pop();
    socket.to(room.code).emit('wb-undo');
  });

  /* ─────────────────────────────────────────
     CHAT
  ───────────────────────────────────────── */
  socket.on('chat-msg', ({ text }) => {
    const room = getRoom(socket);
    if (!room) return;
    const p = room.participants.get(socket.id);
    if (!p) return;
    if (!text || text.trim().length === 0) return;
    const msg = {
      id       : uuid(),
      senderId : p.id,
      name     : p.name,
      role     : p.role,
      text     : text.trim().slice(0, 500),
      ts       : Date.now(),
    };
    room.chat.push(msg);
    if (room.chat.length > 500) room.chat.shift();  // rolling buffer
    io.to(room.code).emit('chat-msg', msg);
  });

  /* ─────────────────────────────────────────
     PARTICIPANT STATE (mic, cam, hand)
  ───────────────────────────────────────── */
  socket.on('state-update', ({ micOn, camOn, handRaised }) => {
    const room = getRoom(socket);
    if (!room) return;
    const p = room.participants.get(socket.id);
    if (!p) return;
    if (micOn      !== undefined) p.micOn      = micOn;
    if (camOn      !== undefined) p.camOn      = camOn;
    if (handRaised !== undefined) p.handRaised = handRaised;
    socket.to(room.code).emit('participant-state', {
      socketId: socket.id, micOn: p.micOn, camOn: p.camOn, handRaised: p.handRaised
    });
  });

  /* ─────────────────────────────────────────
     TEACHER ACTIONS (mute-all, lower-hands, kick)
  ───────────────────────────────────────── */
  socket.on('teacher-mute-all', () => {
    const room = getRoom(socket);
    if (!room || !isTeacher(socket, room)) return;
    room.participants.forEach(p => { p.micOn = false; });
    io.to(room.code).emit('mute-all');
  });

  socket.on('teacher-lower-hands', () => {
    const room = getRoom(socket);
    if (!room || !isTeacher(socket, room)) return;
    room.participants.forEach(p => { p.handRaised = false; });
    io.to(room.code).emit('lower-all-hands');
  });

  socket.on('teacher-kick', ({ targetSocketId }) => {
    const room = getRoom(socket);
    if (!room || !isTeacher(socket, room)) return;
    io.to(targetSocketId).emit('kicked', { reason: 'You were removed by the teacher.' });
    const kicked = room.participants.get(targetSocketId);
    if (kicked) {
      room.participants.delete(targetSocketId);
      io.to(room.code).emit('participant-left', { socketId: targetSocketId });
    }
  });

  /* ─────────────────────────────────────────
     POLL
  ───────────────────────────────────────── */
  socket.on('poll-launch', ({ question, options }) => {
    const room = getRoom(socket);
    if (!room || !isTeacher(socket, room)) return;
    room.pollState = { question, options, votes: {}, open: true };
    io.to(room.code).emit('poll-launched', { question, options });
  });

  socket.on('poll-vote', ({ option }) => {
    const room = getRoom(socket);
    if (!room || !room.pollState || !room.pollState.open) return;
    const p = room.participants.get(socket.id);
    if (!p) return;
    room.pollState.votes[p.id] = option;
    // Send tally to teacher only
    const tally = {};
    Object.values(room.pollState.votes).forEach(v => { tally[v] = (tally[v]||0)+1; });
    const teacher = room.teacherId;
    if (teacher) io.to(teacher).emit('poll-tally', { tally, total: Object.keys(room.pollState.votes).length });
  });

  socket.on('poll-close', () => {
    const room = getRoom(socket);
    if (!room || !isTeacher(socket, room)) return;
    if (room.pollState) room.pollState.open = false;
    io.to(room.code).emit('poll-closed');
  });

  /* ─────────────────────────────────────────
     INVITE LINKS (teacher only)
  ───────────────────────────────────────── */
  socket.on('generate-link', ({ label, expiryMs, maxUses }) => {
    const room = getRoom(socket);
    if (!room || !isTeacher(socket, room)) return;
    const token    = uuid().replace(/-/g,'') + uuid().replace(/-/g,''); // 64-char token
    const expiryTs = Date.now() + (expiryMs || 2592000000);
    const link = { token, label: label||'Class Session', expiryTs, maxUses: maxUses||0,
                   usedCount:0, revoked:false, createdAt: Date.now() };
    room.inviteLinks.set(token, link);
    const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
    const url    = `${appUrl}/?token=${token}&room=${room.code}`;
    socket.emit('link-generated', { token, url, label: link.label,
      expiryTs, maxUses: link.maxUses });
  });

  socket.on('revoke-link', ({ token }) => {
    const room = getRoom(socket);
    if (!room || !isTeacher(socket, room)) return;
    const lnk = room.inviteLinks.get(token);
    if (lnk) { lnk.revoked = true; socket.emit('link-revoked', { token }); }
  });

  /* ─────────────────────────────────────────
     DISCONNECT
  ───────────────────────────────────────── */
  socket.on('disconnecting', () => {
    const room = getRoom(socket);
    if (!room) return;
    room.participants.delete(socket.id);
    socket.to(room.code).emit('participant-left', { socketId: socket.id });
    if (room.teacherId === socket.id) {
      room.teacherId = null;
      socket.to(room.code).emit('teacher-left');
    }
    if (room.participants.size === 0) {
      // Keep room alive for 10 min then clean up
      setTimeout(() => {
        if (rooms.has(room.code) && rooms.get(room.code).participants.size === 0) {
          rooms.delete(room.code);
          console.log(`[${room.code}] Room cleaned up`);
        }
      }, 600_000);
    }
    console.log(`[${room.code}] ${socket.id} left — ${room.participants.size} remaining`);
  });

  /* ── Helpers ── */
  function getRoom(sock) {
    const code = sock.data.roomCode;
    return code ? rooms.get(code) : null;
  }
  function isTeacher(sock, room) {
    return room.teacherId === sock.id;
  }
});

/* ─────────────────────────────────────────────
   START
───────────────────────────────────────────── */
server.listen(PORT, () => {
  console.log(`\n🎓 Solidarity in Action — Server running`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
});
