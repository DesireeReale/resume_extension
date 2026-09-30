# Riassumi Pagina AI — Estensione Chrome (Manifest V3)

Riassume il contenuto della pagina web che stai visitando con un clic.
Di default usa **Google Gemini** (gratuito, richiede solo una chiave API gratuita).
Puoi scegliere anche **Groq** e **OpenRouter** (gratuiti), oppure **Ollama** in
locale, **OpenAI** e **Anthropic** dalle impostazioni.

## Struttura dei file

| File | Ruolo |
|------|-------|
| `manifest.json` | Configurazione MV3 + permessi (`activeTab`, `scripting`, `storage`) |
| `popup.html` | Interfaccia: pulsante "Riassumi", area di caricamento, box risultato, pannello impostazioni |
| `popup.css` | Stile moderno (tema scuro, pulsanti, spinner) |
| `popup.js` | Estrae il testo dalla pagina/PDF e orchestra la richiesta |
| `background.js` | Service worker: chiama l'API AI (sopravvive alla chiusura del popup) |
| `vendor/` | Libreria `pdf.js` (inclusa in locale, serve a leggere i PDF) |

## Installazione in Chrome (modalità sviluppatore)

1. Apri Chrome e vai su `chrome://extensions`.
2. Attiva **Modalità sviluppatore** (interruttore in alto a destra).
3. Clicca **Carica estensione non pacchettizzata**.
4. Seleziona la cartella di questo progetto (quella che contiene `manifest.json`).
5. L'estensione appare nella barra strumenti (icona puzzle → "Riassumi Pagina AI", puoi appuntarla).

## Avvio rapido (gratis, senza scaricare nulla)

Il modo più semplice per iniziare è **Google Gemini**, che ha un piano gratuito
senza carta di credito:

1. Vai su https://aistudio.google.com/apikey e crea una chiave API gratuita.
2. Apri il popup → ingranaggio **⚙**.
3. Provider: **Google Gemini — gratis**, incolla la chiave, **Salva impostazioni**.
4. Apri una pagina → **Riassumi**.

### Provider supportati

| Provider | Costo | Dove prendere la chiave | Modello di default |
|----------|-------|-------------------------|--------------------|
| **Google Gemini** | gratis | https://aistudio.google.com/apikey | `gemini-2.5-flash` |
| **Groq** | gratis | https://console.groq.com/keys | `openai/gpt-oss-120b` |
| **OpenRouter** | modelli `:free` gratis | https://openrouter.ai/keys | `meta-llama/llama-3.3-70b-instruct:free` |
| Locale (Ollama) | gratis, offline | nessuna | `llama3.1` |
| OpenAI | a pagamento | https://platform.openai.com/api-keys | `gpt-4o-mini` |
| Anthropic | a pagamento | https://console.anthropic.com/ | `claude-3-5-haiku-latest` |

> I piani gratuiti hanno limiti di richieste al minuto/giorno. Se ricevi un errore
> **429**, aspetta un momento o cambia provider. I nomi dei modelli cambiano nel
> tempo: se un modello dà errore, scrivine un altro nel campo **Modello**.

## Configurare la chiave API

1. Clicca l'icona dell'estensione, poi l'ingranaggio **⚙** in alto a destra.
2. Scegli il **Provider AI** e incolla la chiave nel campo **Chiave API**.
3. Clicca **Salva impostazioni**.

Con **Ollama** non serve alcuna chiave: il campo Chiave sparisce da solo.

La chiave è salvata **solo in locale** con `chrome.storage.local`: non è nel codice
sorgente e non viene inviata da nessuna parte se non direttamente al provider scelto.

> ⚠️ **Nota di sicurezza importante**
> Il codice dell'estensione è sempre leggibile dall'utente (è "non pacchettizzato").
> Una chiave salvata nel browser di ogni utente è adatta solo a **uso personale**.
> Per distribuire l'estensione ad altri, **non** far inserire la chiave a ciascuno:
> crea un piccolo backend proxy che custodisce la chiave lato server e chiama l'API
> per conto dell'estensione. In quel caso aggiungi il dominio del tuo server in
> `host_permissions`.
> Usando Ollama in locale la chiave non serve affatto e nessun dato esce dal tuo computer.

## Riassumere un PDF (anche scansionato)

1. Apri il PDF in una scheda di Chrome (l'URL finisce con `.pdf`).
2. Clicca l'icona dell'estensione: comparirà il badge **📄 PDF rilevato** e il pulsante diventa **Riassumi PDF**.
3. Clicca **Riassumi PDF**.

Come funziona:

- **PDF digitale** (contiene già il testo): il testo viene estratto in locale con `pdf.js`. Nessun dato esce dal computer per questa fase.
- **PDF scansionato** (foto di pagine, nessuno strato di testo): le prime pagine vengono convertite in immagini e il testo viene riconosciuto con **OCR tramite Gemini Vision**. Per questo serve una **Chiave Gemini per OCR** (campo dedicato in ⚙), separata dal provider di riassunto.

> L'estensione legge solo il PDF della scheda attiva (fino a 60 pagine per il testo, 20 per l'OCR). I PDF `file://` locali non sono supportati: aprili da una fonte online.

### Ottenere la chiave Gemini per OCR

1. Vai su **https://aistudio.google.com/apikey** (non Google Cloud Console: sono ambienti diversi).
2. Accetta i termini; per i nuovi account Google viene creato automaticamente un progetto con chiave.
3. Se vedi **"No Cloud Projects Available"** (capita quando l'account ha già un footprint Google Cloud), vai su
   **Dashboard → Progetti → Importa progetti**, crea/seleziona un progetto e genera lì la chiave.
4. Incolla la chiave in ⚙ → **Chiave Gemini per OCR** → **Salva impostazioni**.

## Test

1. Vai su una pagina con molto testo (es. un articolo di Wikipedia o di un blog).
2. Clicca l'icona dell'estensione → **Riassumi**.
3. Dopo qualche secondo compare il riassunto nel box. Usa **⧉** per copiarlo.

Se modifichi il codice, torna su `chrome://extensions` e clicca **Aggiorna** (↻) sulla
card dell'estensione. Per i file `background.js` serve sempre l'aggiornamento; per
popup e CSS basta riaprire il popup.

## Note

- Le pagine `chrome://`, il Chrome Web Store e altre pagine interne di Chrome non possono essere
  lette (limite di sicurezza di Chrome): l'estensione mostrerà un errore esplicativo.
- Il testo inviato all'AI è limitato a ~18.000 caratteri per contenere i costi.
- Per le pagine web bastano i permessi `activeTab` e `scripting` (nessun warning all'installazione).
- Per i PDF l'estensione chiede, **solo quando serve**, l'accesso all'origine del documento
  (`optional_host_permissions`): di norma `activeTab` è sufficiente, altrimenti compare una richiesta
  di permesso che l'utente può concedere o negare.

### Errore 403 di Groq (`Errore Groq (HTTP 403): Forbidden`)

Non è un bug dell'estensione: la richiesta arriva a Groq e viene **respinta da Groq**. Cause tipiche:

1. **Blocco IP/regione (Cloudflare)** — la più comune. Prova da un'altra rete (hotspot del telefono) o VPN.
2. **Account/organizzazione sospesa** o non conforme ai termini — controlla https://console.groq.com.
3. **Modello bloccato a livello progetto** — abilita il modello in https://console.groq.com/settings/limits.

Rimedi pratici: cambiare rete, oppure passare a un altro provider. **Ollama in locale** non ha questo
problema ed è completamente offline. Il messaggio d'errore dell'estensione ora riporta il corpo completo
della risposta, così si distingue il caso (JSON di permessi vs. blocco HTML di Cloudflare).

## Privacy

Informativa sulla privacy: https://desireereale.github.io/resume_extension/privacy.html

In sintesi: l'estensione agisce solo al clic su "Riassumi", il contenuto viene inviato **solo** al
provider AI che scegli, la chiave API resta **solo sul tuo dispositivo**, nessun tracciamento e nessun
server dello sviluppatore. Dettagli in [`PRIVACY.md`](PRIVACY.md).

## Licenza

Rilasciato con licenza **MIT** — vedi [`LICENSE`](LICENSE).

Copyright (c) 2026 desirèe.