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
