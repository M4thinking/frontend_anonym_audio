import React, { useEffect, useRef, useState } from 'react';

const SAMPLE_RATE = 16000;
const ROOM_ID = (import.meta.env.VITE_ROOM_ID as string | undefined) || 'demo';
const DEFAULT_ROLE = 'user';
const ENV_WS = (import.meta.env.VITE_WS_URL as string | undefined) || 'ws://localhost:8000';

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
  const wsRef = useRef<WebSocket | null>(null);
  const audioRefs = useRef<AudioRefs>({
    audioContext: null,
    mediaStream: null,
    sourceNode: null,
    processorNode: null
  });

  useEffect(() => {
    return () => {
      stopCall();
    };
  }, []);

  const appendLog = (msg: string) => {
    const entry = `${new Date().toLocaleTimeString()} — ${msg}`;
    console.log(entry);
  };

  const buildWsUrl = (currentRole: string) => {
    const normalizedRole = (currentRole || 'user').toLowerCase();
    return ENV_WS.includes('/ws/communicate')
      ? `${ENV_WS.split('?')[0]}?role=${normalizedRole}`
      : `${ENV_WS.replace(/\/$/, '')}/ws/communicate/${ROOM_ID}?role=${normalizedRole}`;
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

  const playIncomingAudio = async (payload: AudioEventPayload) => {
    const ctx = audioRefs.current.audioContext;
    if (!ctx) return;

    try {
      await ctx.resume();
      const bytes = base64ToUint8(payload.audio_b64);
      const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = Math.max(-1, Math.min(1, int16[i] / 0x8000));
      }

      const audioBuffer = ctx.createBuffer(1, float32.length, SAMPLE_RATE);
      audioBuffer.getChannelData(0).set(float32);

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
      <div className="shell">
        <header className="header">
          <p className="eyebrow">Call simulator · Web</p>
          <h1>Streaming de voz al WebSocket y eco de vuelta</h1>
          <p className="lede">
            Captura tu micrófono, envía audio PCM binario a <code>{buildWsUrl(role)}</code> y reproduce en vivo lo que
            envíe el servidor. Hecho para desplegar en Vercel.
          </p>
          <div className="stealth-config">
            {!showRoleInput && (
              <button className="stealth-btn" type="button" onClick={() => setShowRoleInput(true)}>
                Ajustar rol
              </button>
            )}
            {showRoleInput && (
              <form className="stealth-form" onSubmit={handleRoleSubmit}>
                <input
                  value={roleDraft}
                  onChange={(e) => setRoleDraft(e.target.value)}
                  placeholder="user | scammer"
                  className="stealth-input"
                  autoFocus
                />
                <button className="stealth-btn" type="submit">
                  OK
                </button>
              </form>
            )}
          </div>
        </header>

        <section className="panel">
          <div className="controls">
            <button className="btn start" onClick={startCall} disabled={recording}>
              {recording ? 'Transmitiendo…' : 'Iniciar'}
            </button>
            <button className="btn stop" onClick={stopCall} disabled={!recording}>
              Detener
            </button>
          </div>

          <div className="status">
            <span className="status-label">Estado</span>
            <span className="status-value">{status}</span>
          </div>
        </section>

        <section className="help">
          <div>
            <p className="help-title">¿No se escucha?</p>
            <p className="help-copy">
              Asegúrate de apuntar <code>VITE_WS_URL</code> a tu servidor y que el navegador permita el micrófono.
              Algunos navegadores fuerzan otra frecuencia; Chrome suele respetar 16 kHz si se crea el
              <code>AudioContext</code> con <code>sampleRate: 16000</code>.
            </p>
          </div>
          <div>
            <p className="help-title">Listo para Vercel</p>
            <p className="help-copy">
              Ejecuta <code>npm run build</code> y despliega la carpeta <code>dist</code>. Configura la variable{' '}
              <code>VITE_WS_URL</code> en tu proyecto de Vercel para apuntar al WebSocket público.
            </p>
          </div>
        </section>
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

function base64ToUint8(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
