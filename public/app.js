const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const callClockEl = document.getElementById('callClock');
const statusTimeEl = document.getElementById('statusTime');

const AUDIO_MIME = 'audio/webm;codecs=opus';
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const audioContext = AudioContextClass ? new AudioContextClass() : null;

let mediaStream = null;
let mediaRecorder = null;
let ws = null;
let isRecording = false;
let callTimer = null;
let callStartTime = null;
let playbackMimeType = AUDIO_MIME;

startBtn.addEventListener('click', startCall);
stopBtn.addEventListener('click', stopCall);

updateStatusClock();
setInterval(updateStatusClock, 30_000);

if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
  setStatus('Tu navegador no soporta captura de audio');
  startBtn.disabled = true;
  log('El navegador no permite capturar audio o usar MediaRecorder.');
}

function log(message) {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString()} — ${message}`;
  logEl.prepend(item);
  // Keep log tidy.
  if (logEl.children.length > 30) {
    logEl.removeChild(logEl.lastChild);
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}

async function startCall() {
  if (isRecording) return;

  try {
    setStatus('Solicitando micrófono...');
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    setStatus('Conectando con el servidor...');
    await openWebSocket();

    setStatus('Transmitiendo audio');
    startRecording();
    startTimer();
    startBtn.disabled = true;
    stopBtn.disabled = false;
    isRecording = true;
    log('Llamada iniciada, enviando audio...');
  } catch (err) {
    console.error(err);
    log(`Error: ${err.message}`);
    setStatus('Error');
    cleanup();
  }
}

function stopCall() {
  if (!isRecording) return;
  log('Deteniendo llamada...');
  setStatus('Cerrando...');
  cleanup();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('Listo');
}

function startRecording() {
  try {
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: AUDIO_MIME });
  } catch (_) {
    // Fallback if mimeType is not supported.
    mediaRecorder = new MediaRecorder(mediaStream);
  }
  playbackMimeType = mediaRecorder.mimeType || AUDIO_MIME;

  mediaRecorder.ondataavailable = ({ data }) => {
    if (data.size > 0 && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  };

  mediaRecorder.onerror = (event) => {
    log(`Error de grabación: ${event.error?.message || event.name}`);
    stopCall();
  };

  mediaRecorder.start(400); // Send chunks every ~400ms.
}

function cleanup() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  mediaRecorder = null;

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
  }
  mediaStream = null;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  ws = null;

  isRecording = false;
  stopTimer();
}

function openWebSocket() {
  return new Promise((resolve, reject) => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${window.location.host}/ws`;
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    const onOpen = () => {
      log('Conectado al servidor WebSocket');
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      resolve();
    };

    const onError = (event) => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      reject(event?.error || new Error('No se pudo abrir el WebSocket'));
    };

    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onError, { once: true });
    ws.addEventListener('close', () => {
      log('WebSocket cerrado');
    });

    ws.addEventListener('message', handleIncomingAudio);
  });
}

function handleIncomingAudio(event) {
  if (!event.data) return;

  const blob = event.data instanceof Blob ? event.data : new Blob([event.data], { type: playbackMimeType });
  if (blob.type) {
    playbackMimeType = blob.type;
  }
  try {
    // Prefer Web Audio to avoid container mismatches.
    if (audioContext) {
      audioContext.resume().catch(() => {});
      decodeAndPlay(blob);
      return;
    }
  } catch (err) {
    log(`No se pudo decodificar audio: ${err.message}`);
  }

  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.play().catch((err) => log(`No se pudo reproducir audio: ${err.message}`));
  audio.onended = () => URL.revokeObjectURL(url);
}

function startTimer() {
  callStartTime = Date.now();
  renderClock();
  clearInterval(callTimer);
  callTimer = setInterval(renderClock, 1000);
}

function stopTimer() {
  if (callTimer) {
    clearInterval(callTimer);
    callTimer = null;
  }
  callClockEl.textContent = '00:00';
  callStartTime = null;
}

function renderClock() {
  if (!callStartTime) return;
  const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const seconds = String(elapsed % 60).padStart(2, '0');
  callClockEl.textContent = `${minutes}:${seconds}`;
}

function updateStatusClock() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  statusTimeEl.textContent = `${hours}:${minutes}`;
}

function decodeAndPlay(blob) {
  if (!audioContext) return;
  blob
    .arrayBuffer()
    .then((buffer) => new Promise((resolve, reject) => {
      // Some browsers still use the callback API.
      audioContext.decodeAudioData(
        buffer.slice(0),
        (decoded) => resolve(decoded),
        (err) => reject(err || new Error('decodeAudioData failed'))
      );
    }))
    .then((audioBuffer) => {
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);
      source.start();
    })
    .catch((err) => {
      log(`No se pudo decodificar audio: ${err.message}`);
    });
}
