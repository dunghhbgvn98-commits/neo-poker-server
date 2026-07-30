-- Chạy đoạn này trong Supabase SQL Editor (an toàn, không xoá dữ liệu cũ)
-- Hàm RPC cộng/trừ hũ jackpot một cách nguyên tử (atomic) và trả về giá trị mới.
-- SECURITY DEFINER giúp hàm chạy với quyền của người tạo (thường là owner/service role),
-- nhờ đó bỏ qua được vấn đề Row Level Security (RLS) chặn quyền UPDATE của anon key
-- mà không cần tắt RLS trên bảng jackpot.
create or replace function increment_jackpot(delta bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  result bigint;
begin
  update jackpot
  set amount = greatest(0, amount + delta)
  where id = 1
  returning amount into result;

  if result is null then
    raise exception 'jackpot row (id=1) not found';
  end if;

  return result;
end;
$$;

-- Cho phép các role thường (anon, authenticated) được gọi hàm này
grant execute on function increment_jackpot(bigint) to anon, authenticated;
