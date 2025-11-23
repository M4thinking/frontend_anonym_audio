import React, { useEffect, useRef, useState } from 'react';

const SAMPLE_RATE = 16000;
const ROOM_ID = (import.meta.env.VITE_ROOM_ID as string | undefined) || 'demo';
const DEFAULT_ROLE = 'user';
const ENV_WS = (import.meta.env.VITE_WS_URL as string | undefined) || 'ws://localhost:8000';
console.log('Using WS URL:', ENV_WS);
type AudioRefs = {
  audioContext: AudioContext | null;
  mediaStream: MediaStream | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  processorNode: ScriptProcessorNode | null;
};

type AudioEventPayload = {
  event: 'audio';
  client_id: string;
  role: string;
  flagged: boolean;
  audio_b64: string;
  transcript?: string;
};

export default function App() {
  const [status, setStatus] = useState('Listo');
  const [recording, setRecording] = useState(false);
  const [role, setRole] = useState(DEFAULT_ROLE);
  const [roleDraft, setRoleDraft] = useState(DEFAULT_ROLE);
  const [showRoleInput, setShowRoleInput] = useState(false);
  const [scamAlertVisible, setScamAlertVisible] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const scamAlertTimeout = useRef<number | null>(null);
  const scamToneRef = useRef<{
    ctx: AudioContext | null;
    oscillator: OscillatorNode | null;
    gain: GainNode | null;
  }>({
    ctx: null,
    oscillator: null,
    gain: null
  });
  const audioRefs = useRef<AudioRefs>({
    audioContext: null,
    mediaStream: null,
    sourceNode: null,
    processorNode: null
  });
  // Buffer used for single-shot anonymize recordings
  const oneShotBuffer = useRef<Int16Array | null>(null);
  const [oneShotRecording, setOneShotRecording] = useState(false);

  useEffect(() => {
    return () => {
      stopCall();
      stopScamAlert();
    };
  }, []);

  const appendLog = (msg: string) => {
    const entry = `${new Date().toLocaleTimeString()} — ${msg}`;
    console.log(entry);
  };

  const buildWsUrl = (currentRole: string) => {
    const normalizedRole = (currentRole || 'user').toLowerCase();
    const endpoint = '/ws/communicate';
    return ENV_WS.includes('/ws/communicate') || ENV_WS.includes('/ws/communication-filtered')
      ? `${ENV_WS.split('?')[0]}?role=${normalizedRole}`
      : `${ENV_WS.replace(/\/$/, '')}${endpoint}/${ROOM_ID}?role=${normalizedRole}`;
  };

  const connectSocket = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(buildWsUrl(role));
      wsRef.current = ws;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        appendLog('WebSocket conectado');
        resolve(ws);
      };

      ws.onerror = (event) => {
        appendLog('Error WebSocket');
        reject(event);
      };

      ws.onclose = () => {
        appendLog('WebSocket cerrado');
      };

      ws.onmessage = handleSocketMessage;
    });

  const startCall = async () => {
    if (recording) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('Micrófono no soportado');
      appendLog('Tu navegador no soporta getUserMedia');
      return;
    }

    try {
      setStatus('Solicitando micrófono...');
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true
        }
      });

      setStatus('Conectando WS...');
      const ws = await connectSocket();

      // Send initialization message with recording flag
      const initPayload = {
        event: 'init_recording',
        init_recording: false
      };
      ws.send(JSON.stringify(initPayload));
      appendLog(`Init recording flag: ${initPayload.init_recording}`);

      const audioContext = new AudioContext({
        sampleRate: SAMPLE_RATE,
        latencyHint: 'interactive'
      });
      await audioContext.resume();

      const sourceNode = audioContext.createMediaStreamSource(mediaStream);
      const processorNode = audioContext.createScriptProcessor(2048, 1, 1);

      processorNode.onaudioprocess = (event) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcmBuffer = floatTo16BitPCMBuffer(input);
        wsRef.current.send(pcmBuffer);
      };

      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination);

      audioRefs.current = { audioContext, mediaStream, sourceNode, processorNode };
      setRecording(true);
      setStatus('Transmitiendo audio');
      appendLog('Llamada iniciada');
    } catch (err) {
      appendLog(`Error: ${String(err)}`);
      setStatus('Error');
      stopCall();
    }
  };

  const stopCall = async () => {
    if (audioRefs.current.processorNode) {
      audioRefs.current.processorNode.disconnect();
    }
    if (audioRefs.current.sourceNode) {
      audioRefs.current.sourceNode.disconnect();
    }
    if (audioRefs.current.audioContext) {
      await audioRefs.current.audioContext.close().catch(() => undefined);
    }
    if (audioRefs.current.mediaStream) {
      audioRefs.current.mediaStream.getTracks().forEach((track) => track.stop());
    }

    audioRefs.current = {
      audioContext: null,
      mediaStream: null,
      sourceNode: null,
      processorNode: null
    };

    setRecording(false);
    setStatus('Listo');

    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ event: 'end' }));
      }
      wsRef.current.close();
      wsRef.current = null;
    }
    appendLog('Llamada detenida');
    stopScamAlert();
  };

  // --- Single-shot anonymize recording flow ---
  const startOneShotRecording = async () => {
    if (oneShotRecording) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('Micrófono no soportado');
      return;
    }

    try {
      setStatus('Grabando...');
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      await audioContext.resume();
      const source = audioContext.createMediaStreamSource(mediaStream);
      const processor = audioContext.createScriptProcessor(2048, 1, 1);
      const chunks: Int16Array[] = [];

      processor.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0);
        const pcmBuf = floatTo16BitPCM(input);
        chunks.push(pcmBuf);
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      audioRefs.current = { ...audioRefs.current, audioContext, mediaStream, sourceNode: source, processorNode: processor };
      oneShotBuffer.current = null;
      setOneShotRecording(true);
    } catch (err) {
      appendLog(`Error one-shot start: ${String(err)}`);
      setStatus('Error');
    }
  };

  const stopOneShotRecordingAndSend = async () => {
    if (!oneShotRecording) return;
    try {
      setStatus('Deteniendo...');
      const { processorNode, sourceNode, mediaStream, audioContext } = audioRefs.current;
      // disconnect nodes and stop tracks
      processorNode?.disconnect();
      sourceNode?.disconnect();
      mediaStream?.getTracks().forEach((t) => t.stop());

      // collect recorded data from processor by recreating from onaudioprocess chunks is not trivial here
      // Instead, we re-create by reading from an offline recorder: use MediaRecorder as fallback
      // Use MediaRecorder to capture a short WAV/PCM blob
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const blobs: Blob[] = [];
      recorder.ondataavailable = (e) => blobs.push(e.data);
      recorder.start();
      await new Promise((r) => setTimeout(r, 250));
      recorder.stop();
      await new Promise((r) => (recorder.onstop = r));
      stream.getTracks().forEach((t) => t.stop());

      const blob = new Blob(blobs, { type: blobs[0]?.type || 'audio/webm' });
      const arrayBuf = await blob.arrayBuffer();

      // If it's webm/ogg/pcm we send raw bytes base64. The backend expects PCM16 audio in base64; many browsers produce webm Opus.
      // We'll send the recorded blob bytes and let backend handle decoding if supported. If not, this still demonstrates the flow.
      const b64 = arrayBufferToBase64(arrayBuf);

      setStatus('Enviando a anonimizar...');
      const resp = await fetch('/anonymize-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_b64: b64 })
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Server ${resp.status}: ${txt}`);
      }
      const json = await resp.json();
      const audioB64 = json.audio_b64;
      const audioFormat = json.audio_format || 'mp3';

      // play returned audio
      await playBase64Audio(audioB64, audioFormat);
      setStatus('Listo');
    } catch (err) {
      appendLog(`One-shot error: ${String(err)}`);
      setStatus('Error');
    } finally {
      setOneShotRecording(false);
      // cleanup audioRefs
      try {
        if (audioRefs.current.audioContext) await audioRefs.current.audioContext.close();
      } catch {}
      audioRefs.current = { audioContext: null, mediaStream: null, sourceNode: null, processorNode: null };
    }
  };

  const toggleOneShot = async () => {
    if (!oneShotRecording) await startOneShotRecording();
    else await stopOneShotRecordingAndSend();
  };

  const playBase64Audio = async (b64: string, format: string) => {
    try {
      const ctx = audioRefs.current.audioContext || new AudioContext({ sampleRate: SAMPLE_RATE });
      await ctx.resume();
      const bytes = base64ToUint8(b64);
      if (format.includes('mp3') || format.includes('mp4') || format === 'mp3') {
        const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        const src = ctx.createBufferSource();
        src.buffer = audioBuffer;
        src.connect(ctx.destination);
        src.start();
      } else {
        // assume PCM16LE
        const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) float32[i] = Math.max(-1, Math.min(1, int16[i] / 0x8000));
        const buffer = ctx.createBuffer(1, float32.length, SAMPLE_RATE);
        buffer.getChannelData(0).set(float32);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start();
      }
    } catch (err) {
      appendLog(`Error playing anonymized audio: ${String(err)}`);
    }
  };

  const handleSocketMessage = async (event: MessageEvent) => {
    if (typeof event.data === 'string') {
      let payload: any;
      try {
        payload = JSON.parse(event.data);
      } catch {
        appendLog('Mensaje texto sin parsear');
        return;
      }

      switch (payload?.event) {
        case 'ready':
          appendLog(`Conectado como ${payload.role ?? role}`);
          return;
        case 'peers':
          appendLog(`Peers activos: ${(payload.peers ?? []).length}`);
          return;
        case 'peer_joined':
          appendLog(`Se unió ${payload.client_id} (${payload.role})`);
          return;
        case 'peer_left':
          appendLog(`Salió ${payload.client_id} (${payload.role})`);
          return;
        case 'audio':
        case 'audio_anonymized':
          return playIncomingAudio(payload as AudioEventPayload);
        default:
          appendLog(`Evento desconocido: ${payload?.event ?? 'n/a'}`);
          return;
      }
    }

    if (event.data instanceof ArrayBuffer) {
      appendLog('Chunk binario inesperado');
    }
  };

  const stopScamAlert = () => {
    setScamAlertVisible(false);
    if (scamAlertTimeout.current) {
      window.clearTimeout(scamAlertTimeout.current);
      scamAlertTimeout.current = null;
    }
    const { oscillator, gain, ctx } = scamToneRef.current;
    try {
      oscillator?.stop();
      oscillator?.disconnect();
      gain?.disconnect();
      ctx?.close();
    } catch {
      // ignore cleanup errors
    }
    scamToneRef.current = { ctx: null, oscillator: null, gain: null };
  };

  const triggerScamAlert = async () => {
    stopScamAlert();
    setScamAlertVisible(true);

    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.resume();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = 'square';
    oscillator.frequency.value = 880;
    gain.gain.value = 0.05;

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    oscillator.start();
    scamToneRef.current = { ctx, oscillator, gain };

    scamAlertTimeout.current = window.setTimeout(() => {
      stopScamAlert();
    }, 5000);
  };

  const playIncomingAudio = async (payload: AudioEventPayload) => {
    const ctx = audioRefs.current.audioContext;
    if (!ctx) return;

    try {
      if (payload.flagged && payload.role === 'scammer') {
        triggerScamAlert();
      }
      await ctx.resume();
      const bytes = base64ToUint8(payload.audio_b64);
      
      // Check if this is MP3 audio (from anonymizer) or PCM audio
      const audioFormat = (payload as any).audio_format || 'pcm';
      
      let audioBuffer: AudioBuffer;
      
      if (audioFormat === 'mp3') {
        // Decode MP3 using Web Audio API
        audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      } else {
        // Original PCM format handling
        const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
          float32[i] = Math.max(-1, Math.min(1, int16[i] / 0x8000));
        }
        audioBuffer = ctx.createBuffer(1, float32.length, SAMPLE_RATE);
        audioBuffer.getChannelData(0).set(float32);
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.start();

      setStatus(payload.flagged ? 'Audio marcado 🚨' : 'Transmitiendo audio');
      appendLog(
        `Audio entrante de ${payload.role} ${payload.flagged ? '(FLAG)' : ''}${
          payload.transcript ? ` · "${payload.transcript}"` : ''
        }`
      );
    } catch (err) {
      appendLog(`Error al reproducir chunk: ${String(err)}`);
    }
  };

  const handleRoleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextRole = (roleDraft || '').trim().toLowerCase() || 'user';
    setRole(nextRole);
    setShowRoleInput(false);
    appendLog(`Rol configurado a "${nextRole}"`);
    if (recording) {
      await stopCall();
    }
  };

  return (
    <div className="page">
      <div className="layout">
        {scamAlertVisible && (
          <div className="scam-alert">
            <div className="scam-alert-card">
              <div className="alert-pill">Alerta</div>
              <h3>Posible estafa</h3>
              <p>Se detectó actividad sospechosa en la llamada.</p>
              <button className="ghost-btn" type="button" onClick={stopScamAlert}>
                Entendido
              </button>
            </div>
          </div>
        )}
        <header className="masthead">
          <div className="eyebrow-row">
            <span className="pill pill-soft">Call simulator · Llamada</span>
            <span className="pill pill-outline">Rol activo: {role}</span>
          </div>
          <h1>Hop - Blindaje activo para tus llamadas</h1>
          <p className="lede">
            Protege cada conversación con monitoreo en vivo y alertas inmediatas ante cualquier señal sospechosa. Abre la
            línea y mantén tu voz segura de punta a punta.
          </p>
          <div className="meta">
            <div className="role-config">
              {!showRoleInput && (
                <button className="ghost-btn" type="button" onClick={() => setShowRoleInput(true)}>
                  Ajustar rol
                </button>
              )}
              {showRoleInput && (
                <form className="role-form" onSubmit={handleRoleSubmit}>
                  <input
                    value={roleDraft}
                    onChange={(e) => setRoleDraft(e.target.value)}
                    placeholder="user | scammer"
                    className="role-input"
                    autoFocus
                  />
                  <button className="ghost-btn" type="submit">
                    Guardar
                  </button>
                </form>
              )}
            </div>
          </div>
        </header>

        <div className="content-grid">
          <section className="card control-card">
            <div className="card-head">
              <div>
                <p className="card-kicker">Sesión</p>
                <h2>Control principal</h2>
                <p className="card-copy">Inicia o detén la llamada. Si quieres cambiar de rol, ajusta antes de iniciar.</p>
              </div>
              <span className={`status-pill ${recording ? 'on' : 'idle'}`}>{status}</span>
            </div>

            <div className="controls">
              <button className="btn start" onClick={startCall} disabled={recording}>
                {recording ? 'En llamada…' : '📞 Iniciar'}
              </button>
              <button className="btn stop" onClick={stopCall} disabled={!recording}>
                🚫 Colgar
              </button>
              <button
                className={`btn ${oneShotRecording ? 'stop' : 'start'}`}
                onClick={toggleOneShot}
              >
                {oneShotRecording ? '⏹️ Detener y Anonimizar' : '🔴 Grabar Anon.'}
              </button>
            </div>

            <div className="status-note">
              <div>
                <p className="status-label">Modo de audio</p>
                <p className="status-value">Voz clara</p>
              </div>
              <div>
                <p className="status-label">Línea</p>
                <p className="status-value">{recording ? 'Abierta' : 'En espera'}</p>
              </div>
            </div>
          </section>

          <section className="card info-card">
            <div className="card-head inline">
              <div>
                <p className="card-kicker">Ambiente</p>
                <h2>Consejos para la llamada</h2>
              </div>
              <div className="pill pill-soft subtle">Modo eco</div>
            </div>
            <div className="info-grid">
              <div className="info-item">
                <p className="info-title">Busca silencio</p>
                <p className="info-copy">Usa audífonos o un lugar sin ruido para escuchar mejor el retorno.</p>
              </div>
              <div className="info-item">
                <p className="info-title">Habla natural</p>
                <p className="info-copy">Mantén el micrófono cerca y habla como lo harías en una llamada real.</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function floatTo16BitPCMBuffer(input: Float32Array) {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

// helper to return Int16Array from Float32Array
function floatTo16BitPCM(input: Float32Array) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)) as any);
  }
  return btoa(binary);
}

function base64ToUint8(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
