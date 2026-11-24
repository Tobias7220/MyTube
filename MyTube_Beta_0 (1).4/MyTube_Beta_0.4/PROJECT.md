# MyTube – prosjektsammendrag (Beta 0.4)

## Hva er MyTube?
En personvernvennlig YouTube-frontend for skrivebordet med en egen, lokal anbefalingsmotor. Ingen konto, ingen server,
ingen sentral profil. Du eier feeden din: interessene dine tones ned over tid, og alt du kan stille på er synlig.
*Your feed. Your data. Your rules.*

## Versjoner
| Versjon | Innhold |
|---|---|
| 0.1 | Electron-app for Linux, Piped-instanser med helsesjekk og failover, scoring med halveringstid, søk, abonnement (manuelle), kategorivalg ved første start, yt-dlp som reserve |
| 0.2 | Spillelister, like/dislike (sterkere signal enn visning), enkel/avansert algoritme, kanalsider med yt-dlp-reserve |
| 0.3 | App-logg + diagnostikk + selvtest, sidebar, ny abonnementsside, kanalspillelister, sortering, auto quality, import/eksport i Takeout-formater |
| 0.4 | Feed-fiks for 1000+ abonnement, flere regioner, migrering av gamle innstillinger, sidebar uten topplinje (venstre/høyre/auto-skjul), eget vindu som kan dras, lastekø-regel (3 s), yt-dlp-forslag + ett-klikks installasjon, utviklermodus, ignorer-liste |

## Arkitektur
Alt kjører lokalt i en Electron-app (Linux først; samme kode går på Windows/macOS).

- `core/` (ren JavaScript, uten Electron – kan gjenbrukes på Android): `scoring`, `recommend`, `profile`, `formats`, `categories`, `logger`
- Videokilder: `piped` (offentlige Piped-instanser via `instances`: helsesjekk, failover, backoff for døde instanser), `ytdlp` (valgfri, lokal), `rss` (valgfri, YouTube-feeder), `install` (verifisert yt-dlp-installasjon)
- `main.js`: vindu, IPC, cache, oppdateringssløyfer (instanser hvert 5. min, nye videoer hvert 15. min, instansliste hvert 6. time), logg, import/eksport
- `renderer/`: grensesnittet (ingen rammeverk). Innstillinger styres av ett skjema (`FIELDS`)
- Tester: 31 stk, inkludert en smoketest som kjører hele hovedprosessen mot falsk Electron og falsk Piped

## Anbefalingsmotoren
1. Signaler: visninger (andel sett), likes (teller som N visninger), dislikes (negativt, skjuler videoen), kategorivalg (tones ned), pins og ignorerte ting
2. Alt forfaller med halveringstid (standard 21 dager); historikk slettes etter 30 dager
3. Score = kanal + tags/tittelord + kategori (skalert ned når det er lite data) + abonnementsboost + ferskhet
4. Feeden bygges med: andel reservert til abonnement, maks N videoer per kanal, straff for gjentakelser, 20 % utforskning av nye kanaler, spredning så samme kanal ikke står side om side
5. Kontroller: enkel (forhåndsvalg + 6 kontroller), utviklermodus (alle vekter), pins, dempede ord/kanaler, ignorer-liste, angre dislikes

## Hva forlater maskinen?
- Piped-instanser (søk, kanaler, strømmer) – de ser IP-en din
- Valgfritt: yt-dlp og RSS går rett til YouTube fra din IP (kan slås av)
- GitHub: instanslisten og (hvis du trykker) yt-dlp-nedlasting med sjekksumkontroll
- Aldri: profil, historikk, søkeord eller titler lagres eller sendes noe sted; loggen inneholder dem ikke

## Data (`~/.config/mytube/`)
`profile.json` (innstillinger, historikk, abonnement, spillelister, vurderinger), `cache.json`, `app.log`. Eksport/import i YouTube-formater og eget sikkerhetskopiformat.

## Kjente usikkerheter
- Jeg kan ikke kjøre appen selv: grensesnittet og nettverksdelen er testet av deg, ikke av meg
- Takeout-formatene er bygget fra hukommelsen; kanalspillelister via Piped («tabs») er uverifisert (yt-dlp tar over)
- Piped `/feed/unauthenticated` finnes i API-et, men grenser for store batcher er ukjent (selvtesten sjekker)
- Kategori finnes bare for få videoer; kanal-kategorier lærer appen gradvis
- RSS-feeder skiller ikke Shorts fra vanlige videoer
- Eget vindu uten systemlinje: kantene og endring av størrelse kan oppføre seg ulikt på Wayland (innstilling for systemlinje finnes)

## Plattformer og veikart
- Linux: kjører nå; AppImage via `npm run dist`; Flatpak ikke laget
- Windows/macOS: samme Electron-kode, ikke testet
- Android: egen app (React Native/Expo) som gjenbruker `core/`; yt-dlp finnes ikke der, så strømhenting må løses annerledes
- Apple/iOS: krever Apple-utviklerkonto og Mac, og samme strøm-problem som Android
- Idé å utrede: et JS-bibliotek som snakker med YouTube direkte (uten yt-dlp) for mobil

## Mål/krav (status)
Sidebar/vertikal ✓ · app-logg ✓ · kanalspillelister og sortering ✓ · auto quality ✓ · import/eksport i YouTube-formater ✓ ·
import/eksport av logg, abonnement, spillelister ✓ · like/dislike ✓ · tilpassbar algoritme (enkel + valgfri avansert + fjerne ting) ✓ ·
tilpasning ✓ · kategorier ◐ (valg og filter finnes, lite kategoridata) · Linux ✓ · Android ✗ · Apple ✗
