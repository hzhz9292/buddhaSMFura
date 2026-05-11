require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
let admin = null;

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const INVITE_CODE = process.env.INVITE_CODE || 'FAMILY2026';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function now() { return Date.now(); }
function id(prefix='id') { return prefix + '_' + crypto.randomBytes(10).toString('hex'); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(test));
}
function readDb() {
  const raw = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH, 'utf8') : '{}';
  const db = JSON.parse(raw || '{}');
  for (const key of ['users','sessions','chats','messages','fcmTokens','hiddenChats','deletedMessages','presence']) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
  return db;
}
function writeDb(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, displayName: u.displayName || u.username, createdAt: u.createdAt, isAdmin: !!u.isAdmin };
}
function initDb() {
  const db = readDb();
  if (!db.users.some(u => u.username.toLowerCase() === (process.env.ADMIN_USERNAME || 'Buddha').toLowerCase())) {
    db.users.push({
      id: id('user'),
      username: process.env.ADMIN_USERNAME || 'Buddha',
      displayName: process.env.ADMIN_DISPLAY_NAME || 'Buddha',
      passwordHash: hashPassword(process.env.ADMIN_PASSWORD || '61'),
      isAdmin: true,
      createdAt: now()
    });
  }
  if (!db.users.some(u => u.username.toLowerCase() === 'user2')) {
    db.users.push({
      id: id('user'), username: 'user2', displayName: 'User 2', passwordHash: hashPassword('123456'), isAdmin: false, createdAt: now()
    });
  }
  writeDb(db);
}
function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) { console.log('FCM disabled: FIREBASE_SERVICE_ACCOUNT_JSON is empty'); return; }
  try {
    const serviceAccount = JSON.parse(raw);
    admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('FCM enabled');
  } catch (e) {
    console.error('FCM init failed:', e.message);
  }
}
function getAuth(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const db = readDb();
  const session = db.sessions.find(s => s.token === token && s.expiresAt > now());
  if (!session) return null;
  const user = db.users.find(u => u.id === session.userId);
  if (!user) return null;
  return { db, user, session, token };
}
function requireAuth(req, res, next) {
  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  req.auth = auth;
  next();
}
function findOrCreateChat(db, a, b) {
  const ids = [a,b].sort();
  let chat = db.chats.find(c => c.memberIds.length === 2 && ids.every(x => c.memberIds.includes(x)));
  if (!chat) {
    chat = { id: id('chat'), memberIds: ids, createdAt: now(), updatedAt: now(), deletedForAll: false };
    db.chats.push(chat);
  }
  return chat;
}
function isHidden(db, chatId, userId) { return db.hiddenChats.some(h => h.chatId === chatId && h.userId === userId); }
function markVisible(db, chatId, userId) { db.hiddenChats = db.hiddenChats.filter(h => !(h.chatId === chatId && h.userId === userId)); }
function messageVisible(db, msg, userId) {
  if (msg.deletedForAll) return false;
  return !db.deletedMessages.some(d => d.messageId === msg.id && d.userId === userId);
}
function getChatSummary(db, chat, userId) {
  const otherId = chat.memberIds.find(x => x !== userId);
  const other = db.users.find(u => u.id === otherId);
  const messages = db.messages.filter(m => m.chatId === chat.id && messageVisible(db, m, userId)).sort((a,b)=>a.createdAt-b.createdAt);
  const last = messages[messages.length - 1] || null;
  const unread = messages.filter(m => m.senderId !== userId && !m.readBy?.includes(userId)).length;
  const p = db.presence.find(p => p.userId === otherId);
  const online = p && now() - p.lastSeen < 12000;
  return { id: chat.id, other: publicUser(other), lastMessage: last, unread, updatedAt: chat.updatedAt, online, activeChat: p?.activeChatId || null };
}
async function sendFcmToUser(db, toUserId, payload) {
  if (!admin) return { ok: false, reason: 'fcm_disabled' };
  const tokens = db.fcmTokens.filter(t => t.userId === toUserId).map(t => t.token);
  if (!tokens.length) return { ok: false, reason: 'no_tokens' };
  try {
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: payload.notification,
      data: payload.data || {},
      android: {
        priority: 'high',
        notification: { channelId: 'messages', priority: 'high', defaultSound: true }
      }
    });
    const bad = [];
    response.responses.forEach((r, i) => { if (!r.success) bad.push(tokens[i]); });
    if (bad.length) {
      const fresh = readDb();
      fresh.fcmTokens = fresh.fcmTokens.filter(t => !bad.includes(t.token));
      writeDb(fresh);
    }
    return { ok: true, successCount: response.successCount, failureCount: response.failureCount };
  } catch(e) {
    console.error('FCM send error:', e.message);
    return { ok: false, reason: e.message };
  }
}

initDb();
initFirebase();

app.get('/health', (req,res)=>res.json({ok:true, time:now()}));

app.post('/api/auth/login', (req,res) => {
  const { username, password } = req.body || {};
  const db = readDb();
  const user = db.users.find(u => u.username.toLowerCase() === String(username||'').toLowerCase());
  if (!user || !verifyPassword(String(password||''), user.passwordHash)) return res.status(401).json({ error: 'bad_login' });
  const token = id('tok');
  db.sessions.push({ token, userId: user.id, createdAt: now(), expiresAt: now() + 1000*60*60*24*60 });
  writeDb(db);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/auth/register', (req,res) => {
  const { username, password, displayName, inviteCode } = req.body || {};
  const u = String(username||'').trim();
  if (inviteCode !== INVITE_CODE) return res.status(403).json({ error: 'bad_invite_code' });
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(u)) return res.status(400).json({ error: 'bad_username' });
  if (String(password||'').length < 4) return res.status(400).json({ error: 'bad_password' });
  const db = readDb();
  if (db.users.some(x => x.username.toLowerCase() === u.toLowerCase())) return res.status(409).json({ error: 'username_taken' });
  const user = { id: id('user'), username: u, displayName: String(displayName||u).trim().slice(0,40), passwordHash: hashPassword(String(password)), isAdmin:false, createdAt: now() };
  db.users.push(user);
  const token = id('tok'); db.sessions.push({ token, userId: user.id, createdAt: now(), expiresAt: now() + 1000*60*60*24*60 });
  writeDb(db);
  res.json({ token, user: publicUser(user) });
});

app.get('/api/me', requireAuth, (req,res)=>res.json({ user: publicUser(req.auth.user) }));

app.post('/api/presence', requireAuth, (req,res) => {
  const { activeChatId = null, screen = 'app' } = req.body || {};
  const db = req.auth.db;
  db.presence = db.presence.filter(p => p.userId !== req.auth.user.id);
  db.presence.push({ userId: req.auth.user.id, activeChatId, screen, lastSeen: now() });
  writeDb(db);
  res.json({ ok:true });
});

app.post('/api/push/fcm-token', requireAuth, (req,res) => {
  const { token, device = 'android' } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token_required' });
  const db = req.auth.db;
  db.fcmTokens = db.fcmTokens.filter(t => t.token !== token);
  db.fcmTokens.push({ userId: req.auth.user.id, token, device, updatedAt: now() });
  writeDb(db);
  res.json({ ok:true, fcmEnabled: !!admin });
});

app.get('/api/search', requireAuth, (req,res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ users: [] });
  const users = req.auth.db.users
    .filter(u => u.id !== req.auth.user.id && (u.username.toLowerCase().includes(q) || (u.displayName||'').toLowerCase().includes(q)))
    .slice(0,20).map(publicUser);
  res.json({ users });
});

app.post('/api/chats/open', requireAuth, (req,res) => {
  const { username } = req.body || {};
  const db = req.auth.db;
  const other = db.users.find(u => u.username.toLowerCase() === String(username||'').toLowerCase());
  if (!other || other.id === req.auth.user.id) return res.status(404).json({ error: 'user_not_found' });
  const chat = findOrCreateChat(db, req.auth.user.id, other.id);
  markVisible(db, chat.id, req.auth.user.id);
  chat.updatedAt = now();
  writeDb(db);
  res.json({ chat: getChatSummary(db, chat, req.auth.user.id) });
});

app.get('/api/chats', requireAuth, (req,res) => {
  const db = req.auth.db;
  const chats = db.chats.filter(c => c.memberIds.includes(req.auth.user.id) && !c.deletedForAll && !isHidden(db, c.id, req.auth.user.id))
    .map(c => getChatSummary(db, c, req.auth.user.id)).sort((a,b)=>b.updatedAt-a.updatedAt);
  res.json({ chats });
});

app.get('/api/chats/:chatId/messages', requireAuth, (req,res) => {
  const db = req.auth.db;
  const chat = db.chats.find(c => c.id === req.params.chatId && c.memberIds.includes(req.auth.user.id) && !c.deletedForAll);
  if (!chat) return res.status(404).json({ error: 'chat_not_found' });
  const afterId = Number(req.query.afterId || 0);
  const messages = db.messages.filter(m => m.chatId === chat.id && m.seq > afterId && messageVisible(db, m, req.auth.user.id)).sort((a,b)=>a.seq-b.seq);
  for (const m of db.messages) {
    if (m.chatId === chat.id && m.senderId !== req.auth.user.id) {
      if (!Array.isArray(m.readBy)) m.readBy = [];
      if (!m.readBy.includes(req.auth.user.id)) m.readBy.push(req.auth.user.id);
    }
  }
  writeDb(db);
  res.json({ messages });
});

app.post('/api/chats/:chatId/messages', requireAuth, async (req,res) => {
  const { text } = req.body || {};
  const clean = String(text||'').trim();
  if (!clean) return res.status(400).json({ error: 'empty_message' });
  const db = req.auth.db;
  const chat = db.chats.find(c => c.id === req.params.chatId && c.memberIds.includes(req.auth.user.id) && !c.deletedForAll);
  if (!chat) return res.status(404).json({ error: 'chat_not_found' });
  const maxSeq = db.messages.reduce((m,x)=>Math.max(m, x.seq || 0),0);
  const msg = { id: id('msg'), seq: maxSeq+1, chatId: chat.id, senderId: req.auth.user.id, text: clean, createdAt: now(), readBy: [req.auth.user.id], deletedForAll:false };
  db.messages.push(msg);
  chat.updatedAt = msg.createdAt;
  for (const memberId of chat.memberIds) markVisible(db, chat.id, memberId);
  writeDb(db);
  res.json({ message: msg });

  const recipientId = chat.memberIds.find(x => x !== req.auth.user.id);
  const fresh = readDb();
  const presence = fresh.presence.find(p => p.userId === recipientId);
  const recipientActiveInSameChat = presence && (now() - presence.lastSeen < 10000) && presence.activeChatId === chat.id;
  if (!recipientActiveInSameChat) {
    await sendFcmToUser(fresh, recipientId, {
      notification: { title: publicUser(req.auth.user).displayName, body: clean.length > 80 ? clean.slice(0,77)+'...' : clean },
      data: { type:'message', chatId: chat.id, fromUserId: req.auth.user.id, title: publicUser(req.auth.user).displayName }
    });
  }
});

app.delete('/api/messages/:messageId', requireAuth, (req,res) => {
  const { mode = 'me' } = req.body || {};
  const db = req.auth.db;
  const msg = db.messages.find(m => m.id === req.params.messageId);
  if (!msg) return res.status(404).json({ error:'message_not_found' });
  const chat = db.chats.find(c => c.id === msg.chatId && c.memberIds.includes(req.auth.user.id));
  if (!chat) return res.status(403).json({ error:'forbidden' });
  if (mode === 'all') {
    if (msg.senderId !== req.auth.user.id) return res.status(403).json({ error:'only_sender_can_delete_for_all' });
    msg.deletedForAll = true;
  } else {
    if (!db.deletedMessages.some(d => d.messageId === msg.id && d.userId === req.auth.user.id)) db.deletedMessages.push({ messageId: msg.id, userId: req.auth.user.id, at: now() });
  }
  writeDb(db);
  res.json({ ok:true });
});

app.post('/api/chats/:chatId/delete', requireAuth, (req,res) => {
  const { mode = 'hide' } = req.body || {};
  const db = req.auth.db;
  const chat = db.chats.find(c => c.id === req.params.chatId && c.memberIds.includes(req.auth.user.id));
  if (!chat) return res.status(404).json({ error:'chat_not_found' });
  if (mode === 'all') {
    chat.deletedForAll = true;
    db.messages.forEach(m => { if (m.chatId === chat.id) m.deletedForAll = true; });
  } else if (mode === 'clear') {
    db.messages.filter(m => m.chatId === chat.id).forEach(m => {
      if (!db.deletedMessages.some(d => d.messageId === m.id && d.userId === req.auth.user.id)) db.deletedMessages.push({ messageId:m.id, userId:req.auth.user.id, at:now() });
    });
  } else {
    if (!db.hiddenChats.some(h => h.chatId === chat.id && h.userId === req.auth.user.id)) db.hiddenChats.push({ chatId: chat.id, userId: req.auth.user.id, at: now() });
  }
  writeDb(db);
  res.json({ ok:true });
});

app.listen(PORT, () => console.log(`Buddha Chat Server v4 FCM on :${PORT}`));
