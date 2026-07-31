/* ================= Tiến Lên (Southern-style, simplified) =================
   Rules implemented:
   - 52-card deck, no jokers, exactly 4 players, 13 cards each.
   - Rank order (low->high): 3 4 5 6 7 8 9 10 J Q K A 2
   - Suit order for single-card tiebreak (low->high): Spade < Club < Diamond < Heart
   - Combo types: single, pair, triple, straight (3+ consecutive ranks, no rank "2"),
     pair_seq (3+ consecutive pairs = a "bomb"), quad (four of a kind = a "bomb").
   - Whoever holds 3 of Spades leads the very first trick and must include it.
   - Normal combos must match the current trick's type+length and be strictly higher
     to beat it; leading a fresh trick (no current combo) can be anything.
   - Bombs (quad, pair_seq) can beat ANY current top combo, not just a lone "2"
     (a simplification of the traditional "chặt heo" rule, chosen so the engine
     doesn't need to special-case exactly when a bomb is "allowed" — this is a
     common house-rule variant, but let us know if your group plays it stricter).
   - Bomb strength tiers (more cards = stronger, ties broken by rank): quad(4 cards)
     < pair_seq-3(6 cards) < pair_seq-4(8 cards) < ... A stronger bomb can beat a
     weaker one; among the same tier, higher rank wins.
   - A trick ends when every other active player has passed since the last play;
     the last person to play leads the next trick with a clean slate.
   - The game ends as soon as ANY player empties their hand — that player wins.
     (Simplified: we don't continue play to rank 2nd/3rd/4th place.)
   - Chip settlement: each remaining player pays the winner
       unit * cardsLeft * multiplier
     where unit = the table's chip-per-card rate (500/5,000/25,000), and multiplier
     is 2x if they still hold a "2", plus another 2x (so 4x total) if they never got
     to play a single card ("cóng").
*/

const SUITS = ['S','C','D','H'];
const RANK_ORDER = {3:0,4:1,5:2,6:3,7:4,8:5,9:6,10:7,11:8,12:9,13:10,14:11,2:12};
const SUIT_ORDER = {S:0,C:1,D:2,H:3};
const RANKS_FOR_DECK = [3,4,5,6,7,8,9,10,11,12,13,14,2]; // display order doesn't matter for dealing

function makeDeck(){
  const deck = [];
  for(const s of SUITS) for(const r of RANKS_FOR_DECK) deck.push({r, s});
  return deck;
}
function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}
function cardPower(c){ return RANK_ORDER[c.r]*4 + SUIT_ORDER[c.s]; }
function cardKey(c){ return c.r+c.s; }
function sortHand(cards){
  return cards.slice().sort((a,b)=> cardPower(a)-cardPower(b));
}

/* ---------------- Combo classification ---------------- */
// Returns null if the given set of cards isn't a valid combo, otherwise an object:
// { type, length, rankValue, isBomb, bombTier, cards }
function classifyCombo(cards){
  if(!cards || cards.length===0) return null;
  const n = cards.length;
  const sorted = cards.slice().sort((a,b)=> RANK_ORDER[a.r]-RANK_ORDER[b.r]);
  const ranks = sorted.map(c=>RANK_ORDER[c.r]);

  if(n===1){
    return {type:'single', length:1, rankValue:ranks[0], power:cardPower(sorted[0]), isBomb:false, cards:sorted};
  }
  const allSameRank = ranks.every(r=>r===ranks[0]);
  if(n===2){
    if(allSameRank) return {type:'pair', length:2, rankValue:ranks[0], isBomb:false, cards:sorted};
    return null;
  }
  if(n===3){
    if(allSameRank) return {type:'triple', length:3, rankValue:ranks[0], isBomb:false, cards:sorted};
    if(isConsecutiveNoTwo(ranks)) return {type:'straight', length:3, rankValue:ranks[ranks.length-1], isBomb:false, cards:sorted};
    return null;
  }
  if(n===4){
    if(allSameRank) return {type:'quad', length:4, rankValue:ranks[0], isBomb:true, bombTier:4, cards:sorted};
    if(isConsecutiveNoTwo(ranks)) return {type:'straight', length:4, rankValue:ranks[ranks.length-1], isBomb:false, cards:sorted};
    return null;
  }
  // n >= 5
  if(isConsecutiveNoTwo(ranks) && new Set(ranks).size===n){
    return {type:'straight', length:n, rankValue:ranks[ranks.length-1], isBomb:false, cards:sorted};
  }
  if(n % 2 === 0 && n>=6){
    const pairSeqInfo = checkPairSequence(sorted);
    if(pairSeqInfo) return {type:'pair_seq', length:n/2, rankValue:pairSeqInfo.highRank, isBomb:true, bombTier:n, cards:sorted};
  }
  return null;
}
function isConsecutiveNoTwo(sortedRankValues){
  const uniq = [...new Set(sortedRankValues)];
  if(uniq.length !== sortedRankValues.length) return false; // no duplicates allowed in a straight
  if(uniq.includes(RANK_ORDER[2])) return false; // "2" can never be part of a straight
  for(let i=1;i<uniq.length;i++){ if(uniq[i] !== uniq[i-1]+1) return false; }
  return true;
}
function checkPairSequence(sortedCards){
  // sortedCards.length is even and >=6; must be N consecutive ranks, each appearing exactly twice, none being "2"
  const counts = {};
  for(const c of sortedCards) counts[RANK_ORDER[c.r]] = (counts[RANK_ORDER[c.r]]||0)+1;
  const uniqRanks = Object.keys(counts).map(Number).sort((a,b)=>a-b);
  if(uniqRanks.length !== sortedCards.length/2) return null;
  if(uniqRanks.some(r=>counts[r]!==2)) return null;
  if(uniqRanks.includes(RANK_ORDER[2])) return null;
  for(let i=1;i<uniqRanks.length;i++){ if(uniqRanks[i]!==uniqRanks[i-1]+1) return null; }
  return { highRank: uniqRanks[uniqRanks.length-1] };
}

// Does `combo` legally beat `top`? (top may be null, meaning combo is leading a fresh trick)
function comboBeats(combo, top){
  if(!top) return true; // leading — anything valid is fine
  if(combo.isBomb && top.isBomb){
    if(combo.bombTier !== top.bombTier) return combo.bombTier > top.bombTier;
    return combo.rankValue > top.rankValue;
  }
  if(combo.isBomb && !top.isBomb) return true; // bomb beats any non-bomb top combo
  if(!combo.isBomb && top.isBomb) return false; // normal combo can never beat a bomb
  // neither is a bomb: must match type and length
  if(combo.type !== top.type || combo.length !== top.length) return false;
  if(combo.type==='single') return combo.power > top.power;
  return combo.rankValue > top.rankValue;
}

/* ---------------- Game state ---------------- */
function createGame(){
  return {
    seats: new Array(4).fill(null), // {name, isBot, userId, hand:[card,...], finished:bool, hasPlayedAnyCard:bool}
    deck: [], started:false, gameOver:false,
    trickTop: null,       // classified combo object of the current trick's top play, or null
    trickTopSeat: -1,
    actingIndex: -1,
    passedThisTrick: new Set(),
    log: [],
    winnerSeat: -1,
    lastPlays: {}         // seat -> array of cards just played (for UI animation), cleared each broadcast cycle by caller if desired
  };
}
function seatedIndices(game){ const out=[]; for(let i=0;i<4;i++) if(game.seats[i]) out.push(i); return out; }
function nextActiveSeat(game, i){
  for(let step=1; step<=4; step++){
    const idx = (i+step)%4;
    const p = game.seats[idx];
    if(p && !p.finished) return idx;
  }
  return -1;
}

const TURN_TIME_MS = 15000;

function startHand(game){
  const seated = seatedIndices(game);
  if(seated.length !== 4) return {ok:false, reason:'Cần đủ 4 người để bắt đầu ván Tiến Lên.'};
  game.deck = shuffle(makeDeck());
  let cursor = 0;
  for(const i of seated){
    game.seats[i].hand = sortHand(game.deck.slice(cursor, cursor+13));
    game.seats[i].finished = false;
    game.seats[i].hasPlayedAnyCard = false;
    cursor += 13;
  }
  game.started = true;
  game.gameOver = false;
  game.winnerSeat = -1;
  game.trickTop = null;
  game.trickTopSeat = -1;
  game.passedThisTrick = new Set();
  game.log = [];
  game.lastPlays = {};

  // find who holds 3 of Spades — they must lead
  let leader = -1;
  for(const i of seated){
    if(game.seats[i].hand.some(c=>c.r===3 && c.s==='S')){ leader = i; break; }
  }
  game.actingIndex = leader;
  game.mustIncludeThreeSpades = true; // only enforced for the very first play of the game
  game.turnDeadline = Date.now() + TURN_TIME_MS;
  return {ok:true};
}

// `cardKeys` = array of "rS" style keys identifying which cards from the player's hand to play.
function playCombo(game, seatIdx, cardKeys){
  if(!game.started || game.gameOver) return {ok:false, reason:'Ván chưa bắt đầu hoặc đã kết thúc.'};
  if(game.actingIndex !== seatIdx) return {ok:false, reason:'Chưa đến lượt bạn.'};
  const p = game.seats[seatIdx];
  const keySet = new Set(cardKeys);
  const chosen = p.hand.filter(c => keySet.has(cardKey(c)));
  if(chosen.length !== cardKeys.length) return {ok:false, reason:'Bài chọn không hợp lệ (không có trong tay bài).'};

  const combo = classifyCombo(chosen);
  if(!combo) return {ok:false, reason:'Tổ hợp bài không hợp lệ.'};

  if(game.mustIncludeThreeSpades){
    if(!chosen.some(c=>c.r===3 && c.s==='S')) return {ok:false, reason:'Lượt đầu tiên của ván phải có lá 3 Bích.'};
  }
  if(!comboBeats(combo, game.trickTop)) return {ok:false, reason:'Bài không đủ lớn để chặt bài trước đó.'};

  // remove chosen cards from hand
  const remaining = p.hand.filter(c => !keySet.has(cardKey(c)));
  p.hand = remaining;
  p.hasPlayedAnyCard = true;
  game.mustIncludeThreeSpades = false;
  game.lastPlays[seatIdx] = chosen;
  game.log.push({seat:seatIdx, name:p.name, action:'play', cards:chosen.map(c=>({r:c.r,s:c.s}))});

  game.trickTop = combo;
  game.trickTopSeat = seatIdx;
  game.passedThisTrick = new Set(); // everyone else needs to respond again

  if(p.hand.length === 0){
    p.finished = true;
    game.gameOver = true;
    game.winnerSeat = seatIdx;
    game.log.push({seat:seatIdx, name:p.name, action:'win'});
    settleHand(game);
    return {ok:true};
  }

  advanceTurnAfterPlay(game, seatIdx);
  return {ok:true};
}

function passTurn(game, seatIdx){
  if(!game.started || game.gameOver) return {ok:false, reason:'Ván chưa bắt đầu hoặc đã kết thúc.'};
  if(game.actingIndex !== seatIdx) return {ok:false, reason:'Chưa đến lượt bạn.'};
  if(!game.trickTop) return {ok:false, reason:'Bạn đang được quyền ra bài đầu, không thể bỏ lượt.'};
  game.passedThisTrick.add(seatIdx);
  game.log.push({seat:seatIdx, name:game.seats[seatIdx].name, action:'pass'});
  advanceTurnAfterPlay(game, seatIdx);
  return {ok:true};
}

function advanceTurnAfterPlay(game, justActedSeat){
  const others = seatedIndices(game).filter(i => i!==game.trickTopSeat && !game.seats[i].finished);
  const stillToRespond = others.filter(i => !game.passedThisTrick.has(i));
  if(stillToRespond.length === 0){
    // trick is over — the top player leads a fresh trick
    game.trickTop = null;
    game.passedThisTrick = new Set();
    const leader = game.seats[game.trickTopSeat] && !game.seats[game.trickTopSeat].finished
      ? game.trickTopSeat
      : nextActiveSeat(game, game.trickTopSeat);
    game.actingIndex = leader;
    game.turnDeadline = leader===-1 ? null : Date.now() + TURN_TIME_MS;
    return;
  }
  game.actingIndex = nextActiveSeat(game, justActedSeat);
  game.turnDeadline = game.actingIndex===-1 ? null : Date.now() + TURN_TIME_MS;
}

function settleHand(game){
  const stake = game.stakeForScoring || 500;
  const unit = stake; // `stake` now directly represents the chip-per-card rate
  const results = [];
  for(const i of seatedIndices(game)){
    const p = game.seats[i];
    if(i === game.winnerSeat) continue;
    const cardsLeft = p.hand.length;
    const holdsTwo = p.hand.some(c=>c.r===2);
    const neverPlayed = !p.hasPlayedAnyCard;
    let mult = 1;
    if(holdsTwo) mult *= 2;
    if(neverPlayed) mult *= 2;
    const pay = cardsLeft * unit * mult;
    results.push({seat:i, name:p.name, cardsLeft, holdsTwo, neverPlayed, pay});
  }
  game.settleResults = results;
}

/* ---------------- Simple legal-move bot (validated via simulation) ---------------- */
function groupByRank(hand){
  const map = {};
  for(const c of hand){ map[c.r] = map[c.r] || []; map[c.r].push(c); }
  return map;
}
function findStraightsOfLength(hand, length){
  const byRank = groupByRank(hand);
  const RANK_SEQ = [3,4,5,6,7,8,9,10,11,12,13,14];
  const out = [];
  for(let start=0; start+length<=RANK_SEQ.length; start++){
    const ranksSeq = RANK_SEQ.slice(start, start+length);
    if(ranksSeq.every(r => byRank[r] && byRank[r].length>=1)) out.push(ranksSeq.map(r => byRank[r][0]));
  }
  return out;
}
function findPairSeqOfLength(hand, numPairs){
  const byRank = groupByRank(hand);
  const RANK_SEQ = [3,4,5,6,7,8,9,10,11,12,13,14];
  const out = [];
  for(let start=0; start+numPairs<=RANK_SEQ.length; start++){
    const ranksSeq = RANK_SEQ.slice(start, start+numPairs);
    if(ranksSeq.every(r => byRank[r] && byRank[r].length>=2)) out.push(ranksSeq.flatMap(r => byRank[r].slice(0,2)));
  }
  return out;
}
function botChooseMove(hand, trickTop, mustIncludeThreeSpades){
  const byRank = groupByRank(hand);
  if(mustIncludeThreeSpades) return [hand.find(c=>c.r===3 && c.s==='S')];
  if(!trickTop) return [sortHand(hand)[0]];

  if(trickTop.type==='single'){
    const sorted = sortHand(hand);
    const beat = sorted.find(c => cardPower(c) > trickTop.power);
    if(beat) return [beat];
  } else if(trickTop.type==='pair'){
    for(const r of Object.keys(byRank)) if(RANK_ORDER[r] > trickTop.rankValue && byRank[r].length>=2) return byRank[r].slice(0,2);
  } else if(trickTop.type==='triple'){
    for(const r of Object.keys(byRank)) if(RANK_ORDER[r] > trickTop.rankValue && byRank[r].length>=3) return byRank[r].slice(0,3);
  } else if(trickTop.type==='straight'){
    const candidates = findStraightsOfLength(hand, trickTop.length);
    for(const combo of candidates){
      const classified = classifyCombo(combo);
      if(classified && classified.rankValue > trickTop.rankValue) return combo;
    }
  }
  if(!trickTop.isBomb){
    for(const r of Object.keys(byRank)) if(byRank[r].length===4) return byRank[r].slice(0,4);
    const pairSeq3 = findPairSeqOfLength(hand, 3);
    if(pairSeq3.length) return pairSeq3[0];
  } else {
    for(const r of Object.keys(byRank)){
      if(byRank[r].length===4){
        const cand = classifyCombo(byRank[r].slice(0,4));
        if(cand.bombTier > trickTop.bombTier || (cand.bombTier===trickTop.bombTier && cand.rankValue>trickTop.rankValue)) return byRank[r].slice(0,4);
      }
    }
    const pairSeq3 = findPairSeqOfLength(hand, 3);
    for(const combo of pairSeq3){
      const cand = classifyCombo(combo);
      if(cand.bombTier > trickTop.bombTier || (cand.bombTier===trickTop.bombTier && cand.rankValue>trickTop.rankValue)) return combo;
    }
  }
  return null; // pass
}

module.exports = {
  makeDeck, shuffle, cardPower, cardKey, sortHand,
  classifyCombo, comboBeats,
  createGame, seatedIndices, nextActiveSeat, startHand, playCombo, passTurn, settleHand,
  RANK_ORDER, SUIT_ORDER, botChooseMove, TURN_TIME_MS
};
