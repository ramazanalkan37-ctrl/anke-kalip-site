# Ortak Liste ve Giriş Kurulumu (Firebase)

Sayfa şu an girişsiz çalışır ve her telefon kendi listesini tutar.
Aşağıdaki adımlar bir kez yapılınca:

- Sayfa e-posta + şifre ile giriş ister.
- İki telefon **aynı listeyi** görür; biri işaretleyince ya da ekleyince diğerinde anında görünür.
- İlk şifre ve unutulan şifre için e-postaya **şifre belirleme linki** gönderilir.

Firebase ücretsiz (Spark) planı bu kullanım için yeterlidir, kredi kartı gerekmez.

## 1. Proje oluştur
1. https://console.firebase.google.com adresine Google hesabınızla girin.
2. **Proje oluştur** → ad: `oglumuz-liste` → Google Analytics'i kapatın → Oluştur.

## 2. E-posta/Şifre girişini aç
1. Sol menü **Build (Derleme) → Authentication → Başlayın**.
2. **Sign-in method** sekmesi → **E-posta/Şifre** → ilk anahtarı **Etkinleştir** → Kaydet.
   (İkinci satır "E-posta bağlantısı (şifresiz)" kapalı kalsın.)
3. **Settings → Authorized domains** → **Alan ekle** → `ramazanalkan37-ctrl.github.io`
4. (İsteğe bağlı) **Templates** sekmesinde e-posta dilini **Türkçe** seçin.

## 3. Veritabanını oluştur
1. Sol menü **Build → Firestore Database → Veritabanı oluştur**.
2. Konum: Avrupa (ör. `eur3`) → **Production mode** → Oluştur.
3. **Rules (Kurallar)** sekmesine aşağıdakini yapıştırın, iki e-postayı kendi adreslerinizle değiştirin, **Yayınla**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /listeler/oglumuz/{rest=**} {
      allow read, write: if request.auth != null
        && request.auth.token.email_verified == true
        && request.auth.token.email in ['BIRINCI@ornek.com', 'IKINCI@ornek.com'];
    }
  }
}
```

Sadece bu listedeki, doğrulanmış e-postalar listeyi görebilir ve değiştirebilir.
E-postaları küçük harfle yazın.

## 4. Web uygulaması ayarlarını al
1. Sol üstte dişli → **Proje ayarları → Genel** → aşağıda **Uygulamalarınız** → **Web (`</>`)**.
2. Takma ad: `bebek-listesi` → Uygulamayı kaydet (Hosting kutusunu işaretlemeyin).
3. Gösterilen `const firebaseConfig = { ... }` bloğunu kopyalayın.
4. `bebek/index.html` içinde `const FIREBASE_CONFIG = null;` satırını bu blokla değiştirin
   (ör. `const FIREBASE_CONFIG = { apiKey: "...", authDomain: "...", ... };`).
   Bu bilgiler gizli değildir; erişimi 3. adımdaki kurallar korur.

## 5. İlk giriş
1. Sayfayı açın → **İlk kez mi giriyorsunuz? / Şifremi unuttum**.
2. E-postanızı yazın → **Şifre Linki Gönder**.
3. Gelen e-postadaki linkten şifrenizi belirleyin (Spam klasörüne de bakın).
4. Sayfaya dönüp e-posta + şifre ile giriş yapın.
   E-posta doğrulaması istenirse **Doğrulama Linki Gönder** → linke tıklayın → **Doğruladım**.

İlk giriş yapan kişinin telefonunda daha önce işaretlenmiş bir liste varsa ortak liste onunla başlar.
