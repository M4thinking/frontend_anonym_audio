const path = require('path');
const express = require('express');
const { createServer } = require('http');
const WebSocket = require('ws');

const app = express();
const port = process.env.PORT || 3000;
const wsPath = '/ws';

app.use(express.static(path.join(__dirname, 'public')));

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
