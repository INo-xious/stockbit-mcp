# Stockbit MCP

Data pasar IDX, analisis, gambar pada Chartbit, portofolio riil **hanya baca**, dan simulasi trading
untuk Claude, ChatGPT, serta klien MCP lainnya. Proyek tidak resmi dan tidak berafiliasi dengan Stockbit.

**Eksekusi transaksi uang riil telah dihapus.** Tidak ada tool atau rute HTTP untuk beli, jual,
amend, cancel order riil, pemesanan e-IPO, deposit, atau penarikan. Pengaturan `live` lama ditolak.
Batasan teknis ini bukan pernyataan persetujuan atau sertifikasi kepatuhan OJK.

Gunakan checkout ini sampai perubahannya dirilis; paket npm yang sudah terbit tidak memuat perubahan
yang belum dirilis ini dan dapat masih memiliki tool transaksi uang riil.

```bash
npm ci
npm run build
node dist/bin/stockbit-auth.js login
node dist/bin/stockbit-auth.js status
```

Perlu Node.js 22+ dan browser Chromium. Login langsung di halaman Stockbit. Jangan kirim password,
OTP, atau PIN melalui chat. Untuk membaca portofolio sekuritas, jalankan
`node dist/bin/stockbit-auth.js trading-login` dan masukkan PIN di terminal sendiri.

- `portfolio`, `position`, `cash_balance`, `orders`: akun sekuritas riil, hanya baca.
- `virtual_*`: akun virtual di website Stockbit, menggunakan rute khusus `/virtualtrading/`.
- `paper_*`: ledger simulasi lokal yang terpisah; aktifkan dengan
  `node dist/bin/stockbit-auth.js trading-enable --paper`.
- `chartbit_*`: baca, gambar, screenshot, dan simpan chart dengan browser yang sudah login.

Profil default adalah `core`. Set `STOCKBIT_TOOLS=core,chartbit,virtual` untuk analisis, chart,
portofolio, dan simulasi website; gunakan `all` untuk seluruh tool yang didukung. Tidak semua fitur
website memiliki tool yang setara. Login, langganan dan perubahan API dapat membatasi akses.
Untuk koneksi lokal Claude, tetapkan `STOCKBIT_MCP_TRANSPORT=stdio`. Ekstensi Claude Desktop dari
checkout ini dapat dibuat dengan `npm run build:mcpb`; petunjuk instalasi ada di panduan klien.

Lihat [petunjuk lengkap](README.md), [konfigurasi Claude/ChatGPT](docs/CLIENTS.md),
[daftar tool](docs/TOOLS.md), dan [hasil verifikasi](docs/VERIFICATION.md).

`npm test` menjalankan pengujian terisolasi. Setelah login, `npm run verify:tools -- --live` menguji
panggilan baca melalui MCP dan mencatat tool yang gagal atau belum dapat diuji. Perintah ini tidak
mengubah akun atau membuat order. Proyek ini bukan nasihat investasi.
