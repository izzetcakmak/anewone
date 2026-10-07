# Sui Basecamp 1. gün: 40 milyon TPS'in arkasında ne var, ne yok

Sui'nin yıllık etkinliği Basecamp bu yıl Singapur'da, Marina Bay Sands'te, TOKEN2049 haftasının içinde. İlk gün 7 Ekim'de bitti, ikinci gün 8 Ekim'de devam ediyor. Ben salonda değildim; bu yazı resmi blog yazıları, programın kendisi ve günün haberlerinden derlendi. Kaynaklar en altta.

Günün manşeti belli: Sui sahnede canlı bir hız testi yaptı ve 40.614.180 TPS açıkladı. Rakam büyük, ama ne ölçtüğünü anlamadan bir anlamı yok. O yüzden önce onu açayım, sonra günün asıl hikâyesine, yani "ajanların parası"na geçeyim.

## 40 milyon TPS tam olarak ne?

Testi Mysten Labs'ın kurucu ortağı ve ürün şefi Adeniyi Abiodun yönetti. Oturumun adı "Break the World Record: Sui's TPS" idi, günün son oturumuydu. Hedef 20 milyon TPS olarak konmuştu. Önceki rekor 4 Temmuz'da kaydedilen 6.086.766 TPS idi.

Burada kritik ayrıntı şu: bu rakam Sui'nin ana zincirinin saniyede 40 milyon işlem kaydettiği anlamına gelmiyor. İşlemler "Sui tunnels" denen yapıların içinde gerçekleşti. Tunnel, Bitcoin'deki Lightning kanallarına benzeyen bir zincir dışı durum ve ödeme kanalı. Bir tunnel açmak için bir zincir üstü işlem, kapatmak için bir işlem daha gerekiyor. Aradaki binlerce hamle zincire yazılmıyor, kanal kapanınca iki tarafın imzaladığı sonuç Sui ana ağına yerleşiyor ve orada doğrulanabiliyor. Lightning'den farkı, tunnel'ların programlanabilir olması. Yani sadece ödeme değil, oyun hamlesi ya da sohbet mesajı da taşıyabiliyor.

Sahnedeki demoda salondakiler ve yapay zekâ ajanları 10 binden fazla tunnel açtı. Ekranda blackjack, poker, tic-tac-toe, amiral battı, ücretli sohbet mesajları ve bahşiş kutusu ödemeleri akıyordu. Sayaç yaklaşık 1,19 milyondan 2,62 milyona on beş saniyede çıktı, zirve rakamı oturumdan sonra açıklandı.

Abiodun'un cümlesi niyeti özetliyor: "Ajan ekonomisinde Sui'nin her etkileşimi işlemesi gerekmiyor. Hepsinin güven katmanı olması gerekiyor." Aynı şeyi sahnede "Sui'yi bir mahkeme gibi düşünün" diye de anlatmış. Hamleler dışarıda olur, anlaşmazlık ya da sonuç zincire gelir.

İki şerh düşmek lazım. Birincisi, bu rakam Solana'nın ya da Ethereum'un ana zincir TPS'iyle kıyaslanamaz, çünkü farklı şeyi ölçüyor. Tunnel içi aktiviteyi sayıyor, zincir sadece açılış ve kapanışı görüyor. Bu bir hile değil, ama elma ile armut. İkincisi, bağımsız denetim henüz yok. CertiK testi izledi, kanıtları, çalışma günlüklerini ve kayıtları inceleyip "önümüzdeki günlerde" rapor yayınlayacağını söyledi. CertiK'ten Yuannan Yang'ın ifadesi, sonuç ne çıkarsa çıksın onu yazacakları yönünde. Rapor çıkana kadar rakam Mysten'in rakamı.

Piyasa bu arada etkilenmedi; haberlerde SUI fiyatının gün içinde yaklaşık yüzde 6 düştüğü geçiyor. Rekorlar fiyat yapmıyor, bunu da not edelim.

## Asıl hikâye: ajanlara bütçe vermek

TPS şovu bir vitrin. Vitrinin arkasındaki ürün, Abiodun'un "The Machine Economy Won't Wait" (Makine ekonomisi beklemez) başlıklı açılış konuşmasında anlattığı model. Özeti şu: bir insan ya da şirket, bir yapay zekâ ajanına izin ve bütçe veriyor. Ajan bu bütçeyle hesaplama gücü, veri ya da finansal hizmet satın alıyor. Yüksek frekanslı kısım zincir dışında dönüyor, nihai hesaplaşma zincirde oluyor.

Bu modelin iki ayağı 1. günde isim buldu.

**Alibaba Cloud.** Duyuruya göre Alibaba Cloud'un bulut ve yapay zekâ kapasitesi Sui Agent Payments'a geliyor. Şirket, ajana stablecoin cinsinden bir bütçe ve politika tanımlıyor; ajan her servis çağrısını ayrı bir zincir üstü işlem olarak ödüyor. Aylık fatura yerine çağrı başına ödeme. Haberlerden birinin ifadesiyle "defter faturanın kendisi". Ayrıntı az: hangi stablecoin, hangi fiyatlar, hangi ürünler açıklanmadı ve Sui'nin Agent Payments dizininde bu servisler hâlâ "yakında" görünüyor. Alibaba Cloud'un kurumsal müşterilerinin gerçekten ajan cüzdanları üzerinden anlamlı bir harcama yapıp yapmayacağı sahnede cevaplanmadı.

**Google Cloud ve Verifiable Agent Arbiter.** Mysten Labs, Google Cloud ile VAA adını verdiği bir "kanıt katmanı" geliştiriyor. Amaç, bir şirketin ajanının kendisine verilen yetkinin içinde kaldığını kanıtlayabilmesi. Promptlar, model çıktıları, araç çağrıları ve politika kararları müşterinin kendi Google Cloud Storage alanında kalıyor, bunların kriptografik kanıtları Walrus'a yazılıyor, koordinasyon Sui üzerinde yapılıyor. Mysten bunu Avrupa'nın yapay zekâ yasasına da bağlıyor; 2027'den itibaren kayıt tutma ihlallerinde 15 milyon euroya ya da küresel cironun yüzde 3'üne varan cezalar geliyor. VAA henüz ürün değil, önce seçili kurumsal müşterilerde çalışacak.

Bu ikisi birlikte okununca Sui'nin iddiası netleşiyor: ajan harcar, Sui hesaplaşır, Walrus kanıtı saklar. Alibaba anlaşması harcama tarafı, VAA denetim tarafı.

## Programın geri kalanı

Ana sahnede Real Vision'dan Raoul Pal "Beyond the Everything Code" ile konuştu. EVE Frontier'ın başındaki Hilmar Veigar Pétursson ve Google DeepMind'dan Alexandre Moufarek "Who Inherits the Stars?" başlıklı ortak oturumdaydı. Eski CFTC komiseri, şimdi Sui Group Holdings'den Brian Quintenz "Who Writes the Rules?" söyleşisinde düzenleme tarafını anlattı. Walrus Foundation'dan Kimberly Logan Walrus'un yapay zekâdaki yerini, Power Dynamics'ten Jen Zhu ise "ajan ekonomisinin fiziğini" konuştu.

Yan sahnelerde DeFi ağırlıktaydı. Hudi sosyal trading ve perp ürünü için bir trading yarışması düzenledi. Beep, sohbetten canlı işleme giden ajan odaklı finans demosu yaptı. Hashi, Bitcoin'i köprülemeden ya da sarmadan Sui DeFi'ına getirme iddiasıyla ana ağa yaklaşıyor; asıl sunumu 2. günde Ryan Servatius yapacak. AI Builder Lab'de Dio Lougaris ajan hafızasını Walrus'ta tutmayı anlattı ve "Build an Agent That Never Forgets" atölyesini verdi.

## Yarın ne var?

2. günün ana sahnesinde Richard Socher (You.com) ile "The Future of Intelligence", Evan Cheng ile "What's Next?", Circle'dan Matt Stafford ve Grayscale'den Zach Pandl ile söyleşiler var. Günün sonunda Abiodun'un "One More Thing..." oturumu duruyor. Circle'dan HJ Chen ayrıca AI Builder Lab'de CCTP üzerine "Agent-Ready USDC" atölyesi veriyor. Stablecoin ve kurumsal taraf yarın konuşulacak.

## Benim okumam

Sui bu yıl "hızlıyız" demeyi bıraktı, "ajanların kullanacağı zincir biziz" diyor. 40 milyon rakamı bu iddianın reklamı; tunnel mimarisi, Alibaba anlaşması ve VAA ise iddianın parçaları. Üçü de henüz kanıtlanmış değil: CertiK raporu çıkmadı, Alibaba servisleri "yakında", VAA geliştirme aşamasında.

Takip edilecek üç şey: CertiK raporunun ne dediği, Agent Payments dizininde Alibaba servislerinin canlıya alınıp alınmadığı, ve ajanların gerçek dünyada bu bütçeleri harcayıp harcamadığı. Demo ile kullanım arasındaki fark burada belli olacak.

Bu bir etkinlik özetidir, yatırım tavsiyesi değildir.

## Kaynaklar

- Sui Basecamp 2026 resmi sayfa ve program: https://www.sui.io/basecamp
- Program PDF'i: https://cdn.prod.website-files.com/68e8e0120513ba12c5cd12e0/6ac3e417089e390f226c2fa3_Sui%20Basecamp%20Agenda.pdf
- Sui blog, etkinlik öncesi duyuru: https://www.sui.io/blog/the-agentic-economy-takes-sui-basecamp-2026-singapore
- Sui blog, TPS sonucu: https://www.sui.io/blog/sui-sets-record-for-highest-verified-throughput-settled-to-a-blockchain
- Sui X, TPS sonucu: https://x.com/SuiNetwork/status/2107753140162617740
- Sui X, VAA duyurusu: https://x.com/SuiNetwork/status/2107473798769574049
- HackerNoon, canlı test anlatımı: https://hackernoon.com/sui-hits-406-million-tps-live-in-singapore-with-certik-as-the-referee
- KuCoin, 1. gün özeti: https://www.kucoin.com/news/insight/SUI/6ac66cbe38a2640007930476
- Crypto Briefing, VAA: https://cryptobriefing.com/mysten-labs-google-cloud-verifiable-agent-arbiter/
- AIwire, VAA basın bülteni: https://www.hpcwire.com/aiwire/2026/10/06/mysten-labs-announces-verifiable-agent-arbiter-in-collaboration-with-google-cloud/
- Startup Fortune, Alibaba Cloud: https://startupfortune.com/sui-lets-ai-agents-pay-alibaba-cloud-in-stablecoins-for-every-single-task/
- The Crypto Times, CertiK incelemesi: https://www.cryptotimes.io/2026/10/07/sui-hits-40-6m-tps-in-basecamp-test-as-certik-reviews-results/

*İzzet Çakmak, izzetc.com*
