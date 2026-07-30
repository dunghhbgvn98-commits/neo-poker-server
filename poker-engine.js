/* ================= Poker engine (Texas Hold'em, server-authoritative) =================
   Pure game logic: no networking, no database. Same engine already validated through
   hundreds of simulated hands (multi-way pots, side-pots, chip conservation). */

/* ================= Cards / evaluator ================= */
const RANKS=[2,3,4,5,6,7,8,9,10,11,12,13,14];
const SUITS=['S','H','D','C'];
function makeDeck(){const d=[];for(const s of SUITS)for(const r of RANKS)d.push({r,s});return d;}
function shuffle(arr){const a=arr.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

const BASE=15**5;
function scoreOf(cat,kickers){let k=0;for(const v of kickers)k=k*15+v;return cat*BASE+k;}
function evaluate5(cards){
  const ranks=cards.map(c=>c.r).sort((a,b)=>b-a);
  const suits=cards.map(c=>c.s);
  const isFlush=suits.every(s=>s===suits[0]);
  const uniq=[...new Set(ranks)];
  let isStraight=false,straightHigh=0;
  if(uniq.length===5){
    if(uniq[0]-uniq[4]===4){isStraight=true;straightHigh=uniq[0];}
    else if(uniq[0]===14&&uniq[1]===5&&uniq[2]===4&&uniq[3]===3&&uniq[4]===2){isStraight=true;straightHigh=5;}
  }
  const counts={};for(const r of ranks)counts[r]=(counts[r]||0)+1;
  const groups=Object.entries(counts).map(([r,c])=>({r:+r,c})).sort((a,b)=>b.c-a.c||b.r-a.r);
  if(isStraight&&isFlush)return{score:scoreOf(8,[straightHigh]),category:8};
  if(groups[0].c===4)return{score:scoreOf(7,[groups[0].r,groups[1].r]),category:7};
  if(groups[0].c===3&&groups[1].c===2)return{score:scoreOf(6,[groups[0].r,groups[1].r]),category:6};
  if(isFlush)return{score:scoreOf(5,ranks),category:5};
  if(isStraight)return{score:scoreOf(4,[straightHigh]),category:4};
  if(groups[0].c===3){const k=groups.filter(g=>g.c===1).map(g=>g.r).sort((a,b)=>b-a);return{score:scoreOf(3,[groups[0].r,...k]),category:3};}
  if(groups[0].c===2&&groups[1].c===2){const k=groups.find(g=>g.c===1).r;return{score:scoreOf(2,[groups[0].r,groups[1].r,k]),category:2};}
  if(groups[0].c===2){const k=groups.filter(g=>g.c===1).map(g=>g.r).sort((a,b)=>b-a);return{score:scoreOf(1,[groups[0].r,...k]),category:1};}
  return{score:scoreOf(0,ranks),category:0};
}
const COMB_CACHE={};
function getCombos(n,k){
  const key=n+'_'+k;
  if(COMB_CACHE[key])return COMB_CACHE[key];
  const idx=Array.from({length:n},(_,i)=>i);
  const out=[];
  function rec(start,chosen){if(chosen.length===k){out.push(chosen.slice());return;}for(let i=start;i<idx.length;i++){chosen.push(idx[i]);rec(i+1,chosen);chosen.pop();}}
  rec(0,[]);COMB_CACHE[key]=out;return out;
}
function evaluateBest(cards){
  if(cards.length===5)return evaluate5(cards);
  const combos=getCombos(cards.length,5);
  let best=null;
  for(const combo of combos){const five=combo.map(i=>cards[i]);const res=evaluate5(five);if(!best||res.score>best.score)best=res;}
  return best;
}
function combos2(arr){const out=[];for(let i=0;i<arr.length;i++)for(let j=i+1;j<arr.length;j++)out.push([arr[i],arr[j]]);return out;}

function preflopChenScore(cards){
  const vals=cards.map(c=>c.r).sort((a,b)=>b-a);
  const [h,l]=vals;
  const pointMap={14:10,13:8,12:7,11:6,10:5};
  let base=pointMap[h]!==undefined?pointMap[h]:h/2;
  let score;
  if(h===l){score=Math.max(base*2,5);}
  else{
    score=base;
    if(cards[0].s===cards[1].s)score+=2;
    const gap=h-l-1;
    if(gap===1)score-=1; else if(gap===2)score-=2; else if(gap===3)score-=4; else if(gap>=4)score-=5;
  }
  return Math.max(score,0);
}
function preflopStrength01(cards){return Math.min(preflopChenScore(cards)/20,1);}

/* ================= Game engine (server-authoritative) ================= */
const SMALL_BLIND=10, BIG_BLIND=20;
const MAX_SEATS=8;

function createGame(){
  return {
    seats: new Array(MAX_SEATS).fill(null), // each: {name,isBot,personality,chips,cards,folded,allIn,betThisRound,betThisHand,eliminated,connected,clientId}
    dealerIndex:0, board:[], deck:[], pot:0, currentBet:0, minRaise:BIG_BLIND,
    street:0, needToAct:new Set(), actingIndex:-1, handOver:false, inHand:false,
    log:[], handsPlayed:0, handHistory:[]
  };
}
function seatedIndices(game){ const out=[]; for(let i=0;i<MAX_SEATS;i++) if(game.seats[i]) out.push(i); return out; }
function nextEligible(game,i){for(let s=1;s<=MAX_SEATS;s++){const idx=(i+s)%MAX_SEATS;const p=game.seats[idx];if(p&&!p.eliminated)return idx;}return -1;}
function nextCanAct(game,i){for(let s=1;s<=MAX_SEATS;s++){const idx=(i+s)%MAX_SEATS;const p=game.seats[idx];if(p&&!p.eliminated&&!p.folded&&!p.allIn&&p.chips>0)return idx;}return -1;}

function recordHandHistory(game, winnerIndices){
  const results=[];
  for(let i=0;i<MAX_SEATS;i++){
    const p=game.seats[i];
    if(p && p.chipsBeforeHand!==undefined) results.push({name:p.name, delta:p.chips-p.chipsBeforeHand, chipsAfter:p.chips});
  }
  const record={handNumber:game.handsPlayed, board:game.board.slice(), winners:winnerIndices.map(i=>game.seats[i].name), results};
  game.handHistory.unshift(record);
  if(game.handHistory.length>50) game.handHistory.length=50;
}

function startHand(game){
  for(let i=0;i<MAX_SEATS;i++){ const p=game.seats[i]; if(p && p.chips<=0) p.eliminated=true; }
  const alive=seatedIndices(game).filter(i=>!game.seats[i].eliminated);
  if(alive.length<2){ game.inHand=false; return {ok:false, reason:'Cần ít nhất 2 người còn chip để bắt đầu.'}; }
  for(const i of seatedIndices(game)){
    const p=game.seats[i];
    p.cards=[]; p.folded=false; p.allIn=false; p.betThisRound=0; p.betThisHand=0; p.chipsBeforeHand=p.chips;
  }
  game.board=[]; game.pot=0; game.currentBet=0; game.minRaise=BIG_BLIND; game.street=0; game.handOver=false; game.inHand=true; game.log=[];
  game.handsPlayed++;
  game.dealerIndex = seatedIndices(game).includes(game.dealerIndex) ? game.dealerIndex : alive[0];
  game.dealerIndex = nextEligible(game, game.dealerIndex);
  let sbIndex,bbIndex;
  if(alive.length===2){ sbIndex=game.dealerIndex; bbIndex=nextEligible(game,game.dealerIndex); }
  else{ sbIndex=nextEligible(game,game.dealerIndex); bbIndex=nextEligible(game,sbIndex); }
  game.sbIndex=sbIndex; game.bbIndex=bbIndex;
  game.deck=shuffle(makeDeck());
  let cursor=0;
  for(const i of alive){ game.seats[i].cards=[game.deck[cursor],game.deck[cursor+1]]; cursor+=2; }
  game.deck=game.deck.slice(cursor);
  postBet(game,sbIndex,Math.min(SMALL_BLIND,game.seats[sbIndex].chips));
  postBet(game,bbIndex,Math.min(BIG_BLIND,game.seats[bbIndex].chips));
  game.currentBet=game.seats[bbIndex].betThisRound;
  const firstToAct=nextCanAct(game,bbIndex);
  game.actingIndex=firstToAct;
  game.needToAct=new Set(seatedIndices(game).filter(i=>{const p=game.seats[i];return !p.eliminated&&!p.folded&&!p.allIn&&p.chips>0;}));
  if(firstToAct===-1) game.needToAct.clear();
  if(game.needToAct.size===0) advanceStreets(game);
  return {ok:true};
}
function postBet(game,idx,amt){const p=game.seats[idx];p.chips-=amt;p.betThisRound+=amt;p.betThisHand+=amt;game.pot+=amt;if(p.chips===0)p.allIn=true;}
function activeNonFolded(game){return seatedIndices(game).filter(i=>{const p=game.seats[i];return !p.eliminated&&!p.folded;});}

function processAction(game,idx,action,raiseTotal){
  if(!game.inHand || game.handOver) return {ok:false, reason:'Ván đã kết thúc, chờ ván mới.'};
  const p=game.seats[idx];
  if(!p) return {ok:false, reason:'Ghế trống.'};
  if(game.actingIndex!==idx) return {ok:false, reason:'Chưa đến lượt bạn.'};
  const callAmt=game.currentBet-p.betThisRound;
  if(action==='fold'){p.folded=true;game.needToAct.delete(idx);game.log.push(`${p.name} úp bài`);}
  else if(action==='check'){
    if(callAmt>0) return {ok:false, reason:'Không thể check, phải call hoặc fold.'};
    game.needToAct.delete(idx);game.log.push(`${p.name} check`);
  }
  else if(action==='call'){
    const pay=Math.min(callAmt,p.chips);
    p.chips-=pay;p.betThisRound+=pay;p.betThisHand+=pay;game.pot+=pay;
    if(p.chips===0)p.allIn=true;
    game.needToAct.delete(idx);
    game.log.push(pay===0?`${p.name} check`:`${p.name} theo ${pay}`);
  } else if(action==='raise'){
    const maxTotal=p.betThisRound+p.chips;
    let total=Math.min(raiseTotal,maxTotal);
    if(total<=p.betThisRound) return {ok:false, reason:'Số tiền raise không hợp lệ.'};
    const pay=total-p.betThisRound;
    p.chips-=pay;p.betThisRound=total;p.betThisHand+=pay;game.pot+=pay;
    if(p.chips===0)p.allIn=true;
    if(total>game.currentBet){
      const raiseSize=total-game.currentBet;
      game.currentBet=total;
      game.minRaise=Math.max(raiseSize,BIG_BLIND);
      game.needToAct=new Set(seatedIndices(game).filter(i=>{const pl=game.seats[i];return !pl.eliminated&&!pl.folded&&!pl.allIn&&pl.chips>0&&i!==idx;}));
    }
    game.needToAct.delete(idx);
    game.log.push(`${p.name} raise lên ${total}`);
  } else {
    return {ok:false, reason:'Hành động không hợp lệ.'};
  }

  const remaining=activeNonFolded(game);
  if(remaining.length===1){
    game.seats[remaining[0]].chips+=game.pot;
    game.log.push(`${game.seats[remaining[0]].name} thắng pot ${game.pot} (mọi người khác fold)`);
    game.pot=0;game.handOver=true;game.inHand=false;game.actingIndex=-1;
    recordHandHistory(game,[remaining[0]]);
    return {ok:true};
  }
  if(game.needToAct.size===0) advanceStreets(game);
  else game.actingIndex=nextCanAct(game,idx);
  return {ok:true};
}

function advanceStreets(game){
  while(true){
    for(const i of seatedIndices(game)) game.seats[i].betThisRound=0;
    game.currentBet=0; game.minRaise=BIG_BLIND;
    if(game.street===3){ showdown(game); return; }
    if(game.street===0) game.board.push(...game.deck.splice(0,3));
    else game.board.push(...game.deck.splice(0,1));
    game.street++;
    const canAct=seatedIndices(game).filter(i=>{const p=game.seats[i];return !p.eliminated&&!p.folded&&!p.allIn&&p.chips>0;});
    if(canAct.length<=1){ game.needToAct.clear(); continue; }
    else{ game.actingIndex=nextCanAct(game,game.dealerIndex); game.needToAct=new Set(canAct); return; }
  }
}

function showdown(game){
  const contenders=seatedIndices(game).filter(i=>game.seats[i].betThisHand>0);
  const levels=[...new Set(contenders.map(i=>game.seats[i].betThisHand))].sort((a,b)=>a-b);
  let prev=0; const layers=[];
  for(const level of levels){
    const layer=contenders.filter(i=>game.seats[i].betThisHand>=level);
    const amount=(level-prev)*layer.length;
    const eligible=layer.filter(i=>!game.seats[i].folded);
    if(amount>0) layers.push({amount,eligible});
    prev=level;
  }
  const allWinners=new Set();
  for(const layer of layers){
    if(layer.eligible.length===0) continue;
    const scored=layer.eligible.map(i=>({i,res:evaluateBest([...game.seats[i].cards,...game.board])}));
    const maxScore=Math.max(...scored.map(s=>s.res.score));
    const winners=scored.filter(s=>s.res.score===maxScore).map(s=>s.i);
    const share=Math.floor(layer.amount/winners.length);
    let remainder=layer.amount-share*winners.length;
    winners.forEach((wi,wIdx)=>{ game.seats[wi].chips+=share+(wIdx<remainder?1:0); allWinners.add(wi); });
    game.log.push(`Chia pot ${layer.amount}: ${winners.map(w=>game.seats[w].name).join(', ')}`);
  }
  game.pot=0; game.handOver=true; game.inHand=false; game.actingIndex=-1;
  recordHandHistory(game,[...allWinners]);
}

/* ---- Bot AI (reused) ---- */
let _lastEquitySig = null;
let _lastEquityMap = null;
function computeAllEquitiesCached(game){
  const contenders = seatedIndices(game).filter(i=>!game.seats[i].eliminated&&!game.seats[i].folded);
  const sig = game.board.map(c=>c.r+c.s).join(',') + '|' + contenders.join(',');
  if(sig === _lastEquitySig) return _lastEquityMap;
  _lastEquitySig = sig;
  _lastEquityMap = computeAllEquities(game);
  return _lastEquityMap;
}
function clampRaiseTotal(game,idx,desiredTotal){
  const p=game.seats[idx];
  const maxTotal=p.betThisRound+p.chips;
  let total=Math.min(desiredTotal,maxTotal);
  const minTotal=game.currentBet+game.minRaise;
  if(total<minTotal)total=Math.min(minTotal,maxTotal);
  return total;
}
function computeAllEquities(game){
  const contenders=seatedIndices(game).filter(i=>!game.seats[i].eliminated&&!game.seats[i].folded);
  if(contenders.length<2) return {};
  const need=5-game.board.length;
  const knownCards=[];
  contenders.forEach(i=>knownCards.push(...game.seats[i].cards));
  knownCards.push(...game.board);
  const usedKeys=new Set(knownCards.map(c=>c.r+c.s));
  const unknownDeck=makeDeck().filter(c=>!usedKeys.has(c.r+c.s));
  const wins=new Array(contenders.length).fill(0), ties=new Array(contenders.length).fill(0);
  let total=0;
  function tally(fullBoard){
    const scores=contenders.map(i=>evaluateBest([...game.seats[i].cards,...fullBoard]).score);
    const maxScore=Math.max(...scores);
    const winners=scores.reduce((acc,s,k)=>{if(s===maxScore)acc.push(k);return acc;},[]);
    if(winners.length===1)wins[winners[0]]++; else winners.forEach(k=>ties[k]++);
    total++;
  }
  if(need===0)tally(game.board);
  else if(need===1) for(const c of unknownDeck) tally([...game.board,c]);
  else if(need===2) for(const [a,b] of combos2(unknownDeck)) tally([...game.board,a,b]);
  else{
    const N=contenders.length<=3?3000:contenders.length<=6?1800:1000;
    for(let i=0;i<N;i++){const s=shuffle(unknownDeck);tally([...game.board,...s.slice(0,need)]);}
  }
  const map={};
  contenders.forEach((i,k)=>{ map[i]=((wins[k]+ties[k])/total)*100; });
  return map;
}
function botDecision(game,idx,equitiesMap){
  const p=game.seats[idx];
  const callAmt=game.currentBet-p.betThisRound;
  const contenderCount=Math.max(Object.keys(equitiesMap).length,2);
  const baseline=1/contenderCount;
  const strength=(equitiesMap[idx]!==undefined?equitiesMap[idx]/100:baseline);
  const personality=p.personality||'balanced';
  const aggression=personality==='loose'?0.65:personality==='tight'?0.3:0.48;
  const foldMult=personality==='tight'?1.2:personality==='balanced'?0.85:0.6;
  const raiseMult=personality==='tight'?1.8:personality==='balanced'?1.4:1.1;
  const potOdds=callAmt>0?callAmt/(game.pot+callAmt):0;
  const raiseThreshold=baseline*raiseMult;
  if(callAmt<=0){
    if(strength>raiseThreshold&&Math.random()<aggression+0.25&&p.chips>0){
      const desired=game.currentBet+Math.max(game.minRaise,Math.round(game.pot*(0.5+Math.random()*0.5))||BIG_BLIND);
      return{action:'raise',amount:clampRaiseTotal(game,idx,desired)};
    }
    return{action:'check'};
  }
  const required=baseline*foldMult+potOdds*0.3;
  if(strength+Math.random()*0.05<required){
    if(potOdds<0.3&&strength>required-baseline*0.8)return{action:'call'};
    return{action:'fold'};
  }
  if(strength>raiseThreshold&&Math.random()<aggression&&p.chips>callAmt){
    const desired=game.currentBet+Math.max(game.minRaise,Math.round(game.pot*0.7)||BIG_BLIND);
    return{action:'raise',amount:clampRaiseTotal(game,idx,desired)};
  }
  return{action:'call'};
}

/* Fairness note: bot decisions may use real opponent cards (bots aren't real players).
   But anything shown to a HUMAN must never be derived from another real player's hidden cards -
   otherwise the displayed number itself becomes an information leak. computeOwnEquity below
   only ever uses the viewer's own cards + board, treating opponents as random hands. */
function computeOwnEquity(game, mySeat){
  if(mySeat===null || mySeat===undefined) return null;
  const me = game.seats[mySeat];
  if(!me || me.folded || me.cards.length===0) return null;
  const opponents = seatedIndices(game).filter(i=>i!==mySeat && !game.seats[i].eliminated && !game.seats[i].folded);
  if(opponents.length===0) return null;
  const usedKeys = new Set([...me.cards, ...game.board].map(c=>c.r+c.s));
  const deck = makeDeck().filter(c=>!usedKeys.has(c.r+c.s));
  const need = 5-game.board.length;
  let wins=0, ties=0, total=0;
  const N = opponents.length<=3 ? 1500 : opponents.length<=6 ? 900 : 600;
  for(let iter=0; iter<N; iter++){
    const shuffled = shuffle(deck);
    let cursor=0;
    const oppHands = opponents.map(()=>{ const h=[shuffled[cursor],shuffled[cursor+1]]; cursor+=2; return h; });
    const restBoard = shuffled.slice(cursor, cursor+need);
    const fullBoard = [...game.board, ...restBoard];
    const myScore = evaluateBest([...me.cards, ...fullBoard]).score;
    const oppScores = oppHands.map(h=>evaluateBest([...h, ...fullBoard]).score);
    const maxOpp = Math.max(...oppScores);
    if(myScore>maxOpp) wins++; else if(myScore===maxOpp) ties++;
    total++;
  }
  return ((wins+ties)/total)*100;
}

module.exports = {
  makeDeck, shuffle, evaluate5, evaluateBest, MAX_SEATS, SMALL_BLIND, BIG_BLIND,
  createGame, seatedIndices, nextEligible, nextCanAct,
  startHand, processAction, advanceStreets, showdown,
  botDecision, computeAllEquities, computeAllEquitiesCached, computeOwnEquity, clampRaiseTotal
};
