const bcrypt = require('bcryptjs');

function createDb(supabase){

  function validUsername(u){
    return typeof u==='string' && u.length>=3 && u.length<=20 && /^[a-zA-Z0-9_]+$/.test(u);
  }
  function validPhone(p){
    if(typeof p!=='string') return false;
    const digits = p.replace(/[\s\-\.]/g,'');
    return /^\+?\d{8,15}$/.test(digits);
  }

  async function registerUser(username, password, phone){
    username = (username||'').trim();
    if(!validUsername(username)){
      return {ok:false, reason:'Tên đăng nhập phải từ 3-20 ký tự, chỉ gồm chữ/số/gạch dưới.'};
    }
    if(!password || password.length<4 || password.length>72){
      return {ok:false, reason:'Mật khẩu phải từ 4 ký tự trở lên.'};
    }
    const cleanPhone = (phone||'').trim();
    if(!validPhone(cleanPhone)){
      return {ok:false, reason:'Số điện thoại không hợp lệ (8-15 chữ số).'};
    }
    const { data: existing, error: findErr } = await supabase
      .from('users').select('id').ilike('username', username).maybeSingle();
    if(findErr) return {ok:false, reason:'Lỗi kết nối database: '+findErr.message};
    if(existing) return {ok:false, reason:'Tên đăng nhập đã tồn tại.'};

    const hash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase
      .from('users').insert({username, password_hash:hash, chips:5000, phone:cleanPhone}).select().single();
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

  let lastJackpotError = null;
  function getLastJackpotError(){ return lastJackpotError; }

  async function getJackpot(){
    const { data, error } = await supabase.from('jackpot').select('amount').eq('id',1).maybeSingle();
    if(error){
      lastJackpotError = `Lỗi đọc bảng "jackpot": ${error.message} (code: ${error.code||'?'})`;
      console.error('[jackpot] getJackpot error:', error);
      return null;
    }
    if(!data){
      lastJackpotError = 'Bảng "jackpot" tồn tại nhưng không có dòng dữ liệu nào (id=1). Chạy lại phần INSERT trong file migration.';
      console.error('[jackpot] getJackpot: no row found with id=1');
      return null;
    }
    lastJackpotError = null;
    return data.amount;
  }

  // Atomically adjusts the jackpot pool via the increment_jackpot(delta) RPC function
  // (SECURITY DEFINER on the Postgres side), instead of a plain client-side read-then-write
  // .update() call. This avoids two problems with the old approach:
  //   1. RLS on the `jackpot` table blocking the anon key's UPDATE (the RPC runs with the
  //      function owner's privileges, bypassing that).
  //   2. A race condition between concurrent spins each doing their own read-then-write.
  // `delta` can be positive (adding to the pool) or negative (paying out a win).
  async function addToJackpot(delta){
    const { data, error } = await supabase.rpc('increment_jackpot', { delta });
    if(error){
      lastJackpotError = `Lỗi gọi RPC "increment_jackpot": ${error.message} (code: ${error.code||'?'})`;
      console.error('[jackpot] increment_jackpot RPC error:', error);
      return null;
    }
    // supabase-js can hand back a scalar, a single-row array, or an object depending on
    // how the function is declared — handle the common shapes defensively.
    let newAmount = null;
    if(typeof data === 'number') newAmount = data;
    else if(Array.isArray(data) && data.length>0){
      const row = data[0];
      newAmount = (typeof row === 'number') ? row : (row.new_amount ?? row.amount ?? row.increment_jackpot ?? null);
    } else if(data && typeof data === 'object'){
      newAmount = data.new_amount ?? data.amount ?? null;
    }
    if(newAmount===null || !Number.isFinite(Number(newAmount))){
      lastJackpotError = 'RPC "increment_jackpot" chạy thành công nhưng không trả về số hợp lệ. Kiểm tra lại định nghĩa hàm trên Supabase.';
      console.error('[jackpot] increment_jackpot returned unexpected shape:', data);
      return null;
    }
    lastJackpotError = null;
    return Number(newAmount);
  }

  async function resetJackpot(baseAmount){
    const { error } = await supabase.from('jackpot').update({amount:baseAmount}).eq('id',1);
    if(error){
      lastJackpotError = `Lỗi ghi vào bảng "jackpot": ${error.message} (code: ${error.code||'?'})`;
      console.error('[jackpot] resetJackpot error:', error);
      return false;
    }
    lastJackpotError = null;
    return true;
  }

  // Checks the user's daily spin count (resetting it if it's a new day),
  // Spins are unlimited — kept as a thin pass-through so callers don't need changing.
  async function checkAndConsumeSpin(userId){
    const user = await getUserById(userId);
    if(!user) return {ok:false, reason:'Không tìm thấy tài khoản.', spinsRemaining:0};
    return {ok:true, spinsRemaining:null};
  }

  async function getSpinsRemaining(userId){
    return null; // unlimited
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

  async function deleteUser(userId){
    const { error } = await supabase.from('users').delete().eq('id', userId);
    return !error;
  }

  return {
    registerUser, loginUser, updateChips, getUserById, ensureAdmin, validUsername,
    getJackpot, addToJackpot, resetJackpot, checkAndConsumeSpin, getSpinsRemaining, DAILY_SPIN_LIMIT,
    getAllNonAdminUsers, getUserByUsername, adjustChips, deleteUser, getLastJackpotError
  };
}

module.exports = { createDb };
