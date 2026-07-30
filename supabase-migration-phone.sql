-- Chạy đoạn này trong Supabase SQL Editor (an toàn, không xoá dữ liệu cũ)
-- Thêm cột số điện thoại bắt buộc khi đăng ký (tài khoản cũ sẽ để trống, không sao)
alter table users add column if not exists phone text;
