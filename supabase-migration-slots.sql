-- Chạy đoạn này trong Supabase SQL Editor (an toàn, không xoá dữ liệu cũ)
-- Thêm cột theo dõi lượt quay slots mỗi ngày cho từng tài khoản
alter table users add column if not exists spins_today integer not null default 0;
alter table users add column if not exists last_spin_date date;

-- Bảng lưu hũ jackpot dùng chung cho toàn bộ người chơi (chỉ có đúng 1 dòng)
create table if not exists jackpot (
  id integer primary key default 1,
  amount bigint not null default 500,
  constraint jackpot_single_row check (id = 1)
);
insert into jackpot (id, amount) values (1, 500) on conflict (id) do nothing;
