# DSAFieldPos_Az

Selvstendig containerutgave av DSAFieldPos. Katalogen er et eget Git-repository;
overordnet repository ignorerer `map3/docker/`. Den opprinnelige lokale utgaven
utenfor denne katalogen er uendret. Ingen filer utenfor denne katalogen kreves
for Docker-bygg.

## Kode og montert disk

```text
Lokalt / build context             I Azure-containeren
app/                               /app/ (fra imaget)
app/defaults/DSAFieldPos.json        /app/defaults/DSAFieldPos.json (reserve)

argos-grib-tibrate/                 /data/ (Azure Files-mount)
└── DSAFieldPos_Az/
    ├── config/DSAFieldPos.json      /data/DSAFieldPos_Az/config/DSAFieldPos.json
    ├── state/wind_settings.json    /data/DSAFieldPos_Az/state/wind_settings.json
    └── online2/                    /data/DSAFieldPos_Az/online2/
```

Lokale `app/` er kildekode for imaget; den monteres ikke som kjørekode i Azure.
Monteringsskissen forutsetter at share-roten monteres på `/data`. Navnet på den
faktiske Azure Files-ressursen og sammenhengen med lokal SMB-mount må bekreftes
før deploy. Ikke monter build context som `/data/DSAFieldPos_Az`.

`config/` er reservert for autoritativ konfigurasjon på den monterte disken.
Innholdet ignoreres av Git og utelates fra Docker-build. Programmet oppretter,
kopierer eller endrer aldri denne config-filen. Bare fravær gir lesing direkte
fra reservefilen med advarsel. Ugyldig JSON, ugyldig grunnskjema og lesefeil gir
oppstartsfeil. Endringer i driftskonfigurasjon krever omstart.

Reservefilen har vind og mail avslått. Opprettelse av autoritativ config er en
manuell operatørhandling. Bruk reservefilens skjema som utgangspunkt. Aktivering
av MET krever en passende `wind.userAgent` med operativ kontaktinformasjon.
Vindvalg fra grensesnittet lagres separat i `state/wind_settings.json`.

`online2/` inneholder klientposisjoner, målelogg, rapportinnstillinger,
rapportstatus og genererte vindlag. Disse ligger på Azure Files og overlever
omstart. Stedsnavn, kommunedata, radnett og et statisk gamma-datasett bygges inn
som lesbare kartressurser. Oppdatering av disse er ikke automatisert her.
Midlertidige JSON-filer opprettes unikt i samme datakatalog som målfilen før
`replace`, slik at erstatning ikke krysser filsystemer. Øvrige arbeidsfiler og
serverens eventuell request-buffering bruker lokal `/tmp`.

## Oppstart og tilgang

Waitress kjører én prosess med fire HTTP-tråder på `0.0.0.0:8030`. Tilgang til
tilstand samordnes med prosesslokale låser. Vindjobber kjører med én felles
jobblås; mailintervallet kjører i en bakgrunnstråd. `SIGTERM` stanser planlegging
og venter begrenset på pågående arbeid. Lange nettverkskall kan forsinke stopp.

Start med `minReplicas: 1` og `maxReplicas: 1`. Det kreves en utrullingsrutine
som unngår samtidig skriving fra gammel og ny revisjon, eller en separat
verifisert distribuert leielås. Én replika per revisjon alene er ikke en garanti
mot overlapp. Ikke kjør den gamle separate vindlasteren mot de samme dataene.
Tailscale og desktop-launcher inngår ikke i containeren.

Testappen åpnes direkte uten innlogging på alle sider og API-er, inkludert
`/mobile` og `/mobile/dosimeter`. Det kreves ingen bruker-/administrator-
variabler. Administrasjonsfunksjoner er også tilgjengelige i den åpne testappen.
Blokkering av private filer og cross-site-forespørsler er beholdt.

Ved aktiv SMTP brukes dessuten `FIELDPOS_SMTP_USERNAME` og
`FIELDPOS_SMTP_PASSWORD`. Host, avsender og TLS-valg angis i configens `mail`.
Mail er avslått i reservefilen; ekte epostsending er ikke testet.

Tilgangsmodell må godkjennes før ekstern publisering. Bruk HTTPS ved ekstern
bruk. API-et har foreløpig beholdt gamle GET-operasjoner som endrer data;
nettleserforespørsler merket cross-site avvises. Videre overgang til POST med
CSRF-beskyttelse og eventuell Entra ID er aktuelt før offentlig bruk.

`GET /health` er en enkel prosess-/HTTP-liveness-test. Den kontrollerer ikke
Azure Files-tilgjengelighet eller friskhet på vinddata. Sett eksplisitte Azure
startup/readiness/liveness-prober på port 8030; Docker HEALTHCHECK alene er
ikke en Azure-probekonfigurasjon.

Programmet kjører som UID/GID `10001:10001`. Rettigheter til config må være
lesbare og datakataloger skrivbare for denne brukeren etter montering. Rettigheter
fra Docker-bygget løser ikke rettigheter på Azure Files.

## Bygg og test

Fra denne katalogen:

```sh
docker build -t dsafieldpos-az:local .
python3 -m unittest discover -s tests -v
```

Prosess-/containertest med testkontoer generert i minnet og data kun i tmpfs:

```sh
docker run --rm --read-only \
  --tmpfs /data:uid=10001,gid=10001,mode=0700 \
  --tmpfs /tmp:uid=10001,gid=10001,mode=0700 \
  --mount "type=bind,source=$(pwd)/tests,target=/tests,readonly" \
  dsafieldpos-az:local python /tests/smoke_process.py
```

For lokal testoppstart kreves ingen env-fil. Bruk en egen, klargjort datakatalog
med riktige rettigheter.  Ikke bruk kildekatalogen
som datakatalog. Bind publisert port til localhost under lokal testing:

```sh
docker run --rm --name dsafieldpos-az --read-only \
  --tmpfs /tmp:uid=10001,gid=10001,mode=0700 \
  --mount type=bind,source=/absolutt/sti/til/share-root,target=/data \
  -p 127.0.0.1:8030:8030 dsafieldpos-az:local
```

## Før Azure-deploy

- Verifiser linux/amd64-image for Azure, og test samme plattform.
- Verifiser faktisk Azure Files/SMB-mount som UID 10001: lesing, skriving,
  append, samtidig tilgang, fsync, replace, sletting og omstart/persistens.
- Verifiser at config-hash er uendret, og at manglende/ugyldig/uleselig config
  gir forventet resultat også på den faktiske mounten.
- Test nettleser/GPS over HTTPS, MET, SMTP, riktig tilgang og utrullingsrutinen.
- Avklar HTTPS-tilgang og innrammingspolicy for Combined View. Ingen ferdig
  CSP/frame-ancestors-policy eller iframe-test inngår ennå.

Mulige eksisterende ressurser, foreløpig ikke kontrollert:
`rg-azurelab-tibrate`, `cae-nexus-tibrate`, `acrnexustibrate.azurecr.io`.
Ingen Azure-ressurser er opprettet eller endret.

## Mobilvisning

`/mobile` og `/mobile/` viser et forenklet kart med GPS på/av, Dosimeter,
Norge og lenke til full visning. Samme presence-backend brukes; ingen innlogging kreves.
GPS startes bare etter trykk; HTTPS og nettlesertillatelse kreves på telefon.
Dosimeteret er den eksisterende treningssimulatoren, åpnet over kartet med
«Til kartet». Instrumentet lastes ut ved lukking; kartets aktive GPS beholdes.
Tunge valgfrie kartoverlegg lastes ikke på mobilvisningen.

Alle visninger som bruker den delte kartkoden får OpenStreetMap som standard.
Tidligere lagret «Lys»-valg faller tilbake til OpenStreetMap ved åpning; andre
eksisterende kartvalg beholdes. «Lys» kan fortsatt velges manuelt i full visning.
Ingen kartnøkkel eller Key Vault-integrasjon er lagt til i denne endringen.

## Avklart prioritering for første Azure-test

Brukeravklaring 2026-10-16: Første mål er å få appen til å kjøre i Azure og
bekrefte at funksjonene virker. Trackingdata i denne testen regnes ikke som
uerstattelige. Videre arbeid med versjons-/revisjonskontroll, utrullingsstrategi
og sterkere garantier for dataintegritet utsettes til etter funksjonstesten og
skal ikke blokkere første testdeploy. Dette innebærer ikke at Azure Files-
kompatibilitet eller dataintegritet er verifisert. Start med én replika.

Direkteadresse til dosimeteret: `/mobile/dosimeter` (og med avsluttende
`/`). Ingen innlogging kreves. Mobilknappen bruker også denne adressen.

Mobilheader og sidetittel: `DSA FieldPos Mobile`.

### Instrumentmeny på mobil

Dosimeteret og Måleskjema (samme registrering/innsending som A-knappen) deler
headeren «DSA FieldNexus» med «Til kartet» til høyre i det fargede feltet.
Venstremenyen har Dosimeter øverst, Måleskjema under og de to deaktiverte demoknappene LOGG og NEXUS ONLINE. Originalpaletten
beholdes, inkludert gullfeltet for NEXUS ONLINE uten gråtoning.
Skjema, feltverdier og kart/GPS beholdes ved bytting mellom instrument og skjema.
Skjemaet ruller separat på små skjermer. Direkte åpning av skjemaet støttes på
`/mobile?view=measure-a`. Den frittstående dosimetersiden lenker også dit.

### Rask registrering fra simulatoren

Mobilskjemaet viser stasjon, doserate i µSv/h, tidspunkt og posisjon. Kartet er
fjernet fra skjemaet. Øvrige opprinnelige felt finnes under «Flere felt / posisjon»;
kun skjemainnholdet ruller, mens Send inn ligger fast nederst.

«MARKER hendelse» tar et øyeblikksbilde av simulatorens viste verdi og tidspunkt,
åpner Måleskjema og fyller inn instrument og posisjon. Det virker før Start,
under kjøring og etter Stopp. Verdien og tidspunktet holdes fast mens skjemaet
fylles ut. Reell GPS fra kart/instrument brukes når tilgjengelig, ellers brukes
simulatorens demoposisjon med tydelig merking i skjema og kommentar. Doseraten
omregnes fra µSv/h til Sv/h for eksisterende API/CSV. Ingen automatisk innsending;
brukeren trykker Send inn og får en bekreftelse. Frittstående dosimeter overfører
markeringen via sessionStorage til `/mobile?view=measure-a`.

### Oppdatering av mobilfelter og GPS-navn

Ved hver GPS-aktivering vises valgt navn i en bekreftelsesdialog som kan redigeres.
Avbryt starter ikke GPS. Mobilskjemaet viser alle parametere fortløpende uten
sammenleggbare felt. Operatør (tidligere etikett Hendelse) og Målepunktnavn er
flyttet opp etter stasjon. Operatør, Målepunktnavn, Sesjon, Lag og Måletype starter
uten forhåndsverdi og har hjelpeteksten «<fyll inn>». Disse feltene er valgfrie.
Den gamle FOT-standardverdien er fjernet; ingen definisjon av koden finnes i
programkoden. API-feltet `event` beholdes for kompatibilitet med eksisterende
måleformat, men vises som Operatør i mobilskjemaet.
