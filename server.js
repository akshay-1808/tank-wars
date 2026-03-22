const http = require('http');
const fs   = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const fp = path.join(__dirname, 'client.html');
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

// ── Constants ──────────────────────────────────────────────────
const MAP_W = 1200, MAP_H = 800;
const TANK_SPEED = 3, BULLET_SPEED = 8;
const TANK_RADIUS = 18, BULLET_RADIUS = 5;
const MAX_HP = 100, RESPAWN_TIME = 3000;
const SPAWN_PROTECTION_MS = 3000;
const GAME_DURATION_MS = 10 * 60 * 1000;
const FIRE_COOLDOWN_NORMAL = 233;
const FIRE_COOLDOWN_RAPID  = 100;
const POWERUP_SPAWN_INTERVAL = 8000;
const MAX_PLAYERS = 5;
const COLORS = ['#FF4444','#44AAFF','#44FF88','#FFB844','#FF44DD'];
const POWERUP_TYPES = ['shield','rapidfire','spread','hp'];
const WALLS = [
  {x:200,y:150,w:80,h:200},{x:450,y:80,w:200,h:60},{x:900,y:150,w:80,h:200},
  {x:150,y:450,w:200,h:60},{x:850,y:450,w:200,h:60},{x:450,y:400,w:60,h:200},
  {x:680,y:400,w:60,h:200},{x:550,y:250,w:100,h:60},{x:200,y:650,w:80,h:100},
  {x:900,y:650,w:80,h:100},{x:500,y:600,w:200,h:60}
];

// ── Lobby store ────────────────────────────────────────────────
const lobbies = {};          // all lobbies keyed by id
const lobbyWatchers = new Set(); // ws connections on the home screen watching lobby list

function generateLobbyId() {
  let id;
  do { id = Math.floor(1000 + Math.random() * 9000).toString(); }
  while (lobbies[id]);
  return id;
}
function uid() { return Math.random().toString(36).substr(2, 8); }

// ── Public lobby helpers ───────────────────────────────────────
// Find a public waiting lobby with space, or create one
function getOrCreatePublicLobby(name) {
  // Find waiting public lobby with room
  const available = Object.values(lobbies).find(l =>
    l.isPublic &&
    l.state === 'waiting' &&
    Object.keys(l.players).length < MAX_PLAYERS
  );
  if (available) return available;

  // Create new public lobby
  const lid = generateLobbyId();
  lobbies[lid] = makeLobby(lid, null, true); // null adminId — set on first join
  console.log(`[Public Lobby ${lid}] Auto-created`);
  return lobbies[lid];
}

function makeLobby(id, adminId, isPublic) {
  return {
    id, adminId, isPublic: !!isPublic,
    state: 'waiting',
    players: {}, bullets: [], powerups: [],
    nextBullet: 0, nextPU: 0, timers: [],
    gameEndTime: 0,
    createdAt: Date.now()
  };
}

// Broadcast public lobby list to all watchers
function broadcastLobbyBrowser() {
  const list = buildLobbyList();
  const msg = JSON.stringify({ type: 'lobby_browser', lobbies: list });
  lobbyWatchers.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function buildLobbyList() {
  return Object.values(lobbies)
    .filter(l => l.isPublic)
    .map(l => {
      const players = Object.values(l.players);
      const host = players.find(p => p.isAdmin) || players[0];
      return {
        id: l.id,
        hostName: host ? host.name : 'Empty',
        playerCount: players.length,
        maxPlayers: MAX_PLAYERS,
        state: l.state,
        timeLeft: l.state === 'playing' ? Math.max(0, l.gameEndTime - Date.now()) : null
      };
    })
    .sort((a, b) => {
      // waiting first, then by player count desc
      if (a.state === 'waiting' && b.state !== 'waiting') return -1;
      if (b.state === 'waiting' && a.state !== 'waiting') return 1;
      return b.playerCount - a.playerCount;
    });
}

// ── Helpers ───────────────────────────────────────────────────
function spawnPos() {
  const s = [
    {x:80,y:80},{x:MAP_W-80,y:80},{x:80,y:MAP_H-80},
    {x:MAP_W-80,y:MAP_H-80},{x:MAP_W/2,y:MAP_H/2}
  ];
  return s[Math.floor(Math.random()*s.length)];
}
function rectOverlap(x,y,r,w) {
  return x+r>w.x && x-r<w.x+w.w && y+r>w.y && y-r<w.y+w.h;
}
function collidesWall(x,y,r) { return WALLS.some(w=>rectOverlap(x,y,r,w)); }
function dist(a,b) { return Math.hypot(a.x-b.x,a.y-b.y); }

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function bcast(lobby, data) {
  const msg = JSON.stringify(data);
  Object.values(lobby.players).forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  });
}
function publicPlayers(lobby) {
  return Object.values(lobby.players).map(p => ({
    id:p.id, name:p.name, color:p.color,
    x:p.x, y:p.y, angle:p.angle,
    hp:p.hp, alive:p.alive,
    score:p.score, kills:p.kills, deaths:p.deaths,
    shield:p.shield, rapidfire:p.rapidfire, spread:p.spread,
    moving:p.moving, isAdmin:p.isAdmin, ready:p.ready,
    spawnProtect: p.spawnProtectUntil && Date.now() < p.spawnProtectUntil
  }));
}
function broadcastLobbyState(lobby) {
  bcast(lobby, {
    type:'lobby_update', lobbyId:lobby.id,
    adminId:lobby.adminId, state:lobby.state,
    isPublic:lobby.isPublic,
    players:publicPlayers(lobby)
  });
}

function makePlayerObj(pid, ws, name, color, isAdmin) {
  return {
    id:pid, ws, name, color,
    x:80, y:80, angle:0, hp:MAX_HP, alive:true,
    score:0, kills:0, deaths:0,
    shield:false, rapidfire:false, spread:false,
    rfTimer:0, shieldTimer:0, lastShot:0, moving:false,
    up:false, down:false, left:false, right:false,
    shooting:false, mouseAngle:0,
    isAdmin, ready:false, spawnProtectUntil:0
  };
}

// ── Game lifecycle ─────────────────────────────────────────────
function spawnPU(lobby) {
  const type = POWERUP_TYPES[Math.floor(Math.random()*POWERUP_TYPES.length)];
  let x,y,t=0;
  do { x=60+Math.random()*(MAP_W-120); y=60+Math.random()*(MAP_H-120); t++; }
  while (collidesWall(x,y,20) && t<20);
  lobby.powerups.push({id:lobby.nextPU++,x,y,type});
}

function startGame(lobby) {
  lobby.state = 'playing';
  let ci = 0;
  Object.values(lobby.players).forEach(p => {
    const sp = spawnPos();
    p.x=sp.x; p.y=sp.y; p.angle=0;
    p.hp=MAX_HP; p.alive=true; p.score=0; p.kills=0; p.deaths=0;
    p.shield=false; p.rapidfire=false; p.spread=false;
    p.rfTimer=0; p.shieldTimer=0; p.lastShot=0; p.moving=false;
    p.color=COLORS[ci%COLORS.length]; ci++;
    p.ready=false;
    p.spawnProtectUntil = Date.now() + SPAWN_PROTECTION_MS;
  });
  lobby.bullets=[]; lobby.powerups=[];
  lobby.nextBullet=0; lobby.nextPU=0;
  lobby.gameEndTime = Date.now() + GAME_DURATION_MS;
  spawnPU(lobby); spawnPU(lobby);

  bcast(lobby, {
    type:'game_start', lobbyId:lobby.id,
    players:publicPlayers(lobby),
    walls:WALLS, mapW:MAP_W, mapH:MAP_H,
    gameEndTime:lobby.gameEndTime,
    isPublic:lobby.isPublic
  });

  const t1 = setInterval(() => {
    if (!lobbies[lobby.id] || lobby.state!=='playing') { clearInterval(t1); return; }
    spawnPU(lobby);
  }, POWERUP_SPAWN_INTERVAL);

  const t2 = setInterval(() => {
    if (!lobbies[lobby.id]) { clearInterval(t2); clearInterval(t1); return; }
    if (lobby.state==='playing') tick(lobby);
  }, 1000/60);

  const t3 = setTimeout(() => {
    if (!lobbies[lobby.id] || lobby.state!=='playing') return;
    endGameByTimer(lobby);
  }, GAME_DURATION_MS);

  lobby.timers = [t1, t2, t3];
  broadcastLobbyBrowser(); // update public browser
}

function endGameByTimer(lobby) {
  const sorted = Object.values(lobby.players).sort((a,b)=>b.score-a.score);
  const winner = sorted[0] || null;
  bcast(lobby, {
    type:'game_over',
    winner: winner ? {name:winner.name,color:winner.color,score:winner.score} : null,
    scores: sorted.map(p=>({name:p.name,color:p.color,score:p.score,kills:p.kills,deaths:p.deaths}))
  });
  setTimeout(() => { if (lobbies[lobby.id]) stopGame(lobby); }, 5000);
}

function stopGame(lobby) {
  lobby.state = 'waiting';
  lobby.timers.forEach(t => clearInterval(t));
  lobby.timers = [];
  lobby.bullets = []; lobby.powerups = [];
  Object.values(lobby.players).forEach(p => { p.ready = false; });
  broadcastLobbyState(lobby);
  bcast(lobby, {type:'game_stopped'});
  broadcastLobbyBrowser();
}

function removePlayerFromLobby(lobby, playerId) {
  const p = lobby.players[playerId];
  const wasAdmin = p && p.isAdmin;
  delete lobby.players[playerId];

  if (Object.keys(lobby.players).length === 0) {
    lobby.timers.forEach(t => clearInterval(t));
    delete lobbies[lobby.id];
    console.log(`[Lobby ${lobby.id}] Destroyed (empty)`);
    broadcastLobbyBrowser();
    return;
  }

  if (wasAdmin) {
    const next = Object.values(lobby.players)[0];
    next.isAdmin = true;
    lobby.adminId = next.id;
    if (lobby.state === 'playing') stopGame(lobby);
    else broadcastLobbyState(lobby);
    send(next.ws, {type:'promoted', msg:'You are now the host!'});
  } else {
    broadcastLobbyState(lobby);
  }
  broadcastLobbyBrowser();
}

// ── Game tick ─────────────────────────────────────────────────
function tick(lobby) {
  const now = Date.now();
  const pl  = lobby.players;

  for (const p of Object.values(pl)) {
    if (!p.alive) continue;
    let dx=0, dy=0;
    if(p.up)   dy -= TANK_SPEED;
    if(p.down)  dy += TANK_SPEED;
    if(p.left)  dx -= TANK_SPEED;
    if(p.right) dx += TANK_SPEED;
    if (dx||dy) {
      const len=Math.hypot(dx,dy); dx=dx/len*TANK_SPEED; dy=dy/len*TANK_SPEED;
      const nx=Math.max(TANK_RADIUS,Math.min(MAP_W-TANK_RADIUS,p.x+dx));
      const ny=Math.max(TANK_RADIUS,Math.min(MAP_H-TANK_RADIUS,p.y+dy));
      if (!collidesWall(nx,p.y,TANK_RADIUS)) p.x=nx;
      if (!collidesWall(p.x,ny,TANK_RADIUS)) p.y=ny;
      p.moving=true;
    } else { p.moving=false; }
    p.angle = p.mouseAngle;

    const cd = p.rapidfire ? FIRE_COOLDOWN_RAPID : FIRE_COOLDOWN_NORMAL;
    if (p.shooting && now-p.lastShot>cd) {
      p.lastShot=now;
      const angles = p.spread ? [-0.25,0,0.25] : [0];
      for (const da of angles) {
        const ang = p.angle+da;
        lobby.bullets.push({
          id:lobby.nextBullet++, ownerId:p.id,
          x:p.x+Math.cos(ang)*22, y:p.y+Math.sin(ang)*22,
          vx:Math.cos(ang)*BULLET_SPEED, vy:Math.sin(ang)*BULLET_SPEED,
          color:p.color, life:80
        });
      }
    }
    if (p.shieldTimer && now>p.shieldTimer) { p.shield=false; p.shieldTimer=0; }
    if (p.rfTimer && now>p.rfTimer)         { p.rapidfire=false; p.rfTimer=0; }
  }

  lobby.bullets = lobby.bullets.filter(b => {
    b.x+=b.vx; b.y+=b.vy; b.life--;
    if (b.life<=0||b.x<0||b.x>MAP_W||b.y<0||b.y>MAP_H) return false;
    if (collidesWall(b.x,b.y,BULLET_RADIUS)) return false;
    for (const p of Object.values(pl)) {
      if (!p.alive || p.id===b.ownerId) continue;
      if (dist(b,p) < TANK_RADIUS+BULLET_RADIUS) {
        const protected_ = p.shield || (p.spawnProtectUntil && now<p.spawnProtectUntil);
        if (!protected_) {
          p.hp -= 25;
          if (p.hp<=0) {
            p.hp=0; p.alive=false; p.deaths++;
            const sh=pl[b.ownerId];
            if (sh) { sh.kills++; sh.score+=100; }
            bcast(lobby,{type:'kill_feed',
              killer:sh?sh.name:'?', killerColor:sh?sh.color:'#fff',
              victim:p.name, victimColor:p.color});
            setTimeout(() => {
              if (!lobbies[lobby.id]||!pl[p.id]) return;
              const sp=spawnPos();
              p.x=sp.x; p.y=sp.y; p.hp=MAX_HP; p.alive=true;
              p.shield=false; p.rapidfire=false; p.spread=false;
              p.spawnProtectUntil=Date.now()+SPAWN_PROTECTION_MS;
            }, RESPAWN_TIME);
          }
        }
        return false;
      }
    }
    return true;
  });

  lobby.powerups = lobby.powerups.filter(pu => {
    for (const p of Object.values(pl)) {
      if (!p.alive) continue;
      if (dist(p,pu)<TANK_RADIUS+16) {
        if (pu.type==='hp')        p.hp=Math.min(MAX_HP,p.hp+40);
        if (pu.type==='shield')    { p.shield=true; p.shieldTimer=now+6000; }
        if (pu.type==='rapidfire') { p.rapidfire=true; p.rfTimer=now+6000; }
        if (pu.type==='spread')    { p.spread=true; setTimeout(()=>{if(pl[p.id])p.spread=false;},6000); }
        p.score+=10; return false;
      }
    }
    return true;
  });

  bcast(lobby,{
    type:'state',
    players:publicPlayers(lobby),
    bullets:lobby.bullets.map(b=>({id:b.id,x:b.x,y:b.y,color:b.color})),
    powerups:lobby.powerups.map(pu=>({id:pu.id,x:pu.x,y:pu.y,type:pu.type})),
    timeLeft:Math.max(0,lobby.gameEndTime-Date.now())
  });
}

// ── WebSocket handler ─────────────────────────────────────────
wss.on('connection', (ws) => {
  let myId=null, myLobby=null, watching=false;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      // ── Watch lobby browser (home screen) ──
      if (msg.type==='watch_lobbies') {
        watching=true;
        lobbyWatchers.add(ws);
        send(ws,{type:'lobby_browser',lobbies:buildLobbyList()});
        return;
      }
      if (msg.type==='unwatch_lobbies') {
        watching=false;
        lobbyWatchers.delete(ws);
        return;
      }

      // ── Quick Play (auto-join public lobby) ──
      if (msg.type==='quick_play') {
        const name=(msg.name||'Player').substring(0,12);
        const lobby=getOrCreatePublicLobby(name);
        const pid=uid();
        const ci=Object.keys(lobby.players).length;
        const isFirstPlayer=(ci===0);
        myId=pid; myLobby=lobby.id;

        if (isFirstPlayer) lobby.adminId=pid;

        lobby.players[pid]=makePlayerObj(pid,ws,name,COLORS[ci%COLORS.length],isFirstPlayer);

        lobbyWatchers.delete(ws); watching=false;
        send(ws,{type:'joined',lobbyId:lobby.id,playerId:pid,isAdmin:isFirstPlayer,adminId:lobby.adminId,isPublic:true});
        broadcastLobbyState(lobby);
        broadcastLobbyBrowser();
        console.log(`[Public ${lobby.id}] "${name}" quick-joined (${Object.keys(lobby.players).length}/${MAX_PLAYERS})`);
        return;
      }

      // ── Create private lobby ──
      if (msg.type==='create_lobby') {
        const name=(msg.name||'Host').substring(0,12);
        const lid=generateLobbyId();
        const pid=uid();
        myId=pid; myLobby=lid;
        lobbies[lid]=makeLobby(lid,pid,false);
        lobbies[lid].players[pid]=makePlayerObj(pid,ws,name,COLORS[0],true);
        lobbyWatchers.delete(ws); watching=false;
        send(ws,{type:'created',lobbyId:lid,playerId:pid,isAdmin:true,isPublic:false});
        broadcastLobbyState(lobbies[lid]);
        console.log(`[Private ${lid}] Created by "${name}"`);
        return;
      }

      // ── Join private lobby by ID ──
      if (msg.type==='join_lobby') {
        const lid=String(msg.lobbyId).trim();
        const name=(msg.name||'Player').substring(0,12);
        const lobby=lobbies[lid];
        if (!lobby)                                    { send(ws,{type:'error',msg:'Lobby not found. Check the ID.'}); return; }
        if (lobby.isPublic)                            { send(ws,{type:'error',msg:'That is a public lobby. Use Quick Play instead.'}); return; }
        if (lobby.state==='playing')                   { send(ws,{type:'error',msg:'Game already in progress.'}); return; }
        if (Object.keys(lobby.players).length>=MAX_PLAYERS){ send(ws,{type:'error',msg:'Lobby is full (max 5).'}); return; }
        const pid=uid();
        const ci=Object.keys(lobby.players).length;
        myId=pid; myLobby=lid;
        lobby.players[pid]=makePlayerObj(pid,ws,name,COLORS[ci%COLORS.length],false);
        lobbyWatchers.delete(ws); watching=false;
        send(ws,{type:'joined',lobbyId:lid,playerId:pid,isAdmin:false,adminId:lobby.adminId,isPublic:false});
        broadcastLobbyState(lobby);
        console.log(`[Private ${lid}] "${name}" joined (${Object.keys(lobby.players).length}/${MAX_PLAYERS})`);
        return;
      }

      // ── In-lobby messages ──
      if (!myId||!myLobby) return;
      const lobby=lobbies[myLobby];
      if (!lobby) return;
      const p=lobby.players[myId];
      if (!p) return;

      if (msg.type==='input') {
        p.up=msg.up; p.down=msg.down; p.left=msg.left; p.right=msg.right;
        p.shooting=msg.shooting; p.mouseAngle=msg.angle;
      }
      else if (msg.type==='set_ready') {
        p.ready=!!msg.ready;
        broadcastLobbyState(lobby);

        // Public lobby: auto-start when all players ready AND ≥2
        if (lobby.isPublic && lobby.state==='waiting') {
          const all=Object.values(lobby.players);
          if (all.length>=2 && all.every(pl=>pl.isAdmin||pl.ready)) {
            setTimeout(()=>{ if(lobbies[lobby.id]&&lobby.state==='waiting') startGame(lobby); },1000);
          }
        }
      }
      else if (msg.type==='start_game') {
        if (myId!==lobby.adminId)                          { send(ws,{type:'error',msg:'Only the host can start.'}); return; }
        if (Object.keys(lobby.players).length<2)           { send(ws,{type:'error',msg:'Need at least 2 players.'}); return; }
        startGame(lobby);
      }
      else if (msg.type==='stop_game') {
        if (myId!==lobby.adminId) return;
        stopGame(lobby);
      }
      else if (msg.type==='kick_player') {
        if (myId!==lobby.adminId) return;
        const target=lobby.players[msg.targetId];
        if (target) {
          send(target.ws,{type:'kicked',msg:'Removed by the host.'});
          setTimeout(()=>target.ws.close(),200);
        }
      }
    } catch(e) { console.error('WS error:',e.message); }
  });

  ws.on('close', () => {
    if (watching) { lobbyWatchers.delete(ws); }
    if (!myId||!myLobby) return;
    const lobby=lobbies[myLobby];
    if (!lobby) return;
    console.log(`[Lobby ${myLobby}] Player "${lobby.players[myId]&&lobby.players[myId].name}" disconnected`);
    removePlayerFromLobby(lobby, myId);
  });
});

// Broadcast lobby list every 5 seconds for time-remaining updates
setInterval(broadcastLobbyBrowser, 5000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🎮  TANK WARS — ONLINE SERVER');
  console.log('================================');
  console.log(`🌐  Listening on port ${PORT}`);
  console.log('Public lobbies: auto-created, fill to 5 then new one');
  console.log('Private lobbies: 4-digit ID, invite only\n');
});
