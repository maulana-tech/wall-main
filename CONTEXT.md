# WTF Hackathon Summer Edition — Context

## Tentang
WTF (Write The Future) Hackathon Summer Edition adalah online builder challenge dari **iExec** untuk membangun use case di atas **Nox**, confidential smart contract layer milik iExec. Didukung oleh community partner **DeVinci Blockchain** (komunitas blockchain mahasiswa ESILV).

## Nox — Protocol Layer
Nox adalah confidential computing layer yang memungkinkan komputasi pada data terenkripsi sambil tetap mempertahankan composability penuh di DeFi. Nox menggabungkan smart contract on-chain dengan Trusted Execution Environment (TEE) off-chain untuk memproses data terenkripsi tanpa pernah meng-expose plaintext on-chain.

Dengan Nox, kontrak bisa memproses input terenkripsi, menjalankan komputasi secara privat, dan menjaga hidden balances — tanpa user harus ganti wallet atau developer harus rewrite contract dari nol.

## Inti Challenge
Ambil protokol open-source yang sudah nyata dan berdampak, lalu tambahkan lapisan privasi menggunakan Nox — atau bangun/gabungkan project yang benar-benar inovatif dengan Nox.

Target bukan sekadar proof-of-concept, melainkan integrasi protokol yang cukup rapi untuk berpotensi jadi produk nyata.

Ketentuan teknis utama:
- Protokol target pada dasarnya bersifat publik (bukan privacy-first by design).
- Privasi ditambahkan **di atas** protokol tersebut menggunakan Nox — lewat batching, layering, atau mekanisme lain.
- Underlying protocol **tidak boleh dimodifikasi**.
- Composability harus tetap terjaga (contoh: swap tetap bisa di-route lewat Nox tanpa merusak interoperabilitas).

## Target yang Disarankan (opsional — boleh ide lain)
- **Wallet**: MetaMask, Rabby, Rainbow → tambahkan privacy flow
- **DeFi**: Aave, Uniswap, Curve → route swap/lending lewat confidential contract Nox
- **Treasury**: Safe, Sablier, Superfluid → private payout, streaming, atau treasury moves

Project akan dinilai dari seberapa rapi integrasi Nox, seberapa besar privasi yang ditambahkan, dan seberapa dekat hasilnya dengan sesuatu yang bisa langsung dideploy perusahaan.

⚠️ **Diskualifikasi**: project yang reuse dari Vibe Coding Hackathon sebelumnya. Validasi ide project bisa dilakukan kapan saja ke tim iExec.

## Tim
Maksimal 5 peserta per tim. Bisa membentuk tim sebelumnya atau join saat hackathon dimulai (channel khusus di Discord tersedia untuk cari teammate).

## Cara Berpartisipasi
1. Join Discord iExec, masuk ke channel WTF hackathon.
2. Submit project dengan post di X (Twitter) yang berisi:
   - Deskripsi singkat project
   - Video demo aplikasi
   - Link GitHub repository (public & berfungsi)
   - Tag `@iEx_ec` di post

## Deliverables
- Public GitHub repository berisi:
  - Kode lengkap, open-source, dan bisa dilihat
  - README dengan instruksi instalasi & penggunaan yang jelas
  - Dokumentasi lengkap untuk setup, deployment, dan penggunaan dApp
  - Front-end yang fungsional
- Demo video singkat yang menunjukkan fungsionalitas dApp
- Orisinalitas terjaga dan menghormati hak kekayaan intelektual
- Jika mengintegrasikan iExec dev tools ke project yang sudah ada, wajib jelaskan mana yang sudah ada dan mana yang dikerjakan selama hackathon

## Kriteria Evaluasi
- Kreativitas project
- Project harus accessible dan berjalan end-to-end tanpa mock data
- Project harus dideploy di **ETH Sepolia**
- Wajib menyertakan `feedback.md` di repository berisi feedback terhadap tools iExec
- Video demo (durasi maksimal, singkat)
- Technical implementation: seberapa baik project confidential DeFi memanfaatkan Nox Protocol
- UX: apakah aplikasi user-friendly dan intuitif

## Resources
- Linktree lengkap Nox: https://linktr.ee/iexec.tech
- Dokumentasi Nox Protocol: https://docs.iex.ec/nox-protocol/getting-started/welcome
- Nox packages di npm: https://www.npmjs.com/org/iexec-nox?activeTab=packages
- Confidential Smart Contracts Wizard: https://cdefi-wizard.iex.ec/
- Nox Hardhat Plugin: https://github.com/iExec-Nox/nox-hardhat-plugin
- Nox Hardhat Starter: https://github.com/iExec-Nox/nox-hardhat-starter
- Discord iExec: https://discord.gg/RXYHBJceMe