# Risposte per il Data-use disclosure e la Privacy practices

Questa scheda contiene **cosa scrivere nei moduli dello store** (Chrome Web Store / Microsoft Edge
Add-ons) per la sezione "Privacy practices". Copia/incolla i valori così come sono, dopo aver
compilato i segnaposto `[...]`.

---

## 1. Scopo unico (Single purpose)

> Riassumere con un clic la pagina web o il documento PDF attualmente aperto, usando il provider AI
> scelto dall'utente (Gemini, Groq, OpenRouter, OpenAI, Anthropic oppure Ollama in locale), con la
> possibilità di fare domande sul contenuto.

Non ci sono funzioni secondarie o non correlate.

## 2. Giustificazione dei permessi

| Permesso | Perché è necessario (testo da incollare) |
|----------|-------------------------------------------|
| `activeTab` | Leggere il contenuto della scheda attiva **solo quando l'utente preme "Riassumi"**. Nessun accesso continuo alla navigazione. |
| `scripting` | Iniettare la funzione di estrazione del testo nella scheda attiva (pagina o PDF) al momento del clic. |
| `storage` | Salvare localmente le impostazioni dell'utente e la chiave API (`chrome.storage.local`). |
| `host_permissions` (Gemini, Groq, OpenRouter, OpenAI, Anthropic, localhost) | Chiamare l'API del provider AI scelto dall'utente per generare il riassunto. Ollama (localhost) è la modalità locale senza servizi esterni. |
| `optional_host_permissions` (`https://*/*`, `http://*/*`) | Richiesto **a runtime e solo se necessario** per scaricare il PDF della scheda attiva quando `activeTab` non copre l'origine. L'utente vede una richiesta di permesso e può negarla. |

## 3. Codice remoto (Remote code)

Selezionare: **"No, non sto usando codice remoto."**

Motivo: l'estensione non scarica né esegue codice da remoto. La libreria `pdf.js` è **inclusa nel
pacchetto** (cartella `vendor/`). Le uniche chiamate di rete sono richieste dati alle API dei
provider scelti, non caricamento di script.

## 4. Categorie di dati (modulo "What data does your extension collect?")

| Categoria | Selezionare | Nota |
|-----------|-------------|------|
| **Authentication information** | Sì | La chiave API inserita dall'utente. Salvata **solo in locale** e trasmessa **solo** al provider scelto. |
| **Website content** | Sì | Il testo della pagina/PDF che l'utente sceglie di riassumere, inviato al provider scelto. |
| **Web browsing activity** | No | L'estensione non raccoglie cronologia né monitora la navigazione. |
| **Personal communications** | No | |
| **Location** | No | |
| **Financial / Health / Personal / User activity** | No | |
| **Personally identifiable information** | No | |

## 5. Certificazioni (spunte obbligatorie)

- [x] Non vendo né trasferisco dati a terzi al di fuori delle finalità dichiarate.
- [x] Non uso i dati per scopi non collegati allo scopo unico dell'estensione.
- [x] Non uso i dati per valutazioni creditizie o prestiti.
- [x] I dati non sono usati/usati per scopi non consentiti dalla **Limited Use** policy.

## 6. URL dell'informativa privacy

Serve un **URL pubblico** all'informativa (`PRIVACY.md` di questo progetto). Opzioni:

- **GitHub Pages**: attiva _Settings → Pages → Deploy from a branch → main / root_; l'informativa
  sarà su `https://<utente>.github.io/<repo>/PRIVACY.md` (meglio: crea `docs/privacy.html` o
  `privacy.html` per un rendering più pulito).
- In alternativa, qualunque pagina web pubblica di tua proprietà.

Incolla l'URL nel campo **Privacy policy URL** dello store.

## 7. Review notes (facoltativo ma utile)

> L'estensione agisce solo su clic dell'utente. Per provarla: apri un articolo o un PDF, clicca
> l'icona e premi "Riassumi". Non richiede account. Per il riassunto serve una chiave API del
> provider scelto (gratuita per Gemini/Groq/OpenRouter); in alternativa si può usare Ollama in
> locale senza chiave. La chiave è salvata solo localmente.

---

### ⚠️ Prima di pubblicare, completa:

1. Nome e email del titolare in `PRIVACY.md` (punti 1 e 11).
2. URL pubblico dell'informativa nel modulo dello store.
3. Verifica che il **comportamento** dell'estensione corrisponda a quanto dichiarato (disclosure
   coerente con il codice).