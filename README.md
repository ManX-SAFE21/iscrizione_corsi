# Corsi Bitcoin – iscrizioni su Umbrel

App self-hosted per gestire le iscrizioni ai corsi (base, medio, avanzato) in varie città.

- **Pagina pubblica**: elenco corsi in righe compatte diviso per livello (con filtri Base, Medio, Avanzato), date indicative, contatore "5 su 8", modulo di iscrizione. Nessun nome visibile al pubblico.
- **Pannello admin** (solo rete di casa, porta **9150**): crei i corsi, vedi chi si è iscritto e quante persone sono disponibili per ogni fascia, confermi la data.
- **Avviso Telegram** quando si raggiunge il minimo (e quando i posti sono esauriti).
- Dati in un file SQLite sul tuo Umbrel, QR code e caratteri in locale. Unici servizi esterni: Cloudflare Tunnel per raggiungere la pagina e Telegram per gli avvisi.

- **Pagina del corso completa**, come un modulo Google: immagine di copertina, presentazione, quando, dove (con il pulsante "Apri la mappa"), orari, contributo, partecipanti, scadenza delle prenotazioni, docenti, requisiti con icone, programma, locandina da scaricare, pulsanti Condividi (WhatsApp, Telegram, Facebook, X).
- **Pagamento in anticipo** facoltativo: se nel corso metti un indirizzo Bitcoin o Lightning, chi si iscrive può scegliere di pagare subito e vede i QR code.
- **Lista d'attesa** facoltativa, corso per corso: a posti esauriti ci si iscrive in lista (senza occupare posti, senza pagamento in anticipo); nel pannello la vedi a parte e con "Promuovi" passi una persona tra gli iscritti quando si libera un posto.
- **Pannello**: "Duplica corso" per riusare un corso già fatto, "Segna pagato" per ogni iscritto, "Scarica elenco" per aprire gli iscritti in Excel.

> Le comunicazioni agli iscritti (data e luogo) le fai tu a mano: nel pannello trovi la lista email da incollare in CCN, un pulsante "Scrivi a tutti" e la lista dei telefoni. I pagamenti in anticipo li controlli tu nel wallet e li segni come pagati nel pannello.

## Cosa NON è stato ancora provato

L'app è stata provata in locale con Node 22 (58 controlli automatici, più la prova dell'avviso Telegram con un finto Telegram). **Non è stata provata dentro Umbrel**: il passaggio da fare con attenzione è il punto 2 qui sotto. Se qualcosa non va, controlla la sezione *Se qualcosa non funziona* in fondo.

## Installazione

### 1. Metti il progetto su GitHub
1. Crea un repository **pubblico** (es. `corsi-umbrel-store`).
2. Carica **tutto il contenuto di questa cartella** (compresa `corsibtc-iscrizioni/data/.gitkeep`: serve, perché crea la cartella dati con i permessi giusti).

### 2. Aggiungi lo store su Umbrel e installa
1. In Umbrel apri **App Store**, menu **⋯** in alto a destra → **Community App Stores**.
2. Incolla l'URL del repository GitHub → **Aggiungi**.
3. Apri lo store "Corsi Bitcoin" e installa **Iscrizioni Corsi**.

Porte usate: **9160** (pagina pubblica, quella dell'icona Umbrel) e **9150** (admin). Se 9150 o 9160 sono occupate, cambiale in `docker-compose.yml` (riga `ports`) e in `umbrel-app.yml` (riga `port`).

### 3. Prima volta nel pannello admin
1. Apri `http://umbrel.local:9150/`.
2. Scegli una password (minimo 10 caratteri). Fallo **subito dopo l'installazione**: chi apre per primo questa pagina sceglie la password. Dopo 5 tentativi sbagliati l'accesso si blocca per 10 minuti.

### 4. Telegram (avvisi)
1. Su Telegram cerca **@BotFather** → `/newbot` → scegli nome e username. Ti dà un **token** (tipo `123456:ABC...`).
2. Apri una chat con il tuo nuovo bot e scrivigli "ciao".
3. Nel browser apri `https://api.telegram.org/bot<IL_TUO_TOKEN>/getUpdates` e cerca `"chat":{"id":NUMERO`. Quel numero è il **chat ID**.
4. Nel pannello: **Impostazioni** → incolla token e chat ID → Salva → **Invia messaggio di prova**.

### 5. Rendere la pagina raggiungibile da tutti (Cloudflare Tunnel)
Usa `cloudflared`, già installato sull'Umbrel: aggiungi un indirizzo pubblico che punta **solo alla porta pubblica 9160**. **Mai** alla 9150.

Le visite passano da Cloudflare, che vede l'indirizzo e il traffico verso la pagina; i dati degli iscritti restano salvati solo sull'Umbrel.

Quando hai l'indirizzo pubblico (tipo `https://corsi.tuodominio.it`), inseriscilo in **Impostazioni → Indirizzo pubblico**: da quel momento nel pannello compaiono link e QR code corretti.

### 6. Usare il sistema
1. **+ Nuovo corso** (oppure apri un corso già fatto e premi **Duplica corso**): livello, titolo, città, luogo preciso (privato, a meno che tu non scelga di mostrarlo), presentazione, fasce indicative (una per riga), orari, scadenza delle prenotazioni, minimo e massimo, requisiti, contributo, indirizzi per il pagamento in anticipo, programma, immagine di copertina. Con due caselle scegli se chiedere anche l'azienda e "come hai conosciuto questo corso".
   - **Programma**: una riga tutta in maiuscolo (es. `MATTINO`) diventa un titoletto, le righe che iniziano con `-` diventano un elenco.
   - **Requisiti**: uno per riga; l'icona viene scelta dalle parole (penna, smartphone, computer, connessione, corso...).
   - **Copertina**: JPG, PNG o WebP fino a 4 MB, meglio orizzontale.
   - **Locandina**: PDF oppure JPG, PNG o WebP fino a 10 MB; nella pagina del corso compare "Scarica la locandina".
2. Condividi il link del corso (o il QR) su Telegram/WhatsApp. Sui social il link mostra nome del corso, città, date e la copertina (o la locandina, se è un'immagine); per questo serve l'indirizzo pubblico in Impostazioni. Chi apre vede città, fasce, contatore e il modulo.
3. Quando arriva l'avviso Telegram, apri il corso: vedi **quante persone ci sono per ogni fascia** (con la migliore segnalata). Scegli la data e premi **Conferma corso**.
4. Scrivi agli iscritti con data e luogo. Con **Scarica elenco (Excel/CSV)** hai tutti gli iscritti in un file che si apre direttamente in Excel.
5. A corso finito, **elimina il corso**: cancella anche tutti gli iscritti (il modulo promette la cancellazione dei dati dopo il corso).

## Come funziona, in breve
- Un corso confermato **continua ad accettare iscrizioni fino al massimo**. Il corso sparisce dall'elenco pubblico solo se lo chiudi tu o se elimini.
- Se qualcuno viene eliminato dagli iscritti, il sistema riavvisa quando si ri-raggiunge il minimo.
- Anti-spam senza servizi esterni: campo trappola nascosto, tempo minimo di compilazione, massimo 20 invii/ora per indirizzo (più un tetto di 200 iscrizioni/ora in totale), un'email per corso.
- Il luogo preciso e la lista iscritti sono solo nel pannello admin.

## Backup
Tutti i dati sono nella cartella `~/umbrel/app-data/corsibtc-iscrizioni/data/` sul tuo Umbrel: `corsi.db` (corsi e iscritti) e la cartella `img/` (copertine e locandine). Copia tutta la cartella per fare un backup.

## Se qualcosa non funziona
- **L'icona di Umbrel chiede il login Umbrel** invece di mostrare i corsi: la riga `PROXY_AUTH_ADD: "false"` in `docker-compose.yml` non è stata accettata dalla tua versione di Umbrel. Dimmelo con la versione di umbrelOS e lo sistemo.
- **L'app non parte / errore di permessi su `/data`**: la cartella `data` deve esistere e appartenere all'utente di Umbrel. Per questo c'è `data/.gitkeep`. Controllo da SSH: `ls -ld ~/umbrel/app-data/corsibtc-iscrizioni/data`.
- **`/app/server.js` non trovato**: significa che Umbrel non ha copiato la cartella `app/` insieme al resto. In quel caso passo a un'immagine Docker già pronta (va pubblicata su Docker Hub).
- **I log**: da SSH, `docker logs corsibtc-iscrizioni_web_1`.
- **Porta già occupata**: cambia 9150 / 9160 come indicato al punto 2.

## Struttura del progetto
```
umbrel-app-store.yml            ← identifica lo store
corsibtc-iscrizioni/
  umbrel-app.yml                ← scheda app per Umbrel
  docker-compose.yml            ← avvio (immagine node:22-alpine, nessuna build)
  app/server.js                 ← l'app (zero dipendenze da installare)
  app/lib/qrcode.js             ← generatore QR (qrcode-generator, licenza MIT)
  app/fonts/                    ← caratteri Inter, Space Grotesk, Space Mono (licenza SIL OFL 1.1)
  data/.gitkeep                 ← cartella dei dati
```
