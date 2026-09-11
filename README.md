# Gestionale Ore Helper

MVP macOS che, dal lunedì al venerdì alle 10:00, 12:00, 14:00, 16:00 e 18:00:

1. chiede su quale cliente/commessa hai lavorato;
2. chiede una breve descrizione e la durata;
3. mostra un riepilogo da confermare;
4. registra l'intervallo su GestionaleOre.it.

Il JWT è salvato nel Portachiavi macOS; la password viene usata soltanto durante il setup e non viene conservata. Nel file di configurazione restano gli ID tecnici di utente, cliente, commessa e attività. L'helper impedisce inoltre il reinvio immediato dello stesso intervallo.

## Avvio

Serve Node.js 20 o successivo. Da questa cartella:

```bash
npm run setup
npm run dry-run
npm run doctor
npm run install-agent
```

Quando il JWT scade, puoi rinnovarlo senza riconfigurare i preset:

```bash
npm run login
```

`setup` effettua il login, rileva l'utente e le impostazioni aziendali, quindi fa scegliere cliente/commessa/attività disponibili. In modalità cliente puoi selezionare più voci nella stessa finestra con `⌘-clic` (oppure `Maiusc-clic` per un intervallo); ogni cliente diventa un preset. I preset già configurati restano salvati.

`dry-run` apre tutti i dialog ma non invia nulla. È il passaggio consigliato prima di attivare la pianificazione.

`install-agent` attiva i prompt feriali. Per disattivarli:

```bash
npm run uninstall-agent
```

## Backfill agosto 2026

Il comando seguente prepara il piano, risolve automaticamente i clienti e controlla le ore già presenti. Non invia nulla:

```bash
npm run backfill:august
```

Il piano copre tutti i 21 giorni feriali con 8 ore al giorno: 64h CSA/Football Exchange, 20h Tobetok, 10h Certyclick, 10h Martino Parisi e 64h EnerCoin. Usa giornate intere, tranne il 19 agosto, diviso in 4h Tobetok, 2h Certyclick e 2h Martino Parisi.

Se la simulazione non mostra conflitti, l'invio reale richiede sia `--apply` sia una conferma testuale intenzionale:

```bash
node src/cli.mjs backfill-august --year=2026 --apply --confirm=AGOSTO-2026
```

Prima dell'invio appare comunque un ultimo riepilogo macOS. Le registrazioni già presenti e perfettamente identiche vengono saltate, così un'esecuzione interrotta può essere ripresa. Qualsiasi altra voce esistente in una data del piano blocca l'intero backfill.

## Personalizzazione

La configurazione viene creata in:

```text
~/.config/gestionale-ore-helper/config.json
```

Puoi modificare `promptHours`, `workdays`, `intervalMinutes` e i nomi dei preset. Gli orari pianificati vengono riletti quando esegui di nuovo `npm run install-agent`.

## Endpoint ricostruiti

- `POST /auth/signin` — login e JWT
- `POST /auth/verify-2fa` — verifica 2FA
- `POST /auth/check-jwt` — utente e impostazioni
- `GET /customers/select` — clienti
- `GET /projects/assigned` — commesse assegnate
- `GET /projects/assigned/:id` — sotto-commesse
- `GET /activities/select` — attività
- `POST /hours` — inserimento ore

Il payload di inserimento segue il modulo web: `userId`, `customerId`/`projectId`/`subProjectId`, `activityId` oppure `activityFreeText`, `day`, `start`, `end`, `pause`, `qty`, `note`, `billingStatus`, `overtime` e `approved`.

## Limiti dell'MVP

- È pensato per macOS e usa dialog nativi, Portachiavi e LaunchAgent.
- Non registra nulla senza conferma esplicita nel riepilogo.
- Se il JWT scade, esegui `npm run login`; anche l'eventuale 2FA viene gestito lì.
- Gli endpoint non sono documentati pubblicamente: dopo un aggiornamento importante del gestionale può essere necessario adeguare il client.
