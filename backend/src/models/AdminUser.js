'use strict';
const bcrypt = require('bcryptjs');
const { mongoose } = require('../db');

const AdminUserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  name: { type: String, default: '' },
  role: { type: String, enum: ['admin', 'viewer'], default: 'admin' },
  lastLoginAt: { type: Date, default: null },
  active: { type: Boolean, default: true }
}, { timestamps: true, versionKey: false });

AdminUserSchema.statics.hash = pw => bcrypt.hash(pw, 12);
AdminUserSchema.methods.verify = function (pw) {
  return bcrypt.compare(pw, this.passwordHash);
};

module.exports = mongoose.model('AdminUser', AdminUserSchema);
