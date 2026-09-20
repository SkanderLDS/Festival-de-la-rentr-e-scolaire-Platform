'use strict';
const mongoose = require('mongoose');
const { config } = require('./config');

mongoose.set('strictQuery', true);

async function connect() {
  mongoose.connection.on('connected',    () => console.log('[db] connected'));
  mongoose.connection.on('disconnected', () => console.warn('[db] disconnected'));
  mongoose.connection.on('error',        e  => console.error('[db] error:', e.message));

  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: 8000,
    maxPoolSize: 25,          // the write path is short; reads are served from cache
    minPoolSize: 5
  });
  return mongoose.connection;
}

async function disconnect() {
  await mongoose.connection.close(false);
}

module.exports = { connect, disconnect, mongoose };
