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

  return { registerUser, loginUser, updateChips, getUserById, ensureAdmin, validUsername };
}

module.exports = { createDb };
