const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const eng = require('./poker-engine.js');
const tlEng = require('./tienlen-engine.js');

const TABLE_STAKES = [1000, 5000, 10000];
const RECONNECT_GRACE_MS = 3 * 60 * 1000;

function createApp(db, opts={}){
const ADMIN_USERNAME = opts.adminUsername || 'admin';

/* ================= Multi-table game state ================= */
const games = {};
TABLE_STAKES.forEach(stake => { games[stake] = eng.createGame(); });

const tlGames = {};
TABLE_STAKES.forEach(stake => {
  const g = tlEng.createGame();
  g.stakeForScoring = stake;
  g.queue = []; // [{userId, username, connId}]
  tlGames[stake] = g;
});
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

const BOT_NAME_POOL = [
  'Minh Anh','Hoàng Long','Thu Trang','Quốc Bảo','Ngọc Hà','Đức Huy','Phương Linh','Tuấn Kiệt',
  'Bảo Châu','Gia Hưng','Thanh Tùng','Kim Ngân','Việt Anh','Mai Phương','Đình Khang','Thảo Vy',
  'Xuân Sơn','Hồng Nhung','Tấn Phát','Lan Anh','Trọng Nghĩa','Yến Nhi','Công Danh','Bích Ngọc',
  'Hữu Phước','Diệu Linh','Anh Quân','Ngọc Ánh','Thiên Ân','Khánh Vy'
];
function pickBotName(existingNames){
  const available = BOT_NAME_POOL.filter(n => !existingNames.includes(n));
  const pool = available.length ? available : BOT_NAME_POOL;
  return pool[Math.floor(Math.random()*pool.length)];
}

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
function tlLobbySnapshot(){
  const out = {};
  TABLE_STAKES.forEach(stake=>{
    const g = tlGames[stake];
    out[stake] = {
      seatsFilled: tlEng.seatedIndices(g).length,
      maxSeats: 4,
      inHand: g.started && !g.gameOver
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

function tlPublicStateFor(stake, game, viewerSeatIndex, isAdminSpectator){
  const revealAll = isAdminSpectator && viewerSeatIndex===null;
  return {
    stake,
    started: game.started,
    gameOver: game.gameOver,
    winnerSeat: game.winnerSeat,
    actingIndex: game.actingIndex,
    trickTop: game.trickTop,
    trickTopSeat: game.trickTopSeat,
    lastPlays: game.lastPlays,
    settleResults: game.gameOver ? game.settleResults : null,
    isAdminSpectator: !!revealAll,
    mySeatIndex: viewerSeatIndex,
    mustIncludeThreeSpades: !!game.mustIncludeThreeSpades,
    turnDeadline: game.turnDeadline || null,
    seats: game.seats.map((p,i)=>{
      if(!p) return null;
      const revealHand = revealAll || i===viewerSeatIndex || game.gameOver;
      return {
        index:i, name:p.name, isBot:!!p.isBot, finished:!!p.finished,
        cardCount: p.hand ? p.hand.length : 0,
        hand: revealHand ? (p.hand||[]) : null
      };
    }),
    log: (game.log||[]).slice(-12)
  };
}
function broadcastTlTable(stake){
  const game = tlGames[stake];
  for(const [ws, info] of clients){
    if(ws.readyState !== WebSocket.OPEN) continue;
    const watchingThis = info.tlStake===stake || info.tlSpectating===stake;
    if(!watchingThis) continue;
    const isAdminSpectator = !!(info.isAdmin && info.tlSpectating===stake && info.tlStake!==stake);
    try{
      const state = tlPublicStateFor(stake, game, info.tlStake===stake ? info.tlSeatIndex : null, isAdminSpectator);
      state.queueLength = game.queue.length;
      state.myQueuePosition = (info.tlStake===stake && (info.tlSeatIndex===null || info.tlSeatIndex===undefined))
        ? (game.queue.findIndex(q=>q.userId===info.userId)+1) : null;
      ws.send(JSON.stringify({ type:'tlState', state }));
    } catch(e){ console.error('[tl broadcast] failed:', e); }
  }
}

function promoteTlQueue(stake){
  const game = tlGames[stake];
  if(!game.queue || game.queue.length===0) return;
  let promoted = false;
  for(let i=0;i<4 && game.queue.length>0;i++){
    if(!game.seats[i] || !game.seats[i].isBot) continue;
    const next = game.queue.shift();
    let ownerConnId = null, connected = false;
    for(const [cws, cinfo] of clients){
      if(cinfo.userId===next.userId && cinfo.tlStake===stake && cws.readyState===WebSocket.OPEN){
        cinfo.tlSeatIndex = i;
        ownerConnId = cinfo.id;
        connected = true;
      }
    }
    game.seats[i] = {
      name: next.username, isBot:false, userId: next.userId, hand:[], finished:false,
      hasPlayedAnyCard:false, connected, ownerConnId
    };
    promoted = true;
  }
  if(promoted){ broadcastTlTable(stake); broadcastLobby(); }
}

function broadcastLobby(){
  const snap = lobbySnapshot();
  const tlSnap = tlLobbySnapshot();
  for(const [ws, info] of clients){
    if(ws.readyState !== WebSocket.OPEN) continue;
    try{ ws.send(JSON.stringify({type:'lobby', tables: snap, tlTables: tlSnap})); } catch(e){}
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

// Robust bot/disconnected-player/timed-out-human turn driver: a persistent interval
// per table polls every 400ms and checks wall-clock time, rather than chaining
// setTimeout calls recursively (which occasionally lost a scheduled turn).
const tlPendingAction = {}; // stake -> {idx, at} | null
function tlBotTick(stake){
  const game = tlGames[stake];
  if(!game.started || game.gameOver){ tlPendingAction[stake] = null; return; }
  const idx = game.actingIndex;
  if(idx===-1){ tlPendingAction[stake] = null; return; }
  const p = game.seats[idx];
  if(!p){ tlPendingAction[stake] = null; return; }

  const isConnectedHuman = (p.isBot === false && p.connected !== false);
  let forcedByTimeout = false;

  if(isConnectedHuman){
    if(!game.turnDeadline || Date.now() < game.turnDeadline){ tlPendingAction[stake] = null; return; }
    forcedByTimeout = true; // their 15s ran out — act on their behalf
  } else {
    const pending = tlPendingAction[stake];
    if(!pending || pending.idx !== idx){
      tlPendingAction[stake] = { idx, at: Date.now() + 500 + Math.random()*500 };
      return;
    }
    if(Date.now() < pending.at) return;
    tlPendingAction[stake] = null;
  }

  try{
    const move = tlEng.botChooseMove(p.hand, game.trickTop, game.mustIncludeThreeSpades);
    const res = move===null ? tlEng.passTurn(game, idx) : tlEng.playCombo(game, idx, move.map(c=>tlEng.cardKey(c)));
    if(!res.ok) console.error('[tl bot] action failed:', res.reason);
    else if(forcedByTimeout) game.log.push({seat:idx, name:p.name, action:'timeout'});
    broadcastTlTable(stake);
    if(game.gameOver) settleTlHand(stake).catch(e=>console.error('[tl settle] error:', e));
  } catch(e){ console.error('[tl bot tick] exception:', e); }
}
TABLE_STAKES.forEach(stake => setInterval(()=> tlBotTick(stake), 400));
// No-op shim: older call sites just "nudge" after an action; the ticker above does the real work.
function maybeRunTlBot(stake){}

// Applies each losing player's payment directly to DB balances (bots don't have DB accounts, so they're skipped).
async function settleTlHand(stake){
  const game = tlGames[stake];
  if(!game.settleResults) return;
  const winnerSeat = game.seats[game.winnerSeat];
  let totalCollected = 0;
  for(const r of game.settleResults){
    const p = game.seats[r.seat];
    if(p.isBot || !p.userId) continue;
    const newBal = await db.adjustChips(p.userId, -r.pay);
    if(newBal!==null) totalCollected += r.pay; // only count what was actually collectible (adjustChips clamps at 0)
  }
  if(winnerSeat && !winnerSeat.isBot && winnerSeat.userId){
    const totalOwed = game.settleResults.reduce((s,r)=>s+r.pay,0);
    await db.adjustChips(winnerSeat.userId, totalOwed); // winner is credited the full nominal total, even if some payers got clamped at 0
  }
  broadcastLeaderboard();
  broadcastTlTable(stake);
  promoteTlQueue(stake);
}

/* ================= Chip <-> account sync ================= */
// Design: a player's DB balance represents money NOT currently at any table.
// Buy-in is deducted from DB balance the moment they join a table.
// Their table chip count is only credited back to the DB balance when they LEAVE
// (voluntarily, or after the reconnect grace period expires on disconnect).
// We deliberately do NOT sync mid-session after every hand — that would require
// subtracting the buy-in back out again and is easy to get wrong; leave-time
// settlement keeps the accounting simple and provably correct.
// Forcibly removes whoever is in a seat (admin action): folds them out of an in-progress
// hand if needed, notifies their live connection so the client returns to the lobby,
// credits their chips back to their DB balance immediately (no grace/reconnect period —
// this is a deliberate admin action, not a network drop), and clears the seat.
async function kickSeat(stake, seatIdx){
  const game = games[stake];
  const p = game.seats[seatIdx];
  if(!p) return {ok:false, reason:'Ghế này đang trống.'};
  const name = p.name;

  if(game.inHand && !p.folded){
    if(game.actingIndex===seatIdx){
      eng.processAction(game, seatIdx, 'fold');
      maybeRunBot(stake);
    } else {
      p.folded = true;
      game.needToAct.delete(seatIdx);
      if(game.needToAct.size===0) eng.advanceStreets(game);
    }
  }

  if(!p.isBot){
    for(const [cws, cinfo] of clients){
      if(cinfo.tableStake===stake && cinfo.seatIndex===seatIdx){
        try{ cws.send(JSON.stringify({type:'kickedFromTable', message:'Bạn đã bị admin mời ra khỏi bàn.'})); }catch(e){}
        cinfo.tableStake = null;
        cinfo.seatIndex = null;
      }
    }
    const key = stake+':'+seatIdx;
    if(seatDisconnectTimers[key]){ clearTimeout(seatDisconnectTimers[key]); delete seatDisconnectTimers[key]; }
  }

  await creditBackAndClearSeat(stake, seatIdx);
  broadcastTable(stake);
  broadcastLobby();
  broadcastLeaderboard();
  return {ok:true, name};
}

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
    computeLeaderboard().then(entries=> ws.send(JSON.stringify({type:'leaderboard', entries}))).catch(()=>{});
    return;
  }
  if(data.type==='login'){
    const r = await db.loginUser(data.username, data.password);
    if(!r.ok){ ws.send(JSON.stringify({type:'authError', message:r.reason})); return; }
    applyAuth(info, r.user);
    ws.send(JSON.stringify({type:'authOk', username:r.user.username, chips:r.user.chips, isAdmin:!!r.user.is_admin}));
    computeLeaderboard().then(entries=> ws.send(JSON.stringify({type:'leaderboard', entries}))).catch(()=>{});
    return;
  }

  if(!info.userId){ ws.send(JSON.stringify({type:'authError', message:'Bạn cần đăng nhập trước.'})); return; }

  if(data.type==='getLobby'){
    ws.send(JSON.stringify({type:'lobby', tables: lobbySnapshot(), tlTables: tlLobbySnapshot()}));
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
    broadcastLeaderboard();
    return;
  }

  if(data.type==='addBot'){
    if(info.tableStake===null || info.tableStake===undefined) return;
    const stake = info.tableStake;
    const game = games[stake];
    const seatIdx = findFreeSeat(game);
    if(seatIdx===-1) return;
    const personalities=['tight','balanced','loose'];
    const existingNames = game.seats.filter(s=>s).map(s=>s.name);
    game.seats[seatIdx] = {
      name: pickBotName(existingNames), isBot:true, personality:personalities[Math.floor(Math.random()*3)],
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

  /* ---- Tiến Lên ---- */
  if(data.type==='joinTlTable'){
    const stake = TABLE_STAKES.includes(Number(data.stake)) ? Number(data.stake) : null;
    if(!stake){ ws.send(JSON.stringify({type:'error', message:'Mức bàn không hợp lệ.'})); return; }
    if(info.tlStake!==null && info.tlStake!==undefined){ ws.send(JSON.stringify({type:'error', message:'Bạn đang ở bàn Tiến Lên khác, hãy rời bàn trước.'})); return; }
    const game = tlGames[stake];
    const seatIdx = game.seats.findIndex(s=>!s);
    const canSeatDirectly = seatIdx!==-1 && !(game.started && !game.gameOver);
    if(canSeatDirectly){
      game.seats[seatIdx] = { name: info.username, isBot:false, userId: info.userId, hand:[], finished:false, hasPlayedAnyCard:false, connected:true, ownerConnId: info.id };
      info.tlStake = stake;
      info.tlSeatIndex = seatIdx;
      info.tlSpectating = null;
      ws.send(JSON.stringify({type:'tlJoined', stake, seatIndex:seatIdx}));
      broadcastTlTable(stake);
      broadcastLobby();
      return;
    }
    // Table full or a hand is in progress: join the waiting queue instead of being
    // turned away. They can watch the table and get auto-seated (replacing a bot)
    // as soon as the current hand ends.
    if(game.queue.some(q=>q.userId===info.userId)){
      ws.send(JSON.stringify({type:'error', message:'Bạn đã ở trong hàng chờ của bàn này rồi.'}));
      return;
    }
    game.queue.push({ userId: info.userId, username: info.username, connId: info.id });
    info.tlStake = stake;
    info.tlSeatIndex = null;
    info.tlSpectating = null;
    ws.send(JSON.stringify({type:'tlQueued', stake, position: game.queue.length}));
    broadcastTlTable(stake);
    return;
  }

  if(data.type==='leaveTlTable'){
    if(info.tlStake===null || info.tlStake===undefined) return;
    const stake = info.tlStake;
    const game = tlGames[stake];
    if(info.tlSeatIndex===null || info.tlSeatIndex===undefined){
      game.queue = game.queue.filter(q=>q.userId!==info.userId);
      info.tlStake = null;
      ws.send(JSON.stringify({type:'tlLeft'}));
      broadcastTlTable(stake);
      return;
    }
    if(game.started && !game.gameOver){
      ws.send(JSON.stringify({type:'error', message:'Không thể rời bàn giữa ván — đợi ván kết thúc.'}));
      return;
    }
    if(game.seats[info.tlSeatIndex]) game.seats[info.tlSeatIndex] = null;
    info.tlStake = null; info.tlSeatIndex = null;
    ws.send(JSON.stringify({type:'tlLeft'}));
    broadcastTlTable(stake);
    broadcastLobby();
    return;
  }

  if(data.type==='addTlBot'){
    if(info.tlStake===null || info.tlStake===undefined) return;
    const stake = info.tlStake;
    const game = tlGames[stake];
    if(game.started && !game.gameOver) return;
    const seatIdx = game.seats.findIndex(s=>!s);
    if(seatIdx===-1) return;
    const existingNames = game.seats.filter(s=>s).map(s=>s.name);
    game.seats[seatIdx] = { name: pickBotName(existingNames), isBot:true, hand:[], finished:false, hasPlayedAnyCard:false, connected:true };
    broadcastTlTable(stake);
    return;
  }

  if(data.type==='startTlHand'){
    if(info.tlStake===null || info.tlStake===undefined) return;
    const stake = info.tlStake;
    const game = tlGames[stake];
    if(game.started && !game.gameOver) return;
    const res = tlEng.startHand(game);
    if(!res.ok){ ws.send(JSON.stringify({type:'error', message:res.reason})); return; }
    broadcastTlTable(stake);
    maybeRunTlBot(stake);
    return;
  }

  if(data.type==='tlPlay'){
    if(info.tlStake===null || info.tlSeatIndex===null || info.tlSeatIndex===undefined) return;
    const stake = info.tlStake;
    const game = tlGames[stake];
    const res = tlEng.playCombo(game, info.tlSeatIndex, data.cardKeys||[]);
    if(!res.ok){ ws.send(JSON.stringify({type:'error', message:res.reason})); return; }
    broadcastTlTable(stake);
    if(game.gameOver) await settleTlHand(stake);
    else maybeRunTlBot(stake);
    return;
  }

  if(data.type==='tlPass'){
    if(info.tlStake===null || info.tlSeatIndex===null || info.tlSeatIndex===undefined) return;
    const stake = info.tlStake;
    const game = tlGames[stake];
    const res = tlEng.passTurn(game, info.tlSeatIndex);
    if(!res.ok){ ws.send(JSON.stringify({type:'error', message:res.reason})); return; }
    broadcastTlTable(stake);
    maybeRunTlBot(stake);
    return;
  }

  if(data.type==='tlSetSpectator'){
    if(!info.isAdmin) return;
    const stake = TABLE_STAKES.includes(Number(data.stake)) ? Number(data.stake) : null;
    info.tlSpectating = (data.enabled && stake) ? stake : null;
    if(stake) broadcastTlTable(stake);
    return;
  }

  if(data.type==='reaction'){
    if(info.tableStake===null || info.tableStake===undefined || info.seatIndex===null) return;
    const ALLOWED_EMOJI = ['👍','😂','😮','🔥','😢','🤔','👏','😎'];
    if(!ALLOWED_EMOJI.includes(data.emoji)) return;
    const stake = info.tableStake;
    for(const [cws, cinfo] of clients){
      if(cws.readyState !== WebSocket.OPEN) continue;
      const watching = cinfo.tableStake===stake || cinfo.spectating===stake;
      if(!watching) continue;
      try{ cws.send(JSON.stringify({type:'reaction', seatIndex:info.seatIndex, emoji:data.emoji})); } catch(e){}
    }
    return;
  }

  if(data.type==='getSlotsStatus'){
    try{
      const jackpot = await db.getJackpot();
      const spinsRemaining = await db.getSpinsRemaining(info.userId);
      if(jackpot===null){
        ws.send(JSON.stringify({type:'error', message:'Không đọc được hũ jackpot từ database — kiểm tra lại đã chạy file supabase-migration-slots.sql chưa.'}));
        return;
      }
      ws.send(JSON.stringify({type:'slotsStatus', jackpot, spinsRemaining, dailyLimit: db.DAILY_SPIN_LIMIT}));
    } catch(e){
      console.error('[getSlotsStatus] error:', e);
      ws.send(JSON.stringify({type:'error', message:'Lỗi khi tải thông tin Slots.'}));
    }
    return;
  }

  if(data.type==='spinSlots'){
    try{
      const consume = await db.checkAndConsumeSpin(info.userId);
      if(!consume.ok){
        ws.send(JSON.stringify({type:'error', message: consume.reason}));
        const jp = await db.getJackpot();
        ws.send(JSON.stringify({type:'slotsStatus', jackpot: jp, spinsRemaining: consume.spinsRemaining, dailyLimit: db.DAILY_SPIN_LIMIT}));
        return;
      }
      const result = performSpin();
      const seedAdd = 15 + Math.floor(Math.random()*26); // +15..40 chips into the pool per spin
      let jackpotNow = await db.addToJackpot(seedAdd);
      if(jackpotNow===null){
        ws.send(JSON.stringify({type:'error', message:'Không cập nhật được hũ jackpot — kiểm tra lại đã chạy file supabase-migration-slots.sql trên database chưa.'}));
        return;
      }
      let wonAmount = 0;
      if(result.jackpotHit){
        wonAmount = jackpotNow;
        const user = await db.getUserById(info.userId);
        if(user){ await db.updateChips(info.userId, user.chips + wonAmount); }
        await db.resetJackpot(JACKPOT_RESET_BASE);
        jackpotNow = JACKPOT_RESET_BASE;
      }
      const freshUser = await db.getUserById(info.userId);
      ws.send(JSON.stringify({
        type:'spinResult', symbols: result.symbols, jackpotHit: result.jackpotHit, wonAmount,
        jackpot: jackpotNow, spinsRemaining: consume.spinsRemaining,
        chips: freshUser ? freshUser.chips : null
      }));
      broadcastJackpot(jackpotNow);
      broadcastLeaderboard();
    } catch(e){
      console.error('[spinSlots] error:', e);
      ws.send(JSON.stringify({type:'error', message:'Lỗi hệ thống khi quay Slots, thử lại sau.'}));
    }
    return;
  }

  if(data.type==='adminAdjustChips'){
    if(!info.isAdmin){ ws.send(JSON.stringify({type:'error', message:'Bạn không có quyền này.'})); return; }
    const targetUsername = (data.username||'').trim();
    const delta = Number(data.delta);
    if(!targetUsername || !Number.isFinite(delta) || delta===0){
      ws.send(JSON.stringify({type:'error', message:'Thông tin không hợp lệ.'}));
      return;
    }
    const targetUser = await db.getUserByUsername(targetUsername);
    if(!targetUser){ ws.send(JSON.stringify({type:'error', message:'Không tìm thấy người chơi.'})); return; }
    if(targetUser.is_admin){ ws.send(JSON.stringify({type:'error', message:'Không thể chỉnh chip của tài khoản admin.'})); return; }
    // Adjustment always applies to the DB balance only (the "money not currently at a table" pool).
    // If the player is mid-game at a table, their visible stack there is unaffected until they leave —
    // this avoids double-applying the delta to both pools at once.
    const newBalance = await db.adjustChips(targetUser.id, delta);
    if(newBalance===null){ ws.send(JSON.stringify({type:'error', message:'Lỗi cập nhật chip, thử lại sau.'})); return; }
    ws.send(JSON.stringify({type:'adminAdjustResult', ok:true, username:targetUser.username, newBalance, delta}));
    broadcastLeaderboard();
    return;
  }

  if(data.type==='adminKickPlayer'){
    if(!info.isAdmin){ ws.send(JSON.stringify({type:'error', message:'Bạn không có quyền này.'})); return; }
    const stake = TABLE_STAKES.includes(Number(data.stake)) ? Number(data.stake) : null;
    const seatIdx = Number(data.seatIndex);
    if(!stake || isNaN(seatIdx)){ ws.send(JSON.stringify({type:'error', message:'Thông tin không hợp lệ.'})); return; }
    const res = await kickSeat(stake, seatIdx, 'Bạn đã bị admin mời ra khỏi bàn.');
    if(!res.ok){ ws.send(JSON.stringify({type:'error', message:res.reason})); return; }
    ws.send(JSON.stringify({type:'adminActionResult', ok:true, message:`Đã kick ${res.name} khỏi bàn.`}));
    return;
  }

  if(data.type==='adminDeleteAccount'){
    if(!info.isAdmin){ ws.send(JSON.stringify({type:'error', message:'Bạn không có quyền này.'})); return; }
    const targetUsername = (data.username||'').trim();
    if(!targetUsername){ ws.send(JSON.stringify({type:'error', message:'Thiếu tên tài khoản.'})); return; }
    const targetUser = await db.getUserByUsername(targetUsername);
    if(!targetUser){ ws.send(JSON.stringify({type:'error', message:'Không tìm thấy người chơi.'})); return; }
    if(targetUser.is_admin){ ws.send(JSON.stringify({type:'error', message:'Không thể xoá tài khoản admin.'})); return; }

    // If they're currently seated anywhere, kick them out first so no chips are lost/stranded.
    for(const stake of TABLE_STAKES){
      const game = games[stake];
      const seatIdx = game.seats.findIndex(s=> s && !s.isBot && s.userId===targetUser.id);
      if(seatIdx!==-1) await kickSeat(stake, seatIdx, 'Tài khoản của bạn đã bị admin xoá.');
    }

    const ok = await db.deleteUser(targetUser.id);
    if(!ok){ ws.send(JSON.stringify({type:'error', message:'Lỗi xoá tài khoản, thử lại sau.'})); return; }

    // Force-disconnect any live session logged in as the deleted account.
    for(const [cws, cinfo] of clients){
      if(cinfo.userId===targetUser.id){
        try{ cws.send(JSON.stringify({type:'accountDeleted', message:'Tài khoản của bạn đã bị admin xoá.'})); }catch(e){}
        try{ cws.close(); }catch(e){}
      }
    }
    ws.send(JSON.stringify({type:'adminActionResult', ok:true, message:`Đã xoá tài khoản ${targetUser.username}.`}));
    broadcastLeaderboard();
    return;
  }
}

async function computeLeaderboard(limit=15){
  const users = await db.getAllNonAdminUsers();
  const totals = new Map();
  users.forEach(u=> totals.set(u.id, {username:u.username, total:u.chips}));
  TABLE_STAKES.forEach(stake=>{
    const game = games[stake];
    for(const seat of game.seats){
      if(seat && !seat.isBot && seat.userId && totals.has(seat.userId)){
        totals.get(seat.userId).total += seat.chips;
      }
    }
  });
  return [...totals.values()].sort((a,b)=> b.total - a.total).slice(0, limit);
}
async function broadcastLeaderboard(){
  let entries;
  try{ entries = await computeLeaderboard(); } catch(e){ console.error('[leaderboard] compute failed:', e); return; }
  for(const [cws] of clients){
    if(cws.readyState !== WebSocket.OPEN) continue;
    try{ cws.send(JSON.stringify({type:'leaderboard', entries})); } catch(e){}
  }
}
setInterval(()=>{ broadcastLeaderboard(); }, 8000);

const SLOT_SYMBOLS = ['🍒','🍋','🍇','🔔','💎','7️⃣'];
const JACKPOT_HIT_CHANCE = 1/150;
const JACKPOT_RESET_BASE = 500;
function performSpin(){
  const jackpotHit = Math.random() < JACKPOT_HIT_CHANCE;
  if(jackpotHit) return { symbols:['7️⃣','7️⃣','7️⃣'], jackpotHit:true };
  const symbols = [0,0,0].map(()=> SLOT_SYMBOLS[Math.floor(Math.random()*(SLOT_SYMBOLS.length-1))]); // exclude 7 from random (reserved for jackpot)
  return { symbols, jackpotHit:false };
}
function broadcastJackpot(amount){
  for(const [cws] of clients){
    if(cws.readyState !== WebSocket.OPEN) continue;
    try{ cws.send(JSON.stringify({type:'jackpotUpdate', amount})); } catch(e){}
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
  const info = { id, userId:null, username:null, isAdmin:false, tableStake:null, seatIndex:null, spectating:null,
    tlStake:null, tlSeatIndex:null, tlSpectating:null };
  clients.set(ws, info);
  ws.send(JSON.stringify({type:'lobby', tables: lobbySnapshot(), tlTables: tlLobbySnapshot()}));
  db.getJackpot().then(amount=>{
    if(amount!==null && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type:'jackpotUpdate', amount}));
  }).catch(()=>{});

  ws.on('message', (msg)=>{
    handleMessage(ws, info, msg).catch(e=>{
      console.error('handleMessage error:', e);
      try{ ws.send(JSON.stringify({type:'error', message:'Lỗi server nội bộ.'})); }catch(_){}
    });
  });

  ws.on('close', async ()=>{
    clients.delete(ws);

    if(info.tlStake!==null && info.tlStake!==undefined){
      const tlStake = info.tlStake;
      const tlGame = tlGames[tlStake];
      if(info.tlSeatIndex===null || info.tlSeatIndex===undefined){
        tlGame.queue = tlGame.queue.filter(q=>q.userId!==info.userId);
        broadcastTlTable(tlStake);
      } else {
        const tlP = tlGame.seats[info.tlSeatIndex];
        if(tlP && tlP.ownerConnId===info.id){
          if(tlGame.started && !tlGame.gameOver){
            tlP.connected = false;
          } else {
            tlGame.seats[info.tlSeatIndex] = null;
          }
          broadcastTlTable(tlStake);
          broadcastLobby();
        }
      }
    }

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
        broadcastLeaderboard();
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
