# Neo Poker — Multiplayer Server

Server Node.js + WebSocket cho Texas Hold'em nhiều người chơi thật qua mạng.

## Chạy thử trên máy của bạn
```
npm install
npm start
```
Sau đó mở trình duyệt tại `http://localhost:3000`

## Deploy lên Render (miễn phí)
1. Đẩy toàn bộ thư mục này lên một repo GitHub
2. Vào render.com → New → Web Service → chọn repo
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Instance Type: Free
6. Bấm Deploy

## Cấu trúc
- `server.js` — toàn bộ logic game (bài, cược, side-pot, AI bot) + WebSocket server
- `public/index.html` — giao diện người chơi, kết nối qua WebSocket
- Không có database — mọi dữ liệu (chip, lịch sử ván) chỉ tồn tại khi server đang chạy, mất khi restart
