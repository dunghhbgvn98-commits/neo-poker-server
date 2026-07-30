const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const eng = require('./engine.js');

const TABLE_STAKES = [1000, 5000, 10000];
const RECONNECT_GRACE_MS = 3 * 60 * 1000;

function createApp(db, opts={}){
const ADMIN_USERNAME = opts.adminUsername || 'admin';

/* ================= Multi-table game state ================= */
const games = {};
TABLE_STAKES.forEach(stake => { games[stake] = eng.createGame(); });
const botTimers = {};       // stake -> timeout handle
const seatDisconnectTimers = {}; // `${stake}:${seatIndex}` -> timeout handle
const equityCache = {};     // stake -> {sig, map}

// engine.js's computeAllEquitiesCached uses a single module-level cache which would
// collide across simultaneous tables. Wrap with a per-table cache instead.
function computeAllEquitiesForTable(stake, game){
  const contenders = eng.seatedIndices(game).filter(i=>!game.seats[i].eliminated&&!game.seats[i].folded);
  const sig = game.board.map(c=>c.r+c.s).join(',') + '|' + contenders.join(',');
  const cached = equityCache[stake];
  if(cached && cached.sig===sig) return cached.map;
  const map = eng.computeAllEquities(game);
  equityCache[stake] = {sig, map};
  return map;
}

/* ================= WebSocket clients ================= */
const clients = new Map(); // ws -> info
let nextClientId = 1;
// info = {id, userId, username, isAdmin, chips (cached DB balance when not seated),
//         tableStake, seatIndex, spectating (stake or null)}

function findFreeSeat(game){ for(let i=0;i<eng.MAX_SEATS;i++) if(!game.seats[i]) return i; return -1; }

/* ================= State broadcasting ================= */
function publicStateFor(stake, game, viewerSeatIndex, isAdminSpectator){
  const revealAll = isAdminSpectator && viewerSeatIndex===null;
  return {
    stake,
    seats: game.seats.map((p,i)=>{
      if(!p) return null;
      const revealCards = revealAll || (i===viewerSeatIndex) || (game.handOver && !p.folded);
      return {
        index:i, name:p.name, isBot:!!p.isBot, chips:p.chips, folded:p.folded, allIn:p.allIn,
        betThisRound:p.betThisRound, eliminated:p.eliminated, connected:p.connected!==false,
        cards: p.cards.length ? (revealCards ? p.cards : [{hidden:true},{hidden:true}]) : [],
        equity: revealAll ? null : undefined // filled below if revealAll
      };
    }),
    board: game.board, pot: game.pot + game.seats.reduce((s,p)=>s+(p?p.betThisRound:0),0),
    currentBet: game.currentBet, street: game.street, actingIndex: game.actingIndex,
    dealerIndex: game.dealerIndex, sbIndex: game.sbIndex, bbIndex: game.bbIndex,
    handOver: game.handOver, inHand: game.inHand,
    log: game.log.slice(-10), handHistory: game.handHistory.slice(0,20),
    mySeatIndex: viewerSeatIndex,
    isAdminSpectator: !!revealAll,
    allEquities: revealAll && game.inHand && !game.handOver ? computeAllEquitiesForTable(stake, game) : null,
    myEquity: (!revealAll && game.inHand && !game.handOver) ? eng.computeOwnEquity(game, viewerSeatIndex) : null,
    minRaise: game.minRaise,
    myCallAmt: viewerSeatIndex!==null && game.seats[viewerSeatIndex] ? game.currentBet - game.seats[viewerSeatIndex].betThisRound : null
  };
}

function lobbySnapshot(){
  const out = {};
  TABLE_STAKES.forEach(stake=>{
    const g = games[stake];
    out[stake] = {
      seatsFilled: eng.seatedIndices(g).length,
      maxSeats: eng.MAX_SEATS,
      inHand: g.inHand
    };
  });
  return out;
}

function broadcastTable(stake){
  const game = games[stake];
  for(const [ws, info] of clients){
    if(ws.readyState !== WebSocket.OPEN) continue;
    const watchingThis = info.tableStake===stake || info.spectating===stake;
    if(!watchingThis) continue;
    const isAdminSpectator = !!(info.isAdmin && info.spectating===stake && info.tableStake!==stake);
    try{
      ws.send(JSON.stringify({
        type:'state',
        state: publicStateFor(stake, game, info.tableStake===stake ? info.seatIndex : null, isAdminSpectator)
      }));
    } catch(e){ console.error('[broadcast] failed:', e); }
  }
}
function broadcastLobby(){
  const snap = lobbySnapshot();
  for(const [ws, info] of clients){
    if(ws.readyState !== WebSocket.OPEN) continue;
    try{ ws.send(JSON.stringify({type:'lobby', tables: snap})); } catch(e){}
  }
}

/* ================= Bot turn scheduling (per table) ================= */
function maybeRunBot(stake){
  clearTimeout(botTimers[stake]);
  const game = games[stake];
  if(!game.inHand || game.handOver) return;
  const idx = game.actingIndex;
  if(idx===-1) return;
  const p = game.seats[idx];
  if(!p || !p.isBot) return;
  botTimers[stake] = setTimeout(()=>{
    try{
      if(!game.inHand || game.handOver) return;
      const eqMap = computeAllEquitiesForTable(stake, game);
      const dec = eng.botDecision(game, idx, eqMap);
      const res = eng.processAction(game, idx, dec.action, dec.amount);
      if(!res.ok) console.error('[bot] action failed:', res.reason);
      broadcastTable(stake);
      maybeRunBot(stake);
    } catch(e){ console.error('[bot] exception:', e); }
  }, 700 + Math.random()*600);
}

/* ================= Chip <-> account sync ================= */
// Design: a player's DB balance represents money NOT currently at any table.
// Buy-in is deducted from DB balance the moment they join a table.
// Their table chip count is only credited back to the DB balance when they LEAVE
// (voluntarily, or after the reconnect grace period expires on disconnect).
// We deliberately do NOT sync mid-session after every hand — that would require
// subtracting the buy-in back out again and is easy to get wrong; leave-time
// settlement keeps the accounting simple and provably correct.
async function creditBackAndClearSeat(stake, seatIdx){
  const game = games[stake];
  const p = game.seats[seatIdx];
  if(!p) return;
  if(!p.isBot && p.userId){
    try{
      const user = await db.getUserById(p.userId);
      const newBalance = (user ? user.chips : 0) + p.chips;
      await db.updateChips(p.userId, newBalance);
    } catch(e){ console.error('[leave] credit-back failed:', e); }
  }
  game.seats[seatIdx] = null;
}

/* ================= Message handling ================= */
async function handleMessage(ws, info, raw){
  let data;
  try{ data = JSON.parse(raw); } catch(e){ return; }

  if(data.type==='register'){
    const r = await db.registerUser(data.username, data.password);
    if(!r.ok){ ws.send(JSON.stringify({type:'authError', message:r.reason})); return; }
    applyAuth(info, r.user);
    ws.send(JSON.stringify({type:'authOk', username:r.user.username, chips:r.user.chips, isAdmin:!!r.user.is_admin}));
    return;
  }
  if(data.type==='login'){
    const r = await db.loginUser(data.username, data.password);
    if(!r.ok){ ws.send(JSON.stringify({type:'authError', message:r.reason})); return; }
    applyAuth(info, r.user);
    ws.send(JSON.stringify({type:'authOk', username:r.user.username, chips:r.user.chips, isAdmin:!!r.user.is_admin}));
    return;
  }

  if(!info.userId){ ws.send(JSON.stringify({type:'authError', message:'Bạn cần đăng nhập trước.'})); return; }

  if(data.type==='getLobby'){
    ws.send(JSON.stringify({type:'lobby', tables: lobbySnapshot()}));
    return;
  }

  if(data.type==='joinTable'){
    const stake = TABLE_STAKES.includes(Number(data.stake)) ? Number(data.stake) : null;
    if(!stake){ ws.send(JSON.stringify({type:'error', message:'Mức bàn không hợp lệ.'})); return; }
    if(info.tableStake!==null && info.tableStake!==undefined){ ws.send(JSON.stringify({type:'error', message:'Bạn đang ở bàn khác, hãy rời bàn trước.'})); return; }
    const user = await db.getUserById(info.userId);
    if(!user){ ws.send(JSON.stringify({type:'error', message:'Không tìm thấy tài khoản.'})); return; }
    if(user.chips < stake){ ws.send(JSON.stringify({type:'error', message:`Bạn cần tối thiểu ${stake.toLocaleString('en-US')} chip để vào bàn này (hiện có ${user.chips.toLocaleString('en-US')}).`})); return; }

    const game = games[stake];
    const seatIdx = findFreeSeat(game);
    if(seatIdx===-1){ ws.send(JSON.stringify({type:'error', message:'Bàn đã đầy (tối đa 8 người).'})); return; }

    const ok = await db.updateChips(info.userId, user.chips - stake);
    if(!ok){ ws.send(JSON.stringify({type:'error', message:'Lỗi trừ chip, thử lại sau.'})); return; }

    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    game.seats[seatIdx] = {
      name: info.username, isBot:false, personality:null, userId: info.userId,
      chips: stake, cards:[], folded:false, allIn:false, betThisRound:0, betThisHand:0,
      eliminated:false, connected:true, token, ownerConnId: info.id
    };
    info.tableStake = stake;
    info.seatIndex = seatIdx;
    info.spectating = null;
    ws.send(JSON.stringify({type:'joinedTable', stake, seatIndex:seatIdx, token}));
    broadcastTable(stake);
    broadcastLobby();
    return;
  }

  if(data.type==='rejoinTable'){
    const stake = TABLE_STAKES.includes(Number(data.stake)) ? Number(data.stake) : null;
    if(!stake) return;
    const game = games[stake];
    const seatIdx = game.seats.findIndex(s=>s && s.token===data.token && s.userId===info.userId);
    if(seatIdx===-1){ ws.send(JSON.stringify({type:'rejoinFailed'})); return; }
    const key = stake+':'+seatIdx;
    if(seatDisconnectTimers[key]){ clearTimeout(seatDisconnectTimers[key]); delete seatDisconnectTimers[key]; }
    game.seats[seatIdx].connected = true;
    game.seats[seatIdx].ownerConnId = info.id;
    info.tableStake = stake;
    info.seatIndex = seatIdx;
    ws.send(JSON.stringify({type:'joinedTable', stake, seatIndex:seatIdx, token:data.token}));
    broadcastTable(stake);
    return;
  }

  if(data.type==='leaveTable'){
    if(info.tableStake===null || info.tableStake===undefined) return;
    const stake = info.tableStake;
    const game = games[stake];
    if(game.inHand && game.seats[info.seatIndex] && !game.seats[info.seatIndex].folded){
      ws.send(JSON.stringify({type:'error', message:'Không thể rời bàn giữa ván — hãy fold trước.'}));
      return;
    }
    await creditBackAndClearSeat(stake, info.seatIndex);
    info.tableStake = null; info.seatIndex = null;
    const freshUser = await db.getUserById(info.userId);
    ws.send(JSON.stringify({type:'leftTable', chips: freshUser ? freshUser.chips : null}));
    broadcastTable(stake);
    broadcastLobby();
    return;
  }

  if(data.type==='addBot'){
    if(info.tableStake===null || info.tableStake===undefined) return;
    const stake = info.tableStake;
    const game = games[stake];
    const seatIdx = findFreeSeat(game);
    if(seatIdx===-1) return;
    const personalities=['tight','balanced','loose'];
    game.seats[seatIdx] = {
      name:`Bot ${seatIdx}`, isBot:true, personality:personalities[Math.floor(Math.random()*3)],
      chips: stake, cards:[], folded:false, allIn:false, betThisRound:0, betThisHand:0,
      eliminated:false, connected:true
    };
    broadcastTable(stake);
    return;
  }

  if(data.type==='startHand'){
    if(info.tableStake===null || info.tableStake===undefined) return;
    const stake = info.tableStake;
    const game = games[stake];
    if(game.inHand) return;
    const res = eng.startHand(game);
    if(!res.ok){ ws.send(JSON.stringify({type:'error', message:res.reason})); return; }
    broadcastTable(stake);
    maybeRunBot(stake);
    return;
  }

  if(data.type==='action'){
    if(info.tableStake===null || info.seatIndex===null || info.seatIndex===undefined) return;
    const stake = info.tableStake;
    const game = games[stake];
    const res = eng.processAction(game, info.seatIndex, data.action, data.amount);
    if(!res.ok){ ws.send(JSON.stringify({type:'error', message:res.reason})); return; }
    broadcastTable(stake);
    maybeRunBot(stake);
    return;
  }

  if(data.type==='setSpectator'){
    if(!info.isAdmin) return;
    const stake = TABLE_STAKES.includes(Number(data.stake)) ? Number(data.stake) : null;
    if(data.enabled && stake){
      info.spectating = stake;
    } else {
      info.spectating = null;
    }
    if(stake) broadcastTable(stake);
    return;
  }
}

function applyAuth(info, user){
  info.userId = user.id;
  info.username = user.username;
  info.isAdmin = !!user.is_admin;
}

/* ================= HTTP + WS boilerplate ================= */
const server = http.createServer((req,res)=>{
  let filePath = req.url==='/' ? '/index.html' : req.url;
  filePath = path.join(__dirname,'public', path.normalize(filePath).replace(/^(\.\.[\/\\])+/,''));
  fs.readFile(filePath, (err,content)=>{
    if(err){ res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    const mime = ext==='.js' ? 'application/javascript' : ext==='.css' ? 'text/css' : 'text/html';
    res.writeHead(200, {'Content-Type':mime});
    res.end(content);
  });
});

const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head)=>{
  wss.handleUpgrade(req, socket, head, (ws)=> wss.emit('connection', ws, req));
});

wss.on('connection', (ws)=>{
  const id = nextClientId++;
  const info = { id, userId:null, username:null, isAdmin:false, tableStake:null, seatIndex:null, spectating:null };
  clients.set(ws, info);
  ws.send(JSON.stringify({type:'lobby', tables: lobbySnapshot()}));

  ws.on('message', (msg)=>{
    handleMessage(ws, info, msg).catch(e=>{
      console.error('handleMessage error:', e);
      try{ ws.send(JSON.stringify({type:'error', message:'Lỗi server nội bộ.'})); }catch(_){}
    });
  });

  ws.on('close', async ()=>{
    clients.delete(ws);
    if(info.tableStake===null || info.tableStake===undefined || info.seatIndex===null) return;
    const stake = info.tableStake;
    const game = games[stake];
    const p = game.seats[info.seatIndex];
    if(!p || p.ownerConnId!==info.id) return;

    p.connected = false;
    if(game.inHand && !p.folded){
      if(game.actingIndex===info.seatIndex){
        eng.processAction(game, info.seatIndex, 'fold');
        maybeRunBot(stake);
      } else {
        p.folded = true;
        game.needToAct.delete(info.seatIndex);
        if(game.needToAct.size===0){
          eng.advanceStreets(game);
        }
      }
    }
    const key = stake+':'+info.seatIndex;
    const seatIdx = info.seatIndex;
    seatDisconnectTimers[key] = setTimeout(async ()=>{
      if(game.seats[seatIdx] && !game.seats[seatIdx].connected){
        await creditBackAndClearSeat(stake, seatIdx);
        broadcastTable(stake);
        broadcastLobby();
      }
      delete seatDisconnectTimers[key];
    }, RECONNECT_GRACE_MS);
    broadcastTable(stake);
    broadcastLobby();
  });
});

const PORT = process.env.PORT || 3000;
return { server, games, db, listen: (port=PORT)=> new Promise(resolve=>{
  db.ensureAdmin(ADMIN_USERNAME, opts.adminPassword).then(()=>{
    server.listen(port, ()=>{ console.log('Neo Poker server (v2) listening on port', port); resolve(server); });
  });
}) };
} // end createApp

module.exports = { createApp, TABLE_STAKES };

/* ================= Real runtime entry point ================= */
if(require.main === module){
  const { createClient } = require('@supabase/supabase-js');
  const { createDb } = require('./db.js');

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;

  if(!SUPABASE_URL || !SUPABASE_ANON_KEY){
    console.error('FATAL: SUPABASE_URL and SUPABASE_ANON_KEY environment variables are required.');
    process.exit(1);
  }
  if(!ADMIN_PASSWORD){
    console.warn('WARNING: ADMIN_PASSWORD not set — admin account will not be created/updated.');
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const db = createDb(supabase);
  const app = createApp(db, { adminUsername: ADMIN_USERNAME, adminPassword: ADMIN_PASSWORD });
  app.listen();
}
