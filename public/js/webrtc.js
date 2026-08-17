/**
 * webrtc.js  —  Manages all peer connections for Solidarity in Action
 *
 * Flow per new remote participant:
 *  1. Server emits  participant-joined  → we create an RTCPeerConnection
 *  2. Caller creates offer  → sends via socket → remote answers
 *  3. ICE candidates trickle both ways
 *  4. ontrack fires → remote stream attached to that peer's video tile
 */

'use strict';

class WebRTCManager {
  constructor(socket, localStream, onRemoteStream, onRemoteDisconnect) {
    this.socket             = socket;
    this.localStream        = localStream;
    this.onRemoteStream     = onRemoteStream;      // (socketId, stream) => void
    this.onRemoteDisconnect = onRemoteDisconnect;  // (socketId) => void
    this.peers              = new Map();           // socketId → RTCPeerConnection
    this.iceConfig          = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    this._bindSocketEvents();
  }

  /* ── Load ICE config from server ── */
  async loadIceConfig() {
    try {
      const res = await fetch('/api/ice-config');
      this.iceConfig = await res.json();
    } catch (e) {
      console.warn('Could not load ICE config, using default STUN');
    }
  }

  /* ── Create a peer connection to a remote socket ── */
  async createPeer(remoteSocketId, isInitiator) {
    if (this.peers.has(remoteSocketId)) return this.peers.get(remoteSocketId);

    const pc = new RTCPeerConnection(this.iceConfig);
    this.peers.set(remoteSocketId, pc);

    // Add all local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // ICE candidate → forward via socket
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.socket.emit('rtc-ice', { to: remoteSocketId, candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (['failed','closed','disconnected'].includes(pc.iceConnectionState)) {
        this._removePeer(remoteSocketId);
      }
    };

    // Remote track arrived → attach to that participant's tile
    pc.ontrack = ({ streams }) => {
      if (streams && streams[0]) {
        this.onRemoteStream(remoteSocketId, streams[0]);
      }
    };

    if (isInitiator) {
      const offer = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
      await pc.setLocalDescription(offer);
      this.socket.emit('rtc-offer', { to: remoteSocketId, offer: pc.localDescription });
    }

    return pc;
  }

  /* ── Received offer from a peer ── */
  async handleOffer(fromSocketId, offer) {
    const pc = await this.createPeer(fromSocketId, false);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.socket.emit('rtc-answer', { to: fromSocketId, answer: pc.localDescription });
  }

  /* ── Received answer ── */
  async handleAnswer(fromSocketId, answer) {
    const pc = this.peers.get(fromSocketId);
    if (!pc) return;
    if (pc.signalingState === 'stable') return;
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  /* ── Received ICE candidate ── */
  async handleIce(fromSocketId, candidate) {
    const pc = this.peers.get(fromSocketId);
    if (!pc || !candidate) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { /* ignore */ }
  }

  /* ── Connect to all existing participants ── */
  async connectToAll(participantList, mySocketId) {
    for (const p of participantList) {
      if (p.socketId !== mySocketId) {
        await this.createPeer(p.socketId, true);
      }
    }
  }

  /* ── Replace local stream (e.g. after device change) ── */
  updateStream(newStream) {
    this.localStream = newStream;
    this.peers.forEach(pc => {
      const senders = pc.getSenders();
      newStream.getTracks().forEach(track => {
        const sender = senders.find(s => s.track && s.track.kind === track.kind);
        if (sender) sender.replaceTrack(track);
        else        pc.addTrack(track, newStream);
      });
    });
  }

  /* ── Remove a single peer ── */
  _removePeer(socketId) {
    const pc = this.peers.get(socketId);
    if (pc) { pc.close(); this.peers.delete(socketId); }
    this.onRemoteDisconnect(socketId);
  }

  /* ── Close all peers ── */
  closeAll() {
    this.peers.forEach(pc => pc.close());
    this.peers.clear();
  }

  /* ── Bind server socket events ── */
  _bindSocketEvents() {
    this.socket.on('rtc-offer',  ({ from, offer })     => this.handleOffer(from, offer));
    this.socket.on('rtc-answer', ({ from, answer })    => this.handleAnswer(from, answer));
    this.socket.on('rtc-ice',    ({ from, candidate }) => this.handleIce(from, candidate));
  }
}
