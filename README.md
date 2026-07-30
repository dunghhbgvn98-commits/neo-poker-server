# Neo Poker v2 — Tài khoản + Nhiều bàn theo mức chip

## Cần cấu hình trước khi chạy (biến môi trường)
| Tên biến | Giá trị |
|---|---|
| `SUPABASE_URL` | Project URL của bạn (https://xxxx.supabase.co) |
| `SUPABASE_ANON_KEY` | anon public key của bạn |
| `ADMIN_USERNAME` | `admin` (hoặc tên bạn muốn) |
| `ADMIN_PASSWORD` | `dung98` (mật khẩu admin — KHÔNG để trong code) |

## Chạy thử trên máy bạn
```
npm install
set SUPABASE_URL=https://xxxx.supabase.co
set SUPABASE_ANON_KEY=xxxxx
set ADMIN_USERNAME=admin
set ADMIN_PASSWORD=dung98
npm start
```
(Trên Mac/Linux dùng `export` thay vì `set`)

## Deploy lên Render
1. Đẩy code lên GitHub (ghi đè repo cũ hoặc tạo repo mới)
2. Trên Render, vào **Environment** của Web Service → thêm 4 biến môi trường ở bảng trên
3. Deploy như bình thường (Build: `npm install`, Start: `npm start`)

## Trước khi chạy lần đầu
Vào Supabase → SQL Editor → chạy file `supabase-schema.sql` (nếu chưa chạy) để tạo bảng `users`.

## Tính năng mới
- Đăng ký/đăng nhập, mật khẩu được mã hoá (không lưu dạng thường)
- Tài khoản mới nhận 5.000 chip
- 3 bàn theo mức cược: 1.000 / 5.000 / 10.000 — cần đủ chip mới vào được bàn tương ứng
- Số chip đồng bộ vào database khi rời bàn (không mất khi restart server)
- Tài khoản admin (`admin` / mật khẩu bạn đặt) có nút "Giám sát" ở mỗi bàn — xem được hết bài và tỉ lệ thắng của mọi người. Tự động tắt nếu admin đang ngồi chơi thật ở bàn đó.

## Giới hạn cần biết
- Nếu server bị restart đột ngột (crash) TRONG LÚC bạn đang ngồi chơi (chưa rời bàn), số chip đang "trên bàn" tại thời điểm đó sẽ không được lưu — chỉ số dư trước khi vào bàn mới chắc chắn an toàn. Đây là đánh đổi để giữ logic đơn giản, chấp nhận được vì đây là app chơi giải trí, không phải tiền thật.
