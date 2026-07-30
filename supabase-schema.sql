-- Bảng lưu tài khoản người chơi
create table users (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  password_hash text not null,
  chips bigint not null default 5000,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

-- Tên đăng nhập không phân biệt hoa thường khi tìm kiếm
create unique index users_username_lower_idx on users (lower(username));

-- Bảng lưu lịch sử ván bài (tuỳ chọn, để xem lại sau này)
create table hand_history (
  id uuid primary key default gen_random_uuid(),
  table_stake integer not null,      -- 1000 / 5000 / 10000
  played_at timestamptz not null default now(),
  board jsonb,
  results jsonb                       -- [{username, delta, chips_after}, ...]
);
