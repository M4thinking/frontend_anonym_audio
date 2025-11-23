import fs from 'fs';
import path from 'path';
import express from 'express';
import { createServer } from 'http';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
const wsPath = '/ws';

const distPath = path.join(__dirname, 'dist');
const staticPath = fs.existsSync(distPath) ? distPath : path.join(__dirname, 'public');
const indexFile = path.join(staticPath, 'index.html');

app.use(express.static(staticPath));
app.get('*', (req, res, next) => {
  fs.access(indexFile, fs.constants.F_OK, (err) => {
    if (err) return next();
    res.sendFile(indexFile);
  });
});

const server = createServer(app);
const wss = new WebSocket.Server({ server, path: wsPath });

wss.on('connection', (socket, req) => {
  const address = req.socket.remoteAddress;
  console.log(`Client connected from ${address}`);

  socket.on('message', (data) => {
    // Fan-out the received audio chunk to all connected clients.
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  });

  socket.on('close', () => {
    console.log(`Client from ${address} disconnected`);
  });
});

server.listen(port, () => {
  console.log(`Server listening on http://localhost:${port} (WS at ${wsPath})`);
});
