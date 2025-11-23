# Call Simulator Web (React + Vite)

Cliente web que replica el flujo de la versión React Native: captura el micrófono, envía PCM (16 kHz, 16‑bit, mono) en base64 por WebSocket y reproduce la respuesta del servidor.

## Requisitos
- Node 18+ y npm.
- Servidor WebSocket accesible con el mismo contrato (`base64` de PCM crudo).

## Configuración rápida
```bash
cd react-web
npm install
npm run dev
```
Pon la URL completa de tu WebSocket de comunicación en un `.env`:
```
VITE_WS_URL=ws://localhost:8000/ws/communicate/demo?role=user
# opcional: VITE_ROOM_ID=demo
```
- El rol (`user`/`scammer`) se ajusta dentro de la UI con el botón sutil **“Ajustar rol”**; el campo desaparece al enviarlo.

## Build y despliegue en Vercel
```bash
npm run build
```
El output queda en `dist/`. En Vercel:
- **Framework**: Vite / React.
- **Comando de build**: `npm run build`
- **Output**: `dist`
- **Env**: `VITE_WS_URL` apuntando al WebSocket público.

## Detalles técnicos
- `AudioContext` con `sampleRate: 16000` para evitar resamples.
- `ScriptProcessorNode` captura `Float32Array` y se convierte a `Int16` PCM → base64 → WebSocket.
- La respuesta (base64 de PCM) se envuelve en WAV en el cliente y se reproduce con `Audio`.
- Logs y estado se muestran en la UI para depurar reconexiones y permisos.
