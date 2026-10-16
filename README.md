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

Foreløpig tilgangskontroll er HTTP Basic med separate bruker- og adminkontoer.
Alle sider, kartdata og API-er unntatt `/health` krever innlogging.
Administrator kreves for sletting, rapportinnstillinger, intervallstart/stopp
og vindinnstillinger. Brukerkontoen kan sende posisjoner/målinger, se felles
måledata og sende rapport. Delte kontoer identifiserer ikke individuelle personer.
Bruk separate nettleserprofiler ved testing av bruker og admin.

Testutgaven starter uten innloggingssecrets: brukernavn `user` eller `admin`,
passord `aa` for begge. Dette er en enkel sperre mot feiltrykk i testen.
Følgende valgfrie miljøvariabler overstyrer testverdiene:

- `FIELDPOS_USER_USERNAME`, `FIELDPOS_USER_PASSWORD`
- `FIELDPOS_ADMIN_USERNAME`, `FIELDPOS_ADMIN_PASSWORD`

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
med riktige rettigheter. Ved behov kan innloggingsverdiene overstyres med en
privat env-fil. Ikke bruk kildekatalogen
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

`/mobile` og `/mobile/` viser et forenklet kart med GPS på/av, Geigerteller,
Norge og lenke til full visning. Samme innlogging og presence-backend brukes.
GPS startes bare etter trykk; HTTPS og nettlesertillatelse kreves på telefon.
Geigertelleren er den eksisterende treningssimulatoren, åpnet over kartet med
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
