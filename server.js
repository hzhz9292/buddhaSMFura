require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
let firebaseAdmin = null;

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
function ensureDir(dir) {
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) fs.unlinkSync(dir);
  fs.mkdirSync(dir, { recursive: true });
}
ensureDir(DATA_DIR); ensureDir(UPLOADS_DIR);
const DB_PATH = path.join(DATA_DIR, 'db.json');

function now(){ return Date.now(); }
function id(prefix){ return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`; }
function hashPassword(p){ return bcrypt.hashSync(String(p), 10); }
function checkPassword(p,h){ return bcrypt.compareSync(String(p), h); }

function defaultDb(){ return { users:[], sessions:[], chats:[], members:[], messages:[], events:[], fcmTokens:[], hiddenChats:[], deletedMessages:[] }; }
function readDb(){
  if (!fs.existsSync(DB_PATH)) return defaultDb();
  try { return Object.assign(defaultDb(), JSON.parse(fs.readFileSync(DB_PATH,'utf8'))); } catch(e){ return defaultDb(); }
}
function writeDb(db){ ensureDir(DATA_DIR); fs.writeFileSync(DB_PATH, JSON.stringify(db,null,2)); }
function addEvent(db, type, payload){ db.events.push({ id:id('evt'), type, payload, ts: now() }); if(db.events.length>10000) db.events=db.events.slice(-8000); }
function publicUser(u){ return u ? { id:u.id, username:u.username, displayName:u.displayName||u.username, isAdmin:!!u.isAdmin, updatedAt:u.updatedAt||u.createdAt||0 } : null; }
function initDb(){
  const db = readDb();
  const adminName = process.env.ADMIN_USERNAME || 'Buddha';
  if(!db.users.some(u=>u.username.toLowerCase()===adminName.toLowerCase())){
    const u={ id:id('user'), username:adminName, displayName:process.env.ADMIN_DISPLAY_NAME||adminName, passwordHash:hashPassword(process.env.ADMIN_PASSWORD||'61'), isAdmin:true, createdAt:now(), updatedAt:now() };
    db.users.push(u); addEvent(db,'user:upsert',{ user:publicUser(u) });
  }
  if(!db.users.some(u=>u.username.toLowerCase()==='user2')){
    const u={ id:id('user'), username:'user2', displayName:'User 2', passwordHash:hashPassword('123456'), isAdmin:false, createdAt:now(), updatedAt:now() };
    db.users.push(u); addEvent(db,'user:upsert',{ user:publicUser(u) });
  }
  writeDb(db);
}
initDb();

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    firebaseAdmin = require('firebase-admin');
    firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(serviceAccount) });
    console.log('Firebase admin initialized');
  } else console.log('Firebase service account not configured: push disabled');
} catch(e){ console.error('Firebase init failed:', e.message); firebaseAdmin=null; }

function auth(req,res,next){
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i,'').trim();
  if(!token) return res.status(401).json({error:'NO_TOKEN'});
  const db = readDb();
  const sess = db.sessions.find(s=>s.token===token);
  if(!sess) return res.status(401).json({error:'BAD_TOKEN'});
  const user = db.users.find(u=>u.id===sess.userId);
  if(!user) return res.status(401).json({error:'NO_USER'});
  req.db=db; req.user=user; req.token=token; next();
}
function chatForPair(db,a,b){
  const my = db.members.filter(m=>m.userId===a).map(m=>m.chatId);
  return my.find(chatId => db.members.some(m=>m.chatId===chatId && m.userId===b));
}
function userChats(db,userId){ return db.members.filter(m=>m.userId===userId).map(m=>m.chatId); }
function isMember(db,chatId,userId){ return db.members.some(m=>m.chatId===chatId && m.userId===userId); }
function sanitizeChat(db, chat, forUserId){
  const members = db.members.filter(m=>m.chatId===chat.id).map(m=>m.userId);
  const otherId = members.find(x=>x!==forUserId) || members[0];
  const last = db.messages.filter(m=>m.chatId===chat.id && !isMessageHidden(db,m.id,forUserId)).sort((a,b)=>b.createdAt-a.createdAt)[0] || null;
  const unread = db.messages.filter(m=>m.chatId===chat.id && m.senderId!==forUserId && !m.readBy?.includes(forUserId) && !isMessageHidden(db,m.id,forUserId)).length;
  return { id:chat.id, type:chat.type||'direct', otherUserId:otherId, updatedAt:chat.updatedAt||chat.createdAt, createdAt:chat.createdAt, lastMessage:last?sanitizeMsg(db,last,forUserId):null, unread };
}
function isMessageHidden(db,msgId,userId){ return db.deletedMessages.some(x=>x.messageId===msgId && x.userId===userId); }
function sanitizeMsg(db,m,forUserId){
  if(isMessageHidden(db,m.id,forUserId)) return null;
  return { id:m.id, chatId:m.chatId, senderId:m.senderId, text:m.deletedForAll?'Сообщение удалено':m.text, deletedForAll:!!m.deletedForAll, createdAt:m.createdAt, updatedAt:m.updatedAt||m.createdAt, clientId:m.clientId||null, readBy:m.readBy||[] };
}
async function sendPushToUser(db, userId, title, body, data){
  if(!firebaseAdmin) return;
  const tokens = [...new Set(db.fcmTokens.filter(t=>t.userId===userId).map(t=>t.token))];
  if(!tokens.length) return;
  for(const token of tokens){
    try{
      await firebaseAdmin.messaging().send({ token, notification:{title,body}, data: Object.fromEntries(Object.entries(data||{}).map(([k,v])=>[k,String(v)])), android:{ priority:'high', notification:{ channelId:'messages', sound:'default' } } });
    } catch(e){ console.error('Push error', e.message); }
  }
}

app.get('/api/health',(req,res)=>res.json({ok:true, version:'v5-sync', time:now(), firebase:!!firebaseAdmin}));
app.post('/api/register',(req,res)=>{
  const { username, password, displayName, inviteCode } = req.body || {};
  if((process.env.INVITE_CODE||'FAMILY2026') !== String(inviteCode||'')) return res.status(403).json({error:'BAD_INVITE'});
  if(!username || !password) return res.status(400).json({error:'USERNAME_PASSWORD_REQUIRED'});
  const db=readDb();
  if(db.users.some(u=>u.username.toLowerCase()===String(username).toLowerCase())) return res.status(409).json({error:'USERNAME_EXISTS'});
  const u={id:id('user'), username:String(username).trim(), displayName:String(displayName||username).trim(), passwordHash:hashPassword(password), isAdmin:false, createdAt:now(), updatedAt:now()};
  db.users.push(u); addEvent(db,'user:upsert',{user:publicUser(u)}); writeDb(db);
  res.json({ok:true, user:publicUser(u)});
});
app.post('/api/login',(req,res)=>{
  const { username, password } = req.body || {}; const db=readDb();
  const u=db.users.find(x=>x.username.toLowerCase()===String(username||'').toLowerCase());
  if(!u || !checkPassword(password||'',u.passwordHash)) return res.status(401).json({error:'BAD_LOGIN'});
  const token=id('tok'); db.sessions.push({token,userId:u.id,createdAt:now()}); writeDb(db);
  res.json({ok:true, token, user:publicUser(u)});
});
app.get('/api/me', auth, (req,res)=>res.json({ok:true, user:publicUser(req.user)}));
app.post('/api/fcm-token', auth, (req,res)=>{
  const { token } = req.body || {}; if(!token) return res.status(400).json({error:'NO_TOKEN'});
  const db=req.db; db.fcmTokens=db.fcmTokens.filter(t=>!(t.userId===req.user.id && t.token===token)); db.fcmTokens.push({userId:req.user.id, token, updatedAt:now()}); writeDb(db); res.json({ok:true});
});
app.get('/api/users/search', auth, (req,res)=>{
  const q=String(req.query.q||'').toLowerCase();
  const users=req.db.users.filter(u=>u.id!==req.user.id && (u.username.toLowerCase().includes(q) || (u.displayName||'').toLowerCase().includes(q))).slice(0,20).map(publicUser);
  res.json({ok:true, users});
});
app.post('/api/chats/direct', auth, (req,res)=>{
  const otherId=req.body.userId; const db=req.db; const other=db.users.find(u=>u.id===otherId); if(!other) return res.status(404).json({error:'NO_USER'});
  let chatId=chatForPair(db, req.user.id, otherId);
  if(!chatId){ const chat={id:id('chat'), type:'direct', createdAt:now(), updatedAt:now()}; db.chats.push(chat); db.members.push({chatId:chat.id,userId:req.user.id},{chatId:chat.id,userId:otherId}); chatId=chat.id; addEvent(db,'chat:upsert',{chatId:chat.id, userIds:[req.user.id, otherId]}); }
  db.hiddenChats=db.hiddenChats.filter(h=>!(h.chatId===chatId && h.userId===req.user.id)); writeDb(db); res.json({ok:true, chat:sanitizeChat(db, db.chats.find(c=>c.id===chatId), req.user.id)});
});
app.get('/api/chats', auth, (req,res)=>{
  const hidden=new Set(req.db.hiddenChats.filter(h=>h.userId===req.user.id).map(h=>h.chatId));
  const chats=req.db.chats.filter(c=>isMember(req.db,c.id,req.user.id) && !hidden.has(c.id)).map(c=>sanitizeChat(req.db,c,req.user.id)).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  res.json({ok:true, chats});
});
app.get('/api/chats/:chatId/messages', auth, (req,res)=>{
  const chatId=req.params.chatId; if(!isMember(req.db,chatId,req.user.id)) return res.status(403).json({error:'NO_ACCESS'});
  const msgs=req.db.messages.filter(m=>m.chatId===chatId).map(m=>sanitizeMsg(req.db,m,req.user.id)).filter(Boolean).sort((a,b)=>a.createdAt-b.createdAt);
  res.json({ok:true, messages:msgs});
});
app.post('/api/chats/:chatId/messages', auth, async (req,res)=>{
  const chatId=req.params.chatId; const db=req.db; if(!isMember(db,chatId,req.user.id)) return res.status(403).json({error:'NO_ACCESS'});
  const text=String(req.body.text||'').trim(); if(!text) return res.status(400).json({error:'EMPTY'});
  const msg={id:id('msg'), chatId, senderId:req.user.id, text, clientId:req.body.clientId||null, createdAt:now(), updatedAt:now(), readBy:[req.user.id]};
  db.messages.push(msg); const chat=db.chats.find(c=>c.id===chatId); chat.updatedAt=msg.createdAt;
  addEvent(db,'message:new',{message:msg, chatId, userIds:db.members.filter(m=>m.chatId===chatId).map(m=>m.userId)}); writeDb(db);
  for(const m of db.members.filter(m=>m.chatId===chatId && m.userId!==req.user.id)) await sendPushToUser(db,m.userId,req.user.displayName||req.user.username,text,{type:'message', chatId, messageId:msg.id});
  res.json({ok:true, message:sanitizeMsg(db,msg,req.user.id)});
});
app.post('/api/chats/:chatId/read', auth, (req,res)=>{
  const chatId=req.params.chatId; const db=req.db; if(!isMember(db,chatId,req.user.id)) return res.status(403).json({error:'NO_ACCESS'});
  for(const m of db.messages.filter(m=>m.chatId===chatId)){ if(!m.readBy) m.readBy=[]; if(!m.readBy.includes(req.user.id)) m.readBy.push(req.user.id); }
  addEvent(db,'chat:read',{chatId,userId:req.user.id,ts:now()}); writeDb(db); res.json({ok:true});
});
app.delete('/api/messages/:id', auth, (req,res)=>{
  const db=req.db; const msg=db.messages.find(m=>m.id===req.params.id); if(!msg) return res.status(404).json({error:'NO_MESSAGE'}); if(!isMember(db,msg.chatId,req.user.id)) return res.status(403).json({error:'NO_ACCESS'});
  const mode=String(req.query.mode||'me');
  if(mode==='all' && msg.senderId===req.user.id){ msg.deletedForAll=true; msg.text=''; msg.updatedAt=now(); addEvent(db,'message:delete_all',{messageId:msg.id,chatId:msg.chatId,ts:now()}); }
  else { if(!db.deletedMessages.some(x=>x.messageId===msg.id && x.userId===req.user.id)) db.deletedMessages.push({messageId:msg.id,userId:req.user.id,ts:now()}); addEvent(db,'message:delete_me',{messageId:msg.id,chatId:msg.chatId,userId:req.user.id,ts:now()}); }
  writeDb(db); res.json({ok:true});
});
app.delete('/api/chats/:chatId', auth, (req,res)=>{
  const db=req.db; const chatId=req.params.chatId; if(!isMember(db,chatId,req.user.id)) return res.status(403).json({error:'NO_ACCESS'});
  const mode=String(req.query.mode||'me');
  if(mode==='all') { db.chats=db.chats.filter(c=>c.id!==chatId); db.members=db.members.filter(m=>m.chatId!==chatId); db.messages=db.messages.filter(m=>m.chatId!==chatId); addEvent(db,'chat:delete_all',{chatId,ts:now()}); }
  else if(mode==='clear') { for(const m of db.messages.filter(m=>m.chatId===chatId)){ if(!db.deletedMessages.some(x=>x.messageId===m.id && x.userId===req.user.id)) db.deletedMessages.push({messageId:m.id,userId:req.user.id,ts:now()}); } addEvent(db,'chat:clear_me',{chatId,userId:req.user.id,ts:now()}); }
  else { if(!db.hiddenChats.some(h=>h.chatId===chatId && h.userId===req.user.id)) db.hiddenChats.push({chatId,userId:req.user.id,ts:now()}); addEvent(db,'chat:hide_me',{chatId,userId:req.user.id,ts:now()}); }
  writeDb(db); res.json({ok:true});
});
app.get('/api/sync', auth, (req,res)=>{
  const since=Number(req.query.since||0); const db=req.db; const myChatIds=new Set(userChats(db,req.user.id));
  const relevantEvents=db.events.filter(e=>e.ts>since).filter(e=>{
    const p=e.payload||{};
    if(p.userIds) return p.userIds.includes(req.user.id);
    if(p.userId) return p.userId===req.user.id;
    if(p.chatId) return myChatIds.has(p.chatId);
    if(e.type.startsWith('user:')) return true;
    return false;
  });
  const hidden=new Set(db.hiddenChats.filter(h=>h.userId===req.user.id).map(h=>h.chatId));
  const chats=db.chats.filter(c=>isMember(db,c.id,req.user.id) && !hidden.has(c.id)).map(c=>sanitizeChat(db,c,req.user.id));
  const chatIds=new Set(chats.map(c=>c.id));
  const messages=db.messages.filter(m=>chatIds.has(m.chatId) && (m.createdAt>since || (m.updatedAt||0)>since)).map(m=>sanitizeMsg(db,m,req.user.id)).filter(Boolean);
  const users=db.users.filter(u=>(u.updatedAt||u.createdAt||0)>since || true).map(publicUser);
  res.json({ok:true, serverTime:now(), events:relevantEvents, chats, messages, users});
});

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log('Buddha Chat server v5 listening on '+PORT));
