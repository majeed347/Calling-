const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ---------- PERSISTENT STORE ----------
const DB_FILE = path.join(__dirname, 'db.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      admin: { username: 'admin', passwordHash: bcrypt.hashSync('admin123', 8) },
      users: {}  // number -> { number, name, passwordHash, status: 'pending'|'approved'|'rejected', createdAt }
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let db = loadDB();

// ---------- ONLINE SESSIONS ----------
// number -> socketId
const online = {};

function broadcastOnline() {
  const list = Object.entries(online).map(([number, socketId]) => ({
    number,
    name: db.users[number]?.name || 'User ' + number
  }));
  io.emit('online-users', list);
}

function broadcastPending() {
  const pending = Object.values(db.users).filter(u => u.status === 'pending')
    .map(u => ({ number: u.number, name: u.name, createdAt: u.createdAt }));
  io.emit('pending-users', pending);
}

function numberBySocket(socketId) {
  for (const n in online) if (online[n] === socketId) return n;
  return null;
}

// ---------- SOCKET HANDLERS ----------
io.on('connection', (socket) => {
  // --- SIGNUP ---
  socket.on('signup', ({ number, name, password }, cb) => {
    number = (number || '').trim();
    name = (name || '').trim();
    password = password || '';

    if (!/^\d{3,6}$/.test(number)) return cb({ ok: false, error: 'Number must be 3-6 digits' });
    if (!name || name.length < 2) return cb({ ok: false, error: 'Name must be at least 2 chars' });
    if (password.length < 4) return cb({ ok: false, error: 'Password must be at least 4 chars' });
    if (db.users[number]) return cb({ ok: false, error: 'This number is already registered' });

    db.users[number] = {
      number,
      name,
      passwordHash: bcrypt.hashSync(password, 8),
      status: 'pending',
      createdAt: Date.now()
    };
    saveDB(db);
    broadcastPending();
    cb({ ok: true, message: 'Request sent. Wait for admin approval.' });
  });

  // --- USER LOGIN ---
  socket.on('login', ({ number, password }, cb) => {
    number = (number || '').trim();
    const u = db.users[number];
    if (!u) return cb({ ok: false, error: 'Number not registered' });
    if (u.status === 'pending') return cb({ ok: false, error: 'Still waiting for admin approval' });
    if (u.status === 'rejected') return cb({ ok: false, error: 'Your registration was rejected' });
    if (!bcrypt.compareSync(password || '', u.passwordHash)) return cb({ ok: false, error: 'Wrong password' });

    if (online[number]) return cb({ ok: false, error: 'This number is already logged in elsewhere' });

    online[number] = socket.id;
    socket.data.number = number;
    socket.data.role = 'user';
    broadcastOnline();
    cb({ ok: true, number: u.number, name: u.name });
  });

  // --- ADMIN LOGIN ---
  socket.on('admin-login', ({ username, password }, cb) => {
    if (username !== db.admin.username || !bcrypt.compareSync(password || '', db.admin.passwordHash)) {
      return cb({ ok: false, error: 'Invalid admin credentials' });
    }
    socket.data.role = 'admin';
    const pending = Object.values(db.users).filter(u => u.status === 'pending')
      .map(u => ({ number: u.number, name: u.name, createdAt: u.createdAt }));
    const approved = Object.values(db.users).filter(u => u.status === 'approved')
      .map(u => ({ number: u.number, name: u.name }));
    const rejected = Object.values(db.users).filter(u => u.status === 'rejected')
      .map(u => ({ number: u.number, name: u.name }));
    cb({ ok: true, pending, approved, rejected });
  });

  socket.on('admin-approve', ({ number }) => {
    if (socket.data.role !== 'admin') return;
    if (db.users[number]) {
      db.users[number].status = 'approved';
      saveDB(db);
      broadcastPending();
      io.emit('user-approved', { number });
      socket.emit('admin-refresh');
    }
  });

  socket.on('admin-reject', ({ number }) => {
    if (socket.data.role !== 'admin') return;
    if (db.users[number]) {
      db.users[number].status = 'rejected';
      saveDB(db);
      broadcastPending();
      socket.emit('admin-refresh');
    }
  });

  // --- CALL FLOW ---
  socket.on('call-user', ({ to }, cb) => {
    const fromNumber = socket.data.number;
    if (!fromNumber) return cb({ ok: false, error: 'Not logged in' });
    if (!online[to]) return cb({ ok: false, error: 'Number not online' });
    if (to === fromNumber) return cb({ ok: false, error: "Can't call yourself" });

    io.to(online[to]).emit('incoming-call', {
      from: fromNumber,
      fromName: db.users[fromNumber].name
    });
    cb({ ok: true });
  });

  socket.on('accept-call', ({ to }) => {
    if (online[to]) {
      io.to(online[to]).emit('call-accepted', { by: socket.data.number });
      io.to(socket.id).emit('call-accepted', { by: socket.data.number });
    }
  });

  socket.on('decline-call', ({ to }) => {
    if (online[to]) io.to(online[to]).emit('call-declined', { by: socket.data.number });
  });

  socket.on('offer', ({ to, offer }) => {
    if (online[to]) io.to(online[to]).emit('offer', { from: socket.data.number, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    if (online[to]) io.to(online[to]).emit('answer', { from: socket.data.number, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    if (online[to]) io.to(online[to]).emit('ice-candidate', { from: socket.data.number, candidate });
  });

  socket.on('hangup', ({ to }) => {
    if (online[to]) io.to(online[to]).emit('call-ended', { by: socket.data.number });
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    const n = numberBySocket(socket.id);
    if (n) {
      delete online[n];
      broadcastOnline();
    }
  });
});

// Admin needs a refresh hook
io.on('connection', (socket) => {
  socket.on('admin-refresh', () => {
    if (socket.data.role !== 'admin') return;
    const pending = Object.values(db.users).filter(u => u.status === 'pending')
      .map(u => ({ number: u.number, name: u.name, createdAt: u.createdAt }));
    const approved = Object.values(db.users).filter(u => u.status === 'approved')
      .map(u => ({ number: u.number, name: u.name }));
    const rejected = Object.values(db.users).filter(u => u.status === 'rejected')
      .map(u => ({ number: u.number, name: u.name }));
    socket.emit('admin-data', { pending, approved, rejected });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server running at http://localhost:' + PORT);
  console.log('Admin login → username: admin  password: admin123');
});
