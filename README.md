# gestionaleore-mac-helper

Helper non ufficiale per macOS che rende più semplice registrare le ore su [GestionaleOre.it](https://www.gestionaleore.it/).

Durante la giornata apre un dialog nativo ogni due ore, chiede su quale cliente o commessa hai lavorato, raccoglie descrizione e durata e mostra un riepilogo prima dell'invio. Nessuna ora viene registrata senza una conferma esplicita.

## Funzionalità

- dialog nativi macOS, senza interfacce da lasciare aperte;
- selezione multipla dei clienti durante il setup;
- preset per cliente, commessa, sotto-commessa e attività, secondo la configurazione aziendale;
- promemoria feriali tramite LaunchAgent macOS;
- simulazione completa prima dell'invio;
- protezione dal reinvio immediato dello stesso intervallo;
- supporto al login con autenticazione a due fattori;
- JWT conservato nel Portachiavi macOS, non nei file del progetto.

## Requisiti

- macOS;
- Node.js 20 o successivo;
- un account valido su GestionaleOre.it;
- accesso alla rete per comunicare con `api.gestionaleore.it`.

## Avvio rapido

```bash
git clone https://github.com/danyeah/gestionaleore-mac-helper.git
cd gestionaleore-mac-helper
npm run setup
npm run dry-run
npm run doctor
npm run install-agent
```

`npm run setup` effettua il login, rileva l'utente e le impostazioni aziendali e mostra gli elementi disponibili. Se l'account usa la modalità cliente, puoi selezionare più clienti contemporaneamente:

- `⌘-clic` seleziona o deseleziona singole voci;
- `Maiusc-clic` seleziona un intervallo continuo.

Ogni cliente selezionato diventa un preset. I preset già presenti vengono mantenuti, quindi puoi ripetere il setup in seguito senza perdere la configurazione.

La password viene usata soltanto per effettuare il login e non viene salvata. Se è attiva la 2FA, il setup richiede anche il codice di verifica.

## Utilizzo quotidiano

Per aprire immediatamente il dialog e registrare un'attività:

```bash
npm run prompt
```

Il flusso chiede:

1. cliente o commessa;
2. breve descrizione del lavoro;
3. durata da registrare;
4. conferma finale del riepilogo.

Per provare lo stesso flusso senza inviare dati:

```bash
npm run dry-run
```

## Comandi

| Comando | Descrizione |
| --- | --- |
| `npm run setup` | Configura l'account e uno o più preset |
| `npm run login` | Rinnova il JWT senza riconfigurare i preset |
| `npm run prompt` | Apre il dialog e registra le ore dopo la conferma |
| `npm run dry-run` | Simula il flusso senza inviare dati |
| `npm run doctor` | Verifica sessione, collegamento e configurazione |
| `npm run install-agent` | Attiva i promemoria feriali automatici |
| `npm run uninstall-agent` | Disattiva i promemoria automatici |
| `npm run backfill:august` | Simula il backfill preconfigurato di agosto 2026 |
| `npm test` | Esegue la suite di test |

## Promemoria automatici

`npm run install-agent` installa un LaunchAgent per l'utente corrente. Per impostazione predefinita il prompt appare dal lunedì al venerdì alle 10:00, 12:00, 14:00, 16:00 e 18:00.

Per disattivarlo:

```bash
npm run uninstall-agent
```

## Configurazione

La configurazione locale viene salvata fuori dal repository:

```text
~/.config/gestionale-ore-helper/config.json
```

Le opzioni principali sono:

- `promptHours`: ore del giorno in cui mostrare il dialog;
- `workdays`: giorni della settimana attivi, con `1` per lunedì e `5` per venerdì;
- `intervalMinutes`: durata proposta dal prompt;
- `presets`: clienti, commesse e attività configurati.

Dopo aver modificato gli orari, esegui nuovamente `npm run install-agent` per aggiornare il LaunchAgent.

## Sessione e sicurezza

- Il JWT viene salvato nel Portachiavi macOS con il servizio `it.scalingparrots.gestionale-ore-helper.token`.
- La password non viene scritta su disco.
- Il file di configurazione contiene identificativi tecnici e viene creato con permessi limitati all'utente.
- La simulazione non effettua chiamate di scrittura.
- Ogni registrazione interattiva richiede una conferma finale.

Quando la sessione scade, rinnovala senza perdere i preset:

```bash
npm run login
```

## Backfill di agosto 2026

Il repository include una procedura una tantum, costruita per uno specifico piano di agosto 2026. Il piano copre 21 giorni feriali e 168 ore complessive, distribuite tra CSA/Football Exchange, Tobetok, Certyclick, Martino Parisi ed EnerCoin.

La simulazione risolve i clienti, legge le ore già presenti e non scrive nulla:

```bash
npm run backfill:august
```

L'invio reale richiede intenzionalmente sia `--apply` sia una frase di conferma:

```bash
node src/cli.mjs backfill-august --year=2026 --apply --confirm=AGOSTO-2026
```

Prima dell'invio viene mostrato un ulteriore riepilogo macOS. Le registrazioni identiche già presenti vengono saltate; qualsiasi voce diversa nelle date coinvolte blocca il backfill. Controlla sempre la simulazione prima di usare `--apply`.

## Integrazione con GestionaleOre.it

GestionaleOre.it non espone attualmente API pubbliche documentate per questo flusso. L'helper usa gli endpoint osservati nell'applicazione web:

- `POST /auth/signin`
- `POST /auth/verify-2fa`
- `POST /auth/check-jwt`
- `GET /customers/select`
- `GET /projects/assigned`
- `GET /projects/assigned/:id`
- `GET /activities/select`
- `GET /hours`
- `POST /hours`

Il client invia gli stessi campi principali del modulo web, inclusi utente, cliente o commessa, data, intervallo, pausa, quantità, descrizione e stato di fatturazione.

## Sviluppo

Il progetto non richiede dipendenze runtime esterne. Per verificare le modifiche:

```bash
npm test
node --check src/cli.mjs
node --check src/macos.mjs
```

Issue e pull request sono benvenute. Non includere nei ticket password, JWT, file di configurazione personali o payload contenenti dati riservati.

## Limiti e avvertenze

- Il progetto è pensato esclusivamente per macOS.
- È un helper non ufficiale e non è affiliato a GestionaleOre.it.
- Gli endpoint utilizzati non sono documentati pubblicamente e potrebbero cambiare.
- Verifica che l'automazione sia consentita dalle policy della tua organizzazione e dai termini del servizio.
- Il backfill incluso è specifico: non usarlo per mesi o account diversi senza averne controllato il piano nel codice.
