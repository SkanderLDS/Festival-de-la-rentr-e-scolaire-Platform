'use strict';
const http = require('http');
const { config, assertBootConfig, assertProductionConfig } = require('./config');
const db = require('./db');
const { build } = require('./app');
const registry = require('./services/registry');
const realtime = require('./realtime');
const mailer = require('./services/mailer');
const expiry = require('./jobs/expiry');
const { machine } = require('os');

let server, rt, expiryTask;

async function main() {
  assertBootConfig();
  assertProductionConfig();

  await db.connect();
  await registry.init();
  await mailer.verify().catch(e => console.error('[mail] verify failed:', e.message));

  const app = build();
  server = http.createServer(app);
  rt = realtime.attach(server);
  expiryTask = expiry.start();

  /* 10 000 people hitting refresh at once means many idle-ish sockets.
     Keep them alive a little longer than the proxy does. */
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;

  await new Promise(res => server.listen(config.port, res));
  console.log(`[server] FIESTADREAM API on :${config.port} (${config.env})`);
  if (config.edition.opensAt) {
    console.log(`[server] registration opens ${config.edition.opensAt.toISOString()}`);
  }
}

async function shutdown(signal) {
  console.log(`\n[server] ${signal} — shutting down`);
  try {
    expiryTask?.stop();
    rt?.close();
    await new Promise(res => (server ? server.close(res) : res()));
    await db.disconnect();
    console.log('[server] closed cleanly');
    process.exit(0);
  } catch (e) {
    console.error('[server] unclean shutdown:', e.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException', e => { console.error('[uncaughtException]', e); shutdown('uncaughtException'); });

main().catch(e => {
  /* A configuration mistake gets a sentence a human can act on. Anything
     else keeps its full stack trace, which is what you want for a real bug. */
  if (e && e.boot) {
    console.error('\n[server] cannot start\n\n  ' + e.message + '\n');
  } else {
    console.error('[server] failed to start:', e);
  }
  process.exit(1);
});
