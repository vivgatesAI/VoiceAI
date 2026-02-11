(function () {
  'use strict';

  const statusEl = document.getElementById('status');
  const btn = document.getElementById('ptt');
  const inboxEl = document.getElementById('inbox');
  const micStatus = document.getElementById('mic-status');
  const aiStatus = document.getElementById('ai-status');
  const netStatus = document.getElementById('net-status');
  const clockEl = document.getElementById('clock');

  const STATE = {
    IDLE: 'READY',
    LISTENING: 'LISTENING…',
    PROCESSING: 'PROCESSING…',
    SENT: 'SENT',
    ERROR: 'ERROR'
  };

  const CONFIG = { MIN_RECORDING_DURATION: 350, FFT_SIZE: 2048 };

  const AudioCapture = {
    stream: null,
    audioContext: null,
    analyser: null,
    recorder: null,
    chunks: [],
    mimeType: '',
    recordingStartTime: 0,

    async init() {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = CONFIG.FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0.3;
      source.connect(this.analyser);
      const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      this.mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    },

    startRecording() {
      this.chunks = [];
      this.recorder = new MediaRecorder(this.stream, {
        mimeType: this.mimeType || undefined,
        audioBitsPerSecond: 32000,
      });
      this.recorder.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };
      this.recordingStartTime = Date.now();
      this.recorder.start();
    },

    stopRecording() {
      return new Promise((resolve) => {
        if (!this.recorder || this.recorder.state !== 'recording') { resolve(null); return; }
        if (Date.now() - this.recordingStartTime < CONFIG.MIN_RECORDING_DURATION) {
          this.recorder.stop(); resolve(null); return;
        }
        this.recorder.onstop = () => {
          resolve(new Blob(this.chunks, { type: this.mimeType || 'audio/webm' }));
        };
        this.recorder.stop();
      });
    },
  };

  const WavEncoder = {
    async blobToWav(blob) {
      const arrayBuffer = await blob.arrayBuffer();
      const audioCtx = new OfflineAudioContext(1, 1, 16000);
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      const targetRate = 16000;
      const offlineCtx = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * targetRate), targetRate);
      const source = offlineCtx.createBufferSource();
      source.buffer = audioBuffer; source.connect(offlineCtx.destination); source.start(0);
      const resampled = await offlineCtx.startRendering();
      return this.encodeWAV(resampled);
    },

    encodeWAV(audioBuffer) {
      const samples = audioBuffer.getChannelData(0);
      const sampleRate = audioBuffer.sampleRate;
      const dataSize = samples.length * 2;
      const buffer = new ArrayBuffer(44 + dataSize);
      const v = new DataView(buffer);
      const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); w(8, 'WAVE');
      w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
      v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
      v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      w(36, 'data'); v.setUint32(40, dataSize, true);
      let offset = 44;
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        v.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
      }
      return new Blob([buffer], { type: 'audio/wav' });
    },
  };

  const API = {
    async transcribe(audioBlob) {
      const wavBlob = await WavEncoder.blobToWav(audioBlob);
      const formData = new FormData();
      formData.append('audio', wavBlob, 'recording.wav');
      const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
      if (!res.ok) throw new Error(`Transcription failed: ${res.status}`);
      return res.json();
    },
    async inbox() {
      const res = await fetch('/api/telegram-inbox');
      if (!res.ok) return { messages: [] };
      return res.json();
    }
  };

  let recording = false;

  function setStatus(text) { statusEl.textContent = text; }

  async function handlePressStart() {
    if (recording) return;
    try {
      if (!AudioCapture.stream) {
        setStatus('MIC PERMISSION…');
        await AudioCapture.init();
      }
    } catch (e) {
      setStatus('MIC BLOCKED');
      return;
    }
    recording = true;
    btn.classList.add('recording');
    micStatus.classList.add('active');
    setStatus(STATE.LISTENING);
    AudioCapture.startRecording();
  }

  async function handlePressEnd() {
    if (!recording) return;
    recording = false;
    btn.classList.remove('recording');
    micStatus.classList.remove('active');
    setStatus(STATE.PROCESSING);
    aiStatus.classList.add('active');
    const audioBlob = await AudioCapture.stopRecording();
    if (!audioBlob) { setStatus(STATE.IDLE); aiStatus.classList.remove('active'); return; }

    try {
      const { text } = await API.transcribe(audioBlob);
      if (!text || !text.trim()) { setStatus(STATE.IDLE); aiStatus.classList.remove('active'); return; }
      setStatus(STATE.SENT);
      setTimeout(() => setStatus(STATE.IDLE), 1200);
    } catch (e) {
      setStatus(STATE.ERROR);
      setTimeout(() => setStatus(STATE.IDLE), 2000);
    } finally {
      aiStatus.classList.remove('active');
    }
  }

  function renderInbox(messages) {
    if (!inboxEl) return;
    if (!messages || messages.length === 0) {
      inboxEl.innerHTML = '<div class="empty">No messages yet</div>';
      return;
    }
    inboxEl.innerHTML = messages.slice(-20).map(m => {
      const time = new Date(m.ts).toLocaleTimeString();
      return `<div class="msg"><div class="meta">${m.from} • ${time}</div><div class="text">${m.text}</div></div>`;
    }).join('');
  }

  async function pollInbox() {
    try {
      netStatus.classList.add('active');
      const data = await API.inbox();
      renderInbox(data.messages || []);
    } catch (e) {
      netStatus.classList.remove('active');
    }
  }

  function startClock() {
    const update = () => { clockEl.textContent = new Date().toLocaleTimeString('en-US', { hour12: false }); };
    update(); setInterval(update, 1000);
  }

  async function init() {
    try {
      await AudioCapture.init();
      setStatus(STATE.IDLE);
      startClock();
      pollInbox();
      setInterval(pollInbox, 5000);
    } catch (e) {
      setStatus('MIC BLOCKED');
    }
  }

  btn.addEventListener('mousedown', (e) => { e.preventDefault(); handlePressStart(); });
  btn.addEventListener('mouseup', (e) => { e.preventDefault(); handlePressEnd(); });
  btn.addEventListener('mouseleave', () => { if (recording) handlePressEnd(); });
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); handlePressStart(); });
  btn.addEventListener('touchend', (e) => { e.preventDefault(); handlePressEnd(); });

  // Keyboard support
  let spaceDown = false;
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat && !spaceDown) {
      e.preventDefault(); spaceDown = true; handlePressStart();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { e.preventDefault(); spaceDown = false; handlePressEnd(); }
  });

  // Auto-init on DOM ready
  document.addEventListener('DOMContentLoaded', init);
})();
