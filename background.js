/* =========================================================================
 * background.js — Service worker (Manifest V3).
 *
 * Ruolo: centralizzare la chiamata all'API AI.
 * Perché non farlo direttamente nel popup? Perché il popup viene DISTRUTTO
 * quando perde il focus (es. clicchi altrove): una fetch in corso verrebbe
 * annullata. Il service worker invece resta attivo abbastanza da completare
 * la richiesta e restituire la risposta.
 *
 * Provider supportati:
 *   - local        Ollama locale (nessuna chiave)
 *   - gemini       Google Gemini (free tier, richiede chiave gratuita)
 *   - groq         Groq (free tier, richiede chiave gratuita)
 *   - openrouter   OpenRouter (modelli ":free", richiede chiave gratuita)
 *   - openai       OpenAI (a pagamento)
 *   - anthropic    Anthropic Claude (a pagamento)
 * ========================================================================= */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  const handlers = {
    SUMMARIZE: { run: handleSummarize, key: "summary" },
    CHAT: { run: handleChat, key: "reply" },
    OCR: { run: handleOcr, key: "text" },
  };

  const handler = handlers[message.type];
  if (!handler) return;

  handler
    .run(message.payload)
    .then((result) => sendResponse({ [handler.key]: result }))
    .catch((err) => sendResponse({ error: err && err.message ? err.message : String(err) }));
  return true; // mantiene il canale aperto per la risposta asincrona
});

/* ------------------------------------------------------------------ *
 * Prompt
 * ------------------------------------------------------------------ */

function buildMessages({ text, language }) {
  const system =
    `Sei un assistente che riassume pagine web e documenti (PDF, trascrizioni). ` +
    `Scrivi il riassunto in ${language}. ` +
    `Sii chiaro e conciso: 3-6 frasi oppure un breve elenco puntato con i punti chiave. ` +
    `Non inventare informazioni non presenti nel testo. Non aggiungere commenti personali.`;

  const user = `Riassumi il seguente contenuto:\n\n${text}`;

  return { system, user };
}

function buildChatMessages({ question, context, language, history }) {
  const system =
    `Sei un assistente che risponde a domande su un contenuto fornito dall'utente ` +
    `(una pagina web oppure la trascrizione di un video). Rispondi in ${language}.\n` +
    `REGOLE TASSATIVE:\n` +
    `1) Rispondi SOLO alla domanda dell'utente.\n` +
    `2) NON ripetere, NON citare integralmente e NON riportare il documento di riferimento.\n` +
    `3) NON riscrivere il riassunto e non incollare il contenuto.\n` +
    `4) Se l'informazione richiesta non è nel documento, dillo chiaramente senza inventare.\n` +
    `5) Sii conciso e diretto (poche frasi o un breve elenco).`;

  let dialog = "";
  const recent = Array.isArray(history) ? history.slice(-8) : [];
  for (const m of recent) {
    if (!m || !m.content) continue;
    dialog += (m.role === "assistant" ? "Assistente" : "Utente") + ": " + m.content + "\n";
  }

  const trimmedContext = String(context).slice(0, 14000);

  const user =
    `Documento di riferimento (usalo SOLO per rispondere; non ripeterlo e non riportarlo):\n` +
    `"""\n${trimmedContext}\n"""\n\n` +
    (dialog ? `Conversazione precedente:\n${dialog}\n` : "") +
    `Domanda dell'utente: ${question}`;

  return { system, user };
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

async function handleSummarize(payload) {
  const { text } = payload;
  if (!text) throw new Error("Nessun testo da riassumere.");
  const { system, user } = buildMessages(payload);
  return callProvider(payload, system, user);
}

async function handleChat(payload) {
  const { question, context } = payload;
  if (!question || !question.trim()) throw new Error("Domanda vuota.");
  if (!context) throw new Error("Nessun contenuto di riferimento: fai prima un riassunto.");
  const { system, user } = buildChatMessages(payload);
  return callProvider(payload, system, user);
}

/**
 * OCR di uno o più pagine (immagini base64) tramite Gemini Vision.
 * Usato quando un PDF è scansionato e non contiene uno strato di testo.
 * Restituisce il testo riconosciuto, concatenato nell'ordine delle pagine.
 */
async function handleOcr(payload) {
  const { images } = payload;
  if (!Array.isArray(images) || !images.length) {
    throw new Error("Nessuna pagina da riconoscere per l'OCR.");
  }
  return callGeminiVision(payload, images);
}

/* ------------------------------------------------------------------ *
 * Router per provider
 * ------------------------------------------------------------------ */

function callProvider({ provider, model, apiKey }, system, user) {
  switch (provider) {
    case "local":
      return callOllama({ model, system, user });
    case "gemini":
      return callGemini({ apiKey, model, system, user });
    case "groq":
      return callGroq({ apiKey, model, system, user });
    case "openrouter":
      return callOpenRouter({ apiKey, model, system, user });
    case "openai":
      return callOpenAI({ apiKey, model, system, user });
    case "anthropic":
      return callAnthropic({ apiKey, model, system, user });
    default:
      throw new Error(`Provider sconosciuto: ${provider}`);
  }
}

/* ------------------------------------------------------------------ *
 * Helper generico per API compatibili OpenAI (OpenAI, Groq, OpenRouter, Ollama)
 * ------------------------------------------------------------------ */

async function callOpenAICompatible({
  url,
  apiKey,
  model,
  system,
  user,
  providerName,
  extraHeaders = {},
  requireKey = true,
  connectionHint = "",
}) {
  if (requireKey && !apiKey) {
    throw new Error(`Chiave API ${providerName} mancante. Inseriscila nelle impostazioni (⚙).`);
  }

  const headers = { "Content-Type": "application/json", ...extraHeaders };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  } catch (e) {
    throw new Error(
      `Impossibile contattare ${providerName}.` + (connectionHint ? " " + connectionHint : "")
    );
  }

  if (!res.ok) throw new Error(await readApiError(res, providerName));

  const data = await res.json();
  const out = data && data.choices && data.choices[0] && data.choices[0].message.content;
  if (!out) throw new Error(`Risposta vuota da ${providerName}.`);
  return out.trim();
}

/* ------------------------------------------------------------------ *
 * Provider implementati
 * ------------------------------------------------------------------ */

function callOpenAI({ apiKey, model, system, user }) {
  return callOpenAICompatible({
    url: "https://api.openai.com/v1/chat/completions",
    apiKey,
    model: model || "gpt-4o-mini",
    system,
    user,
    providerName: "OpenAI",
  });
}

function callGroq({ apiKey, model, system, user }) {
  return callOpenAICompatible({
    url: "https://api.groq.com/openai/v1/chat/completions",
    apiKey,
    model: model || "openai/gpt-oss-120b",
    system,
    user,
    providerName: "Groq",
  });
}

function callOpenRouter({ apiKey, model, system, user }) {
  return callOpenAICompatible({
    url: "https://openrouter.ai/api/v1/chat/completions",
    apiKey,
    model: model || "meta-llama/llama-3.3-70b-instruct:free",
    system,
    user,
    providerName: "OpenRouter",
    extraHeaders: {
      // Opzionali, servono a OpenRouter per identificare l'app.
      "HTTP-Referer": "https://localhost",
      "X-Title": "Riassumi Pagina AI",
    },
  });
}

function callOllama({ model, system, user }) {
  const chosen = model || "llama3.1";
  return callOpenAICompatible({
    url: "http://localhost:11434/v1/chat/completions",
    apiKey: "",
    model: chosen,
    system,
    user,
    providerName: "Ollama (locale)",
    requireKey: false,
    connectionHint:
      `Assicurati che Ollama sia avviato (\`ollama serve\`) e che il modello sia scaricato ` +
      `(\`ollama pull ${chosen}\`).`,
  });
}

/* ------------------------------------------------------------------ *
 * Google Gemini (endpoint diverso, non OpenAI-compatibile)
 * ------------------------------------------------------------------ */

async function callGemini({ apiKey, model, system, user }) {
  if (!apiKey) throw new Error("Chiave API Gemini mancante. Inseriscila nelle impostazioni (⚙).");

  const chosen = model || "gemini-2.5-flash";
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(chosen) +
    ":generateContent";

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // La chiave viaggia nell'header, non nella query string: non finisce nei log/URL.
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.3 },
      }),
    });
  } catch (e) {
    throw new Error("Impossibile contattare Google Gemini. Controlla la connessione a internet.");
  }

  if (!res.ok) throw new Error(await readApiError(res, "Gemini"));

  const data = await res.json();
  const candidate = data && data.candidates && data.candidates[0];
  const out =
    candidate &&
    candidate.content &&
    candidate.content.parts &&
    candidate.content.parts.map((p) => p.text || "").join("");
  if (!out) {
    const reason = data && data.promptFeedback && data.promptFeedback.blockReason;
    throw new Error(reason ? `Gemini ha bloccato la richiesta: ${reason}` : "Risposta vuota da Gemini.");
  }
  return out.trim();
}

/* ------------------------------------------------------------------ *
 * Google Gemini — OCR di immagini (Vision)
 * ------------------------------------------------------------------ */

/**
 * Invia una o più immagini (base64) a Gemini per il riconoscimento del testo.
 * Gemini ha un limite di ~20 MB per richiesta inline: le pagine vengono
 * raggruppate in batch per restare sotto la soglia.
 */
async function callGeminiVision({ apiKey, model, language }, images) {
  if (!apiKey) {
    throw new Error(
      "Serve una chiave Gemini gratuita per l'OCR di PDF scansionati/immagini. " +
        "Aggiungila in ⚙ (campo «Chiave Gemini per OCR»). Guida: https://aistudio.google.com/apikey"
    );
  }

  const chosen = model || "gemini-2.5-flash";
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(chosen) +
    ":generateContent";

  const prompt =
    `Estrai TUTTO il testo presente in queste pagine scansionate, parola per parola, ` +
    `nell'esatto ordine di lettura. Mantieni l'andamento dei paragrafi e degli elenchi. ` +
    `Non tradurre, non riassumere, non aggiungere commenti: restituisci SOLO il testo estratto. ` +
    `Lingua attesa: ${language || "italiano"}.`;

  const batches = chunkImages(images, 5, 12 * 1024 * 1024);
  const results = [];

  for (const batch of batches) {
    const parts = [{ text: prompt }];
    for (const data of batch) {
      parts.push({ inline_data: { mime_type: "image/jpeg", data } });
    }

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { temperature: 0 },
        }),
      });
    } catch (e) {
      throw new Error("Impossibile contattare Google Gemini per l'OCR. Controlla la connessione.");
    }

    if (!res.ok) throw new Error(await readApiError(res, "Gemini OCR"));

    const data = await res.json();
    const candidate = data && data.candidates && data.candidates[0];
    const out =
      candidate &&
      candidate.content &&
      candidate.content.parts &&
      candidate.content.parts.map((p) => p.text || "").join("");
    if (out && out.trim()) results.push(out.trim());
  }

  const text = results.join("\n\n").trim();
  if (!text) throw new Error("L'OCR non ha prodotto testo leggibile.");
  return text;
}

/** Raggruppa le immagini in batch rispettando un numero massimo e un peso massimo. */
function chunkImages(images, maxPerBatch, maxBytes) {
  const batches = [];
  let current = [];
  let currentBytes = 0;
  const approxBytes = (b64) => Math.floor((b64.length * 3) / 4);

  for (const img of images) {
    const size = approxBytes(img);
    if (current.length && (current.length >= maxPerBatch || currentBytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(img);
    currentBytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

/* ------------------------------------------------------------------ *
 * Anthropic (Claude)
 * ------------------------------------------------------------------ */

async function callAnthropic({ apiKey, model, system, user }) {
  if (!apiKey) throw new Error("Chiave API Anthropic mancante. Inseriscila nelle impostazioni (⚙).");

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // Necessario per le chiamate dirette dal browser (estensione).
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: model || "claude-3-5-haiku-latest",
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
  } catch (e) {
    throw new Error("Impossibile contattare Anthropic. Controlla la connessione a internet.");
  }

  if (!res.ok) throw new Error(await readApiError(res, "Anthropic"));

  const data = await res.json();
  const block = data && data.content && data.content[0];
  const out = block && block.text;
  if (!out) throw new Error("Risposta vuota da Anthropic.");
  return out.trim();
}

/* ------------------------------------------------------------------ *
 * Util
 * ------------------------------------------------------------------ */

async function readApiError(res, providerName) {
  let rawText = "";
  try {
    rawText = await res.text();
  } catch (_) {
    rawText = "";
  }

  let detail = "";
  if (rawText) {
    try {
      const body = JSON.parse(rawText);
      detail =
        (body && body.error && (body.error.message || body.error.code || body.error.type)) ||
        (body && body.message) ||
        "";
      const code = body && body.error && (body.error.code || body.error.type);
      if (detail && code && String(detail).indexOf(code) === -1) detail += ` [${code}]`;
    } catch (_) {
      // Corpo non-JSON: spesso una pagina HTML di blocco (Cloudflare) o un testo semplice.
      if (/cloudflare|cf-ray|attention required|blocked|just a moment/i.test(rawText)) {
        detail = "richiesta bloccata dal sistema di protezione della rete (Cloudflare).";
      } else {
        detail = rawText.replace(/\s+/g, " ").trim().slice(0, 300);
      }
    }
  }

  const message = `Errore ${providerName} (HTTP ${res.status}): ${detail || res.statusText}`;
  return message + hintForStatus(res.status, providerName, rawText);
}

/**
 * Suggerimenti operativi in base al codice HTTP, così l'utente capisce
 * cosa fare invece di ricevere un semplice "Forbidden".
 */
function hintForStatus(status, providerName, rawText) {
  if (status === 403) {
    if (/cloudflare|cf-ray|blocked|just a moment/i.test(rawText || "")) {
      return (
        "\n→ La richiesta è stata bloccata dal sistema di protezione (Cloudflare), " +
        "di solito per IP o regione. Prova da un'altra rete/hotspot o usa un altro provider " +
        "(es. Ollama in locale)."
      );
    }
    if (providerName === "Groq") {
      return (
        "\n→ 403 di Groq. Cause più comuni: (1) blocco IP/regione lato Cloudflare, " +
        "(2) account/organizzazione sospesa o non conforme, " +
        "(3) modello bloccato a livello di progetto. " +
        "Controlla https://console.groq.com/settings/limits , prova da un'altra rete, " +
        "oppure cambia provider (es. Ollama locale)."
      );
    }
    return "\n→ Autorizzazione negata: verifica che la chiave sia attiva e abilitata per questo servizio.";
  }
  if (status === 401) return "\n→ Chiave API non valida o revocata: creane una nuova nelle impostazioni (⚙).";
  if (status === 404) return "\n→ Modello inesistente o non più disponibile: scrivi un altro nome nel campo Modello.";
  if (status === 429) return "\n→ Troppe richieste (rate limit): aspetta qualche secondo o cambia provider.";
  if (status >= 500) return "\n→ Problema temporaneo del provider: riprova tra poco.";
  return "";
}