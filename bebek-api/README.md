# bebek-api – Ortak Liste Sunucusu (Railway)

`bebek/` sayfası GitHub Pages'te durur. Bu küçük sunucu iki kullanıcının ortak verisini Postgres'te tutar:

- **Aslanın Babası** ve **Aslanın Annesi** için şifreli giriş
- Ortak ihtiyaç listesi; bir telefonda yapılan değişiklik diğerinde anında görünür
- Her ürünün altında yorumlar
- Mesajlaşma
- Geçmiş: kim neyi işaretledi, ekledi, sildi, fiyatını değiştirdi, yorum yazdı

## Railway kurulumu (bir kerelik)

1. Railway'de projenizi açın (ya da **New Project**) → **+ New → GitHub Repo** → `anke-kalip-site`.
2. Oluşan servis → **Settings → Source → Root Directory**: `/bebek-api`
   (İsteğe bağlı **Watch Paths**: `/bebek-api/**`, böylece sadece sunucu değişince yeniden yüklenir.)
3. **+ New → Database → PostgreSQL** ekleyin.
4. Servis → **Variables**:

   | Değişken | Değer |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `KURULUM_KODU` | Sadece ikinizin bileceği bir aile kodu (ör. uzun bir cümle) |

5. Servis → **Settings → Networking → Generate Domain**. Çıkan adres (ör. `https://bebek-api-production.up.railway.app`) sunucunun adresidir.
6. Kontrol: o adresin sonuna `/api/health` ekleyip açın, `{"ok":true,...}` görmelisiniz.

## Telefonlarda ilk giriş

1. Sayfayı sunucu adresiyle bir kez açın:
   `https://ramazanalkan37-ctrl.github.io/anke-kalip-site/bebek/?api=SUNUCU_ADRESI`
   (Adres sayfanın içine sabitlendiyse sadece `.../bebek/` yeterli.)
2. **Aslanın Babası** veya **Aslanın Annesi**'ni seçin → ilk şifre ekranı açılır.
3. **Kod** kutusuna `KURULUM_KODU`'nu yazın, yeni şifrenizi iki kez girin → **Şifreyi Kaydet ve Giriş Yap**.
4. Sayfayı ana ekrana ekleyin (iPhone: Safari → Paylaş → Ana Ekrana Ekle; Android: Chrome → ⋮ → Ana ekrana ekle).

Şifre unutulursa: **İlk şifre oluştur / Şifremi unuttum** → aile kodu + yeni şifre.

## E-posta ile şifre kodu (isteğe bağlı)

Railway, Hobby planda e-posta (SMTP) gönderimini kapatır. Bu yüzden kodlar HTTPS üzerinden çalışan
[Resend](https://resend.com) ile gönderilir. Resend hesabı açıp şu değişkenleri ekleyin:

| Değişken | Değer |
|---|---|
| `RESEND_API_KEY` | Resend API anahtarı |
| `BABA_EMAIL` | Babanın e-postası |
| `ANNE_EMAIL` | Annenin e-postası |
| `RESEND_FROM` | (Alan adı doğruladıysanız) `Bebek Listesi <liste@alanadiniz.com>` |

Not: Resend, alan adı doğrulanmadan sadece Resend hesabını açan kişinin kendi adresine e-posta gönderir.
Eşinize de kod gitmesi için Resend'de bir alan adı doğrulayın; o zamana kadar aile kodu her zaman çalışır.

## Diğer ayarlar

| Değişken | Açıklama |
|---|---|
| `ALLOWED_ORIGIN` | Varsayılan `*`. Sadece GitHub sayfasına izin vermek için `https://ramazanalkan37-ctrl.github.io` |

## Yerelde çalıştırma

```
npm install
DATABASE_URL=postgres://... KURULUM_KODU=deneme node server.js
```
