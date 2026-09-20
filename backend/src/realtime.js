'use strict';
/* WebSocket fan-out. Clients connect to /live and receive the public snapshot
   on connect, then again on every change. Read-only: anything a client sends
   is ignored. */
const { WebSocketServer } = require('ws');
const registry = require('./services/registry');

function attach(server) {
  const wss = new WebSocketServer({ server, path: '/live', maxPayload: 1024 });

  wss.on('connection', ws => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});
    const snap = registry.get();
    if (snap) safeSend(ws, { type: 'snapshot', data: snap });
  });

  const unsubscribe = registry.subscribe(snap => {
    const payload = JSON.stringify({ type: 'snapshot', data: snap });
    for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(payload);
  });

  /* Drop half-open connections so a mobile network change doesn't leak sockets. */
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, 30000);

  return {
    wss,
    close() { clearInterval(heartbeat); unsubscribe(); wss.close(); }
  };
}

function safeSend(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

module.exports = { attach };
