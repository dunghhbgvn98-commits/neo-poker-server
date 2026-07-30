const bcrypt = require('bcryptjs');

function createDb(supabase){

  function validUsername(u){
    return typeof u==='string' && u.length>=3 && u.length<=20 && /^[a-zA-Z0-9_]+$/.test(u);
  }

  async function registerUser(username, password){
    username = (username||'').trim();
    if(!validUsername(username)){
      return {ok:false, reason:'Tên đăng nhập phải từ 3-20 ký tự, chỉ gồm chữ/số/gạch dưới.'};
    }
    if(!password || password.length<4 || password.length>72){
      return {ok:false, reason:'Mật khẩu phải từ 4 ký tự trở lên.'};
    }
    const { data: existing, error: findErr } = await supabase
      .from('users').select('id').ilike('username', username).maybeSingle();
    if(findErr) return {ok:false, reason:'Lỗi kết nối database: '+findErr.message};
    if(existing) return {ok:false, reason:'Tên đăng nhập đã tồn tại.'};

    const hash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase
      .from('users').insert({username, password_hash:hash, chips:5000}).select().single();
    if(error) return {ok:false, reason:'Lỗi tạo tài khoản: '+error.message};
    return {ok:true, user:data};
  }

  async function loginUser(username, password){
    username = (username||'').trim();
    const { data, error } = await supabase
      .from('users').select('*').ilike('username', username).maybeSingle();
    if(error || !data) return {ok:false, reason:'Sai tên đăng nhập hoặc mật khẩu.'};
    const match = await bcrypt.compare(password||'', data.password_hash);
    if(!match) return {ok:false, reason:'Sai tên đăng nhập hoặc mật khẩu.'};
    return {ok:true, user:data};
  }

  async function updateChips(userId, chips){
    const safeChips = Math.max(0, Math.round(chips));
    const { error } = await supabase.from('users').update({chips:safeChips}).eq('id', userId);
    return !error;
  }

  async function getUserById(userId){
    const { data, error } = await supabase.from('users').select('*').eq('id', userId).maybeSingle();
    if(error) return null;
    return data;
  }

  // Creates the admin account from env-provided credentials if it doesn't exist yet.
  // Never logs or stores the plaintext password anywhere.
  async function ensureAdmin(username, password){
    if(!username || !password) return;
    const { data } = await supabase.from('users').select('id,is_admin').ilike('username', username).maybeSingle();
    if(data){
      if(!data.is_admin){
        await supabase.from('users').update({is_admin:true}).eq('id', data.id);
      }
      return;
    }
    const hash = await bcrypt.hash(password, 10);
    const { error } = await supabase.from('users').insert({username, password_hash:hash, chips:999999, is_admin:true}).select().single();
    if(error) console.error('[db] ensureAdmin insert failed:', error.message);
  }

  /* ================= Slots / jackpot ================= */
  const DAILY_SPIN_LIMIT = 10;

  function todayStr(){
    return new Date().toISOString().slice(0,10); // YYYY-MM-DD, UTC-based day
  }

  async function getJackpot(){
    const { data, error } = await supabase.from('jackpot').select('amount').eq('id',1).maybeSingle();
    if(error || !data) return null;
    return data.amount;
  }

  async function addToJackpot(delta){
    const current = await getJackpot();
    if(current===null) return null;
    const next = current + delta;
    const { error } = await supabase.from('jackpot').update({amount:next}).eq('id',1);
    if(error) return null;
    return next;
  }

  async function resetJackpot(baseAmount){
    const { error } = await supabase.from('jackpot').update({amount:baseAmount}).eq('id',1);
    return !error;
  }

  // Checks the user's daily spin count (resetting it if it's a new day),
  // and if they still have spins left, consumes one and returns {ok:true, spinsRemaining}.
  // If they're out of spins for today, returns {ok:false, reason, spinsRemaining:0}.
  async function checkAndConsumeSpin(userId){
    const user = await getUserById(userId);
    if(!user) return {ok:false, reason:'Không tìm thấy tài khoản.', spinsRemaining:0};
    const today = todayStr();
    let spinsToday = user.spins_today || 0;
    if(user.last_spin_date !== today){
      spinsToday = 0; // new day, counter resets
    }
    if(spinsToday >= DAILY_SPIN_LIMIT){
      return {ok:false, reason:`Bạn đã dùng hết ${DAILY_SPIN_LIMIT} lượt quay hôm nay, quay lại vào ngày mai nhé!`, spinsRemaining:0};
    }
    spinsToday += 1;
    const { error } = await supabase.from('users').update({spins_today:spinsToday, last_spin_date:today}).eq('id', userId);
    if(error) return {ok:false, reason:'Lỗi cập nhật lượt quay: '+error.message, spinsRemaining: DAILY_SPIN_LIMIT-(user.spins_today||0)};
    return {ok:true, spinsRemaining: DAILY_SPIN_LIMIT - spinsToday};
  }

  async function getSpinsRemaining(userId){
    const user = await getUserById(userId);
    if(!user) return 0;
    const today = todayStr();
    const spinsToday = (user.last_spin_date===today) ? (user.spins_today||0) : 0;
    return Math.max(0, DAILY_SPIN_LIMIT - spinsToday);
  }

  /* ================= Leaderboard / admin chip management ================= */

  // Returns ALL non-admin users with just the fields needed for the leaderboard.
  // Fetching everyone (not just a DB-side top-N) because a user's TRUE total also
  // includes chips currently in play at a table, which the caller merges in afterward —
  // so we can't rely on DB-only ordering to decide who's "top".
  async function getAllNonAdminUsers(){
    const { data, error } = await supabase.from('users').select('id,username,chips,is_admin').eq('is_admin', false);
    if(error) return [];
    return data || [];
  }

  async function getUserByUsername(username){
    const { data, error } = await supabase.from('users').select('*').ilike('username', (username||'').trim()).maybeSingle();
    if(error) return null;
    return data;
  }

  // Adjusts a user's DB chip balance by `delta` (can be negative). Clamped at 0.
  // Returns the new balance, or null if the user doesn't exist / update failed.
  async function adjustChips(userId, delta){
    const user = await getUserById(userId);
    if(!user) return null;
    const next = Math.max(0, Math.round(user.chips + delta));
    const ok = await updateChips(userId, next);
    return ok ? next : null;
  }

  return {
    registerUser, loginUser, updateChips, getUserById, ensureAdmin, validUsername,
    getJackpot, addToJackpot, resetJackpot, checkAndConsumeSpin, getSpinsRemaining, DAILY_SPIN_LIMIT,
    getAllNonAdminUsers, getUserByUsername, adjustChips
  };
}

module.exports = { createDb };
