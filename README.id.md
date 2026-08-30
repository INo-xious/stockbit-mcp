# Stockbit MCP

**Bawa Claude ke meja trading IDX Anda.**

Accepting donations: [Saweria Link](https://saweria.co/GUBS)

Bandarmologi, quote, orderbook, fundamental, watchlist dan portofolio Anda — dan, hanya kalau Anda
sendiri yang menyalakannya, order entry yang wajib dikonfirmasi — lewat akun Stockbit Anda sendiri,
dari Claude Desktop, Claude Code, Cursor, atau MCP client apa pun.

[English](README.md) | Bahasa Indonesia

> [!WARNING]
> **Tidak resmi dan tidak berafiliasi.** Proyek ini tidak berafiliasi dengan, tidak didukung, dan
> tidak disponsori oleh Stockbit, PT Stockbit Sekuritas Digital, maupun Bursa Efek Indonesia. Tidak
> ada satu pun keluarannya yang merupakan nasihat investasi, dan penulisnya bukan penasihat
> berlisensi.

> [!IMPORTANT]
> **Yang Anda butuhkan.** Akun Stockbit yang Anda login sendiri dengan username dan password — login
> Google dan Facebook rusak di situs Stockbit sendiri. Node.js 22 atau lebih baru. Browser keluarga
> Chromium (Chrome, Edge, Brave, Vivaldi) untuk login sekali di awal. `broker_distribution` juga
> butuh saldo Rp 10.000.000 — itu batasan Stockbit, bukan batasan proyek ini.

> [!NOTE]
> **Data Anda tetap milik Anda.** Semuanya jalan di komputer Anda, hanya bicara ke host API Stockbit
> sendiri dengan sesi Anda, dan menyimpan refresh token di macOS Keychain (file terenkripsi di
> sistem lain). Tidak ada apa pun yang dikirim ke penulis. Satu-satunya jalur keluar dari komputer
> Anda adalah webhook alert dan bot Telegram yang Anda konfigurasi sendiri.

> [!CAUTION]
> **API tidak terdokumentasi; trading mati secara default.** Proyek ini memakai JSON API privat di
> balik aplikasi Stockbit, yang bisa berubah tanpa pemberitahuan. Akses otomatis berpotensi
> bertentangan dengan Ketentuan Penggunaan Stockbit — pakai dengan risiko Anda sendiri, di akun Anda
> sendiri. Tidak ada satu pun di sini yang bisa mengirim order sebelum Anda menjalankan
> `stockbit-auth trading-enable` sendiri, di terminal.

![Aliran broker ke broker untuk satu saham selama sebulan](docs/images/broker-distribution-sample.svg)

<sub>Aliran antar-broker, dirender oleh server ini. Data sintetis.</sub>

---

## Cara kerjanya (dan kenapa aman dijalankan)

Ini **HTTP client, bukan bot**. Setiap angka yang dilaporkan berasal dari endpoint JSON di tabel
rute tertutup — tidak ada browser headless yang men-scrape halaman, tidak ada data yang dibaca dari
UI Stockbit, tidak ada loop polling yang tidak Anda mulai.

- **Satu kali login interaktif, ditangkap dari browser Anda sendiri.** Anda login di halaman asli
  Stockbit; server membaca refresh token dari respons dan menyimpannya. Password Anda tidak pernah
  menyentuh kode ini.
- **Tiga domain token, tiga penyimpanan terpisah** — `exodus` (data pasar), `carina` (Stockbit
  Sekuritas), `api-sekuritas` (e-IPO). Logout dari satu tidak menyentuh yang lain.
- **Access token tidak pernah ditulis ke disk.** Hanya refresh token yang disimpan, dan ia berotasi
  setiap kali dipakai.
- **Tabel rute tertutup.** 153 bentuk request yang diizinkan di tiga host. Apa pun di luar tabel itu
  tidak bisa diminta — ada test yang memastikannya.
- **Semua log dan semua hasil tool disensor.** Token, PIN dan bot token dicocokkan berdasarkan
  bentuk, bukan hanya nama kunci.
- **Trading adalah tangga yang Anda naiki sengaja**: `off` → `--paper` → `--live`. Environment hanya
  bisa **menurunkan** posisi Anda di tangga itu, tidak pernah menaikkan.

## Yang TIDAK dilakukan

- **Tidak ada tool yang menyentuh PIN.** PIN 6 digit diketik di terminal Anda, dipakai untuk satu
  request, dan tidak pernah disimpan. Kalau ada yang meminta PIN lewat asisten, itu bukan ini.
- **Tidak ada order tanpa tiket.** Secara default tool tulis juga memerlukan konfirmasi Anda, dan
  kalau klien Anda mendukung elicitation MCP Anda ditanya langsung — jawaban Anda yang menentukan,
  jadi menolak membatalkan order apa pun isi `confirm` yang dikirim model. Satu-satunya pengecualian
  adalah `--auto-confirm` dengan batas nilai, yang harus Anda aktifkan sendiri untuk live trading
  lewat terminal; model tidak bisa menyalakan atau menaikkan batasnya. Tool tidak menerima harga atau
  jumlah, jadi yang sampai ke bursa persis yang dijelaskan tiket.
- **Tidak pernah mengirim ulang otomatis, tidak pernah membatalkan otomatis.** Kalau hasil sebuah
  order tidak pasti, server mengatakannya dan berhenti.
- **Resep workflow tidak bisa menulis apa pun.** Dijamin oleh konstruksi kode, bukan oleh disiplin.
- **Tidak ada rute di luar tabel** — tidak ada penarikan dana, setoran, atau posting ke stream.
- **Tidak ada scraping.** Browser Anda dipakai untuk tiga hal saja: login sekali, menggambar di
  chart Anda sendiri, dan membuka Stockbit ketika Anda ingin melihatnya. Tidak ada data yang dibaca
  dari halaman.
- **Tidak ada short selling** dan **tidak ada nasihat keuangan**.

## Prasyarat

| | |
|---|---|
| **Akun Stockbit** | Username dan password. Login Google/Facebook rusak di sisi Stockbit. |
| **Node.js** | 22 atau lebih baru. |
| **Browser** | Keluarga Chromium untuk login sekali. Atau impor HAR dari browser apa pun. |
| **Rp 10.000.000** | Hanya untuk `broker_distribution`. Sisanya jalan tanpa itu. |

## Instalasi

**Claude Code**

```bash
claude mcp add --scope user stockbit -- npx -y stockbit-mcp
```

**Claude Desktop** — `claude_desktop_config.json`:

```json
{ "mcpServers": { "stockbit": { "command": "npx", "args": ["-y", "stockbit-mcp"] } } }
```

Di Windows, npx butuh shell:

```json
{ "mcpServers": { "stockbit": { "command": "cmd", "args": ["/c", "npx", "-y", "stockbit-mcp"] } } }
```

**Cursor / VS Code** — batas tool-nya 40 dan 128. Profil bawaan `core` berisi tepat 40 tool, jadi
tidak perlu diatur apa-apa. Untuk membuka semua 138 tool:

```json
{ "env": { "STOCKBIT_TOOLS": "all" } }
```

Instalasi lengkap untuk setiap client, termasuk Desktop Extension dan plugin Claude Code, ada di
[README bahasa Inggris](README.md#installation).

## Selalu versi terbaru

Semua konfigurasi di atas memakai `npx -y stockbit-mcp` tanpa nomor versi, dan itu disengaja: **npx
mengambil rilis terbaru setiap kali server dijalankan.** Versi baru sampai ke Anda saat client
berikutnya menjalankannya — tidak ada yang perlu dikerjakan.

Ini terukur, bukan asumsi: dengan 1.1.0 masih ada di cache npx, perintah `npx -y stockbit-mcp`
berikutnya menjalankan 1.1.1.

| Cara instalasi | Dapat versi baru otomatis? |
|---|---|
| `npx -y stockbit-mcp` | **Ya** — saat dijalankan berikutnya |
| `npm i -g stockbit-mcp` | Tidak. Jalankan `npm update -g stockbit-mcp` |
| Desktop Extension (`.mcpb`) | **Tidak.** Unduh `.mcpb` baru dari [Releases](https://github.com/INo-xious/stockbit-mcp/releases) |
| Dari source | Tidak. `git pull && npm ci && npm run build` |

Kalau ingin tetap di satu versi, kunci saja — `"args": ["-y", "stockbit-mcp@1.1.1"]`. Atau terima
perbaikan tanpa perubahan yang merusak: `"stockbit-mcp@^1"`. Proyek ini mengikuti semver, jadi hanya
rilis major yang bisa merusak setup Anda.

Detail lengkap ada di [README bahasa Inggris](README.md#staying-up-to-date).

## Mulai cepat

1. **Instal** — salah satu cara di atas.
2. **Login, sekali saja.** Bilang *"log me into Stockbit"* lalu login di jendela browser yang
   terbuka. Atau di terminal: `npx -y -p stockbit-mcp stockbit-auth login`.
3. **Restart client** Anda supaya tool-nya terbaca.
4. **Tanya: *"Is my Stockbit MCP working?"*** — Claude memanggil **`status`**: versi, sesi mana yang
   ada (tidak pernah token-nya), mode trading, posisi jam bursa dalam WIB, dan satu perintah
   berikutnya kalau ada yang kurang.
5. **Opsional — latihan dulu.** `stockbit-auth trading-enable --paper`, lalu *"beli 1 lot BBRI di
   akun paper"*. Tanpa uang sungguhan, tanpa PIN, protokolnya sama persis dengan yang asli.

## Contoh perintah

> "analisis BBRI"
> "siapa yang akumulasi GOTO bulan Juli"
> "distribusi broker BRMS"
> "technicals BBRI"
> "chart BBRI pakai bollinger bands dan panel MACD"
> "buatkan Pine untuk BBRI dengan alert golden cross"
> "buatkan alert kalau RSI BBRI di bawah 30"
> "deep dive BBRI"
> "jalankan morning scan"
> "gambarkan support dan resistance di chart BBRI"
> "saham watchlist mana yang kemarin diakumulasi broker"
> "hitung ukuran posisi BBRI: entry 4100, stop 3900, risiko 1% dari Rp 50 juta"

## Model keamanan

**Saklarnya.** Trading `off` sampai Anda sendiri menjalankan `stockbit-auth trading-enable --paper`
atau `--live`. `trading-enable` tanpa flag ditolak — dua pilihan itu berbeda sama sekali.
`STOCKBIT_TRADING` hanya bisa **menurunkan** mode; tidak ada nilainya yang menyalakan apa pun.

**PIN-nya.** Diketik di terminal Anda, dipakai satu request, tidak pernah disimpan. Tidak ada MCP
tool yang menerimanya.

**Protokol tiket.** `order_preview` menghitung dan memeriksa order lalu mengembalikan `summary` yang
Anda baca. Tool tulis hanya menerima id tiket dan konfirmasi opsional. Tiket kedaluwarsa dalam dua
menit dan membawa sidik jari yang diperiksa ulang tepat sebelum request dikirim.

**Siapa yang menyetujui.** Kalau klien Anda mendukung elicitation MCP, **Anda ditanya langsung,
sebelum `confirm` bahkan dilihat, dan jawaban Anda yang menentukan** — menolak berarti order
dibatalkan apa pun isi `confirm` yang dikirim model. Elicitation adalah satu-satunya jalur di MCP
yang sampai ke orang; `confirm: true` hanyalah boolean yang diisi model. Menganggap keduanya setara
adalah cacat nyata yang pernah ada di sini, diperbaiki oleh
[ADR-0010](docs/adr/0010-elicitation-is-decisive.md). Pada klien yang tidak bisa bertanya,
`confirm: true` adalah satu-satunya gerbang, order tetap jalan, dan hasil maupun baris audit
menyatakan dengan jelas bahwa tidak ada manusia yang ditanya. Model tidak boleh mengisi `confirm`
atas nama Anda.

Ada tiga saklar yang Anda pegang sendiri, semuanya diatur di terminal Anda dan tak satu pun bisa
disentuh tool mana pun:

| | |
|---|---|
| `trading-enable --elicitation required` | Tolak daripada mengirim kalau tidak ada orang yang bisa ditanya. `confirm: true` tidak pernah menggantikannya. |
| `trading-enable --elicitation when-available` | Tanya kalau kliennya bisa; jatuh ke `confirm: true` kalau tidak. **Default.** |
| `trading-enable --elicitation never` | Jangan tanya sama sekali. `confirm: true` satu-satunya gerbang. |
| `trading-enable --auto-confirm --max-order-value N` | Lewati langkah per-order sepenuhnya, di bawah batas nilai. Hanya live, dan diabaikan sama sekali kalau bertabrakan dengan `--elicitation required`. |

Dialog konfirmasi juga membawa kotak kedua yang **Anda** centang sendiri: jangan tanya lagi, selama
lima belas menit, untuk order yang nilainya tidak melebihi yang barusan Anda setujui, di bawah
kebijakan trading yang berlaku saat Anda mencentangnya. Ia hidup di memori server itu dan tidak
pernah di disk — restart mengakhirinya, `trading_forget` mengakhirinya di percakapan itu, dan
`stockbit-auth trading-forget` mengakhirinya di mana-mana termasuk server yang sedang berjalan.
`status` memberi tahu apakah ada yang masih aktif.

**Hasilnya.** Setelah menulis, `outcome` punya tujuh kelas. `ok` adalah satu-satunya sukses bersih;
`landed-despite-error` juga berarti order ditemukan saat dibaca ulang, tetapi request-nya error.
Untuk semua hasil selain `ok`: **jangan kirim ulang**. Mengirim ulang adalah bagaimana satu niat
menjadi dua order.

**Audit.** Setiap percobaan order dan setiap perubahan akun menambah satu baris ke log, tersensor,
apa pun hasilnya — dan kalau baris itu gagal ditulis, hasilnya mengatakan demikian.

Detail lengkap: [`docs/trading.md`](docs/trading.md) dan [`SECURITY.md`](SECURITY.md).

## Status verifikasi

Setiap tool membawa satu dari tiga kata:

- **Observed** — respons asli dari akun sungguhan pernah dilihat, dan kodenya ditulis berdasarkan
  itu.
- **Read-back** — penulisan yang efeknya diverifikasi dengan membaca ulang akun setelahnya. Bentuk
  request-nya mungkin masih tebakan, tapi tebakan yang salah muncul sebagai `not-visible`, bukan
  sebagai keberhasilan palsu.
- **Projected** — nama field diambil dari bundle web Stockbit, belum pernah dilihat pada respons
  sungguhan. Field yang tidak ada berarti "tidak dikenali", bukan nol.

**Projected bukan berarti rusak.** Artinya belum ada yang memeriksanya, dan kodenya ditulis supaya
tebakan yang belum diperiksa gagal dengan berisik, bukan diam-diam.

Keluarga **trading dan e-IPO belum pernah diamati secara langsung**. Rinciannya per keluarga ada di
[`docs/VERIFICATION.md`](docs/VERIFICATION.md).

## Referensi tool

138 tool dalam 17 keluarga. Referensi lengkapnya di [`docs/TOOLS.md`](docs/TOOLS.md) (dalam bahasa
Inggris, dan dibuat otomatis dari server sehingga tidak bisa basi).

## Penafian

Perangkat lunak ini untuk **penggunaan pribadi, edukasi dan riset**.

**Tidak berafiliasi dengan, tidak didukung, dan tidak disponsori oleh** Stockbit, PT Stockbit
Sekuritas Digital, maupun Bursa Efek Indonesia. Ketentuan Penggunaan Stockbit membatasi akses
otomatis ke layanan mereka, dan memakai perangkat lunak ini berpotensi bertentangan dengan ketentuan
itu; **penangguhan akun adalah konsekuensi yang mungkin terjadi** dan itu risiko Anda. API yang
dipakainya tidak terdokumentasi dan bisa berubah atau rusak kapan saja tanpa pemberitahuan.

**Tidak ada satu pun keluarannya yang merupakan nasihat investasi.** Penulisnya bukan penasihat
investasi berlisensi dan tidak terdaftar di OJK. Indikator, backtest, deteksi pola dan pembacaan
aliran broker adalah perhitungan atas data historis, bukan ramalan. Hasil backtest tidak
memprediksi imbal hasil di masa depan.

**Kalau Anda menyalakan live trading, perangkat lunak ini bisa mengirim order sungguhan yang
membelanjakan uang sungguhan.** Fitur itu mati secara default. Order membutuhkan konfirmasi eksplisit
— dan, kalau klien Anda bisa, persetujuan langsung dari Anda — kecuali Anda sendiri memilih
`--auto-confirm` dengan batas nilai atau `--elicitation never`. Anda sepenuhnya bertanggung jawab
atas setiap order yang dikirim, termasuk order di dalam batas yang Anda izinkan sebelumnya dan order
yang tercakup oleh "jangan tanya lagi" yang Anda centang sendiri.

Anda bertanggung jawab mematuhi ketentuan Stockbit, aturan IDX, dan hukum Indonesia.

Disediakan di bawah lisensi MIT, **tanpa jaminan apa pun**.

## Lisensi

[MIT](LICENSE) © Marvel Harisson
