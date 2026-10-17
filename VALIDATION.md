# Verifikasjon 2026-10-16

- Fem Python-tester: config/fallback/lesefeil, separate tilstandsfiler,
  autentisering/roller, private filer og posisjonspersistens.
- JavaScript-syntaks kontrolleres med `node --check app/static/fieldpos.js`.
- Docker-image bygget lokalt som `dsafieldpos-az:local` for linux/arm64.
- Prosess-/containertest: UID 10001, read-only rotfilsystem, skrivbar tmpfs,
  HTTP via Waitress, innlogging, 20 samtidige posisjonsskrivinger, omstart med
  bevarte data, SIGTERM med exit 0, config uendret og oppstartsfeil ved ugyldig
  eller uleselig config.
- Ingen autoritativ config er opprettet på SMB. Ingen reelle kontoer eller
  passord er opprettet. Testkontoer genereres i minnet.
- Ingen Azure-deploy, ACR-push eller endring i eksisterende Azure-ressurser.

## Åpne punkter

Forsøk på `docker build --platform linux/amd64` feilet i lokal legacy-builder:
`image ... does not provide the specified platform (linux/amd64)`.
Docker rapporterer også manglende buildx-komponent. linux/amd64-build og test
må derfor utføres i egnet builder, for eksempel en fungerende BuildKit/buildx-
builder eller en godkjent ACR-build, før deploy. Ingen installasjon eller
endring av lokal Docker-konfigurasjon er gjort.

Container-testene bruker tmpfs, ikke SMB. Lokal SMB- og Azure Files-semantikk,
monterte rettigheter og overlevelse av container-/revisjonsbytte er ikke
verifisert. Nettleser/GPS, MET, SMTP, iframe og endelig tilgangsmodell gjenstår.
Tilgangsmodellen er foreløpig Basic med bruker-/administratorrolle og er ikke
en beslutning om ekstern publisering.

## Mobilvisning

- Seks backend-tester består, inkludert begge mobilruter, tilgangskontroll og
  de nye statiske ressursene. JavaScript-syntaks er kontrollert.
- Nettleserkontroll ved 390 × 844: kart og knapper vises, dosimeter åpnes og
  «Til kartet» lukker dialogen. Tunge kartoverlegg utelates.
- Faktisk GPS på telefon og Key Vault er ikke testet/implementert.

## Forenklet testinnlogging

På brukerens anmodning har testutgaven innebygde standardverdier `user`/`aa`
og `admin`/`aa`. Oppstart krever dermed ingen innloggingssecrets. Miljøvariabler
kan fortsatt overstyre verdiene. Dette erstatter det tidligere kravet om at
innloggingsverdier alltid må leveres utenfra. SMTP er fortsatt avslått i
reservekonfigurasjonen og krever egne verdier hvis det aktiveres.

## Åpen testapp og mobilnavn

Innlogging fjernet på brukerens anmodning. Alle sider og administrasjons-API-er
åpnes uten konto/passord; tidligere beskrivelser av Basic-innlogging er historiske.
Mobilheader og sidetittel er endret til «DSA FieldPos Mobile». Tester kontrollerer
åpen tilgang uten miljøvariabler og korrekt header på begge mobilrutene.

## Mobil instrumentmeny 2026-10-17

Nettleserkontroll ved 390 × 844: felles header og fire venstrefelt, bytting mellom
Dosimeter og Måleskjema, samt innsending av en syntetisk måling til lokal,
midlertidig testlagring. Skjema og kart overlapper ikke. Dosimeterets tittel
«AKTUELL STRÅLING» vises hel. Ni backend-tester og JavaScript-syntakskontroll
består. Ingen Azure-deploy utført for denne endringen.

## Forenklet mobilskjema og MARKER hendelse

Nettleserkontroll 390 × 844: markering før start, under aktiv simulator og etter
stopp åpner ferdig utfylt skjema. Kartet er fjernet fra skjemaet. Hovedfelter og
Send inn er synlige uten scrolling; ekstra felt kan åpnes og rulles separat.
Lokal testinnsending verifiserte at 0,64 µSv/h lagres som 6,4e-7 Sv/h, med
instrument LCGT-01 og tydelig kommentar om treningssimulator/simulert posisjon.
Ni backend-tester og JavaScript-syntaks består. Ingen deploy utført.
