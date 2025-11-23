import React, { useEffect, useRef, useState } from 'react';

const SAMPLE_RATE = 16000;
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3000/ws';
const LOG_LIMIT = 50;

type AudioRefs = {
  audioContext: AudioContext | null;
  mediaStream: MediaStream | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  processorNode: ScriptProcessorNode | null;
};

export default function App() {
  const [status, setStatus] = useState('Listo');
  const [recording, setRecording] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
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
    setLogs((prev) => [`${new Date().toLocaleTimeString()} — ${msg}`, ...prev].slice(0, LOG_LIMIT));
  };

  const connectSocket = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

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

      ws.onmessage = handleIncomingAudio;
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

      const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      await audioContext.resume();

      const sourceNode = audioContext.createMediaStreamSource(mediaStream);
      const processorNode = audioContext.createScriptProcessor(4096, 1, 1);

      processorNode.onaudioprocess = (event) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = floatTo16BitPCM(input);
        const base64 = uint8ToBase64(new Uint8Array(pcm.buffer));
        wsRef.current.send(base64);
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
      wsRef.current.close();
      wsRef.current = null;
    }
    appendLog('Llamada detenida');
  };

  const handleIncomingAudio = async (event: MessageEvent) => {
    if (typeof event.data !== 'string') return;
    try {
      const wavBlob = pcmBase64ToWavBlob(event.data, SAMPLE_RATE);
      const url = URL.createObjectURL(wavBlob);
      const audio = new Audio(url);

      const cleanup = () => URL.revokeObjectURL(url);
      audio.onended = cleanup;
      audio.onerror = cleanup;

      await audio.play();
    } catch (err) {
      appendLog(`Error al reproducir: ${String(err)}`);
    }
  };

  return (
    <div className="page">
      <div className="shell">
        <header className="header">
          <p className="eyebrow">Call simulator · Web</p>
          <h1>Streaming de voz al WebSocket y eco de vuelta</h1>
          <p className="lede">
            Captura tu micrófono, envía PCM en base64 a <code>{WS_URL}</code> y reproduce lo que responda el
            servidor. Hecho para desplegar en Vercel.
          </p>
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

          <div className="logs">
            <div className="logs-header">
              <span>Eventos</span>
              <span className="badge">{logs.length}</span>
            </div>
            <div className="logs-body">
              {logs.length === 0 && <p className="empty">Aún no hay eventos.</p>}
              {logs.map((line) => (
                <p key={line} className="log-line">
                  {line}
                </p>
              ))}
            </div>
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

function floatTo16BitPCM(input: Float32Array) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

function uint8ToBase64(u8: Uint8Array) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < u8.length; i += chunkSize) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function pcmBase64ToWavBlob(base64Pcm: string, sampleRate: number) {
  const pcm = Uint8Array.from(atob(base64Pcm), (c) => c.charCodeAt(0));
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, pcm.byteLength, true);

  const wavBytes = new Uint8Array(header.byteLength + pcm.byteLength);
  wavBytes.set(new Uint8Array(header), 0);
  wavBytes.set(pcm, header.byteLength);

  return new Blob([wavBytes], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
