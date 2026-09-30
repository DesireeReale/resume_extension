/* =========================================================================
 * popup.js — UI, estrazione del testo e orchestrazione della richiesta.
 * ========================================================================= */

const $ = (id) => document.getElementById(id);

const DEFAULT_MODELS = {
  gemini: "gemini-2.5-flash",
  groq: "openai/gpt-oss-120b",
  openrouter: "meta-llama/llama-3.3-70b-instruct:free",
  local: "llama3.1",
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-latest",
};

const SETTINGS_KEY = "settings";

/* Stato della chat: contenuto di riferimento e conversazione corrente. */
let lastContent = "";
let chatHistory = [];
let chatBusy = false;

/* ------------------------------------------------------------------ *
 * Impostazioni
 * ------------------------------------------------------------------ */

async function loadSettings() {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  return {
    provider: stored.provider || "gemini",
    apiKey: stored.apiKey || "",
    // Chiave dedicata all'OCR (Gemini Vision): indipendente dal provider di riassunto.
    geminiOcrKey: stored.geminiOcrKey || "",
    language: stored.language || "italiano",
    models: { ...DEFAULT_MODELS, ...(stored.models || {}) },
  };
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

function fillSettingsForm(settings) {
  $("provider").value = settings.provider;
  $("apiKey").value = settings.apiKey;
  $("geminiOcrKey").value = settings.geminiOcrKey;
  $("language").value = settings.language;
  $("model").value = settings.models[settings.provider] || "";
  updateApiKeyVisibility(settings.provider);
}

function updateApiKeyVisibility(provider) {
  // Il provider locale (Ollama) non richiede chiave API.
  $("apiKeyField").classList.toggle("hidden", provider === "local");
}

/* ------------------------------------------------------------------ *
 * Estrazione del testo dalla pagina (funzione iniettata)
 * ------------------------------------------------------------------ */

/**
 * Questa funzione viene serializzata e iniettata nella pagina attiva.
 * Deve essere completamente autonoma: nessun riferimento esterno.
 * Per YouTube legge la trascrizione (sottotitoli); per il resto estrae il testo.
 */
function extractPageContent() {
  const host = location.hostname.replace(/^www\./, "");
  const isYouTube =
    host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com";

  // --- YouTube: legge la trascrizione dei sottotitoli del video corrente ---
  if (isYouTube && /\/(watch|shorts|embed)/.test(location.pathname)) {
    return extractYouTube();
  }

  return extractGeneric();

  /* ==================== helper interni ==================== */

  function extractGeneric() {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

    const candidates = [
      "article",
      "main",
      '[role="main"]',
      ".post-content",
      ".article-content",
      ".entry-content",
      "#content",
    ];

    let node = null;
    for (const selector of candidates) {
      const el = document.querySelector(selector);
      if (el && el.innerText && el.innerText.trim().length > 200) {
        node = el;
        break;
      }
    }

    let raw = clean(node ? node.innerText : "");

    // Fallback 1: paragrafi sparsi (SPA o layout senza contenitore semantico).
    if (raw.length < 200) {
      const fromParagraphs = clean(
        Array.from(document.querySelectorAll("p"))
          .map((p) => p.innerText)
          .join(" ")
      );
      if (fromParagraphs.length > raw.length) raw = fromParagraphs;
    }

    // Fallback 2: tutto il testo visibile del body.
    if (raw.length < 200) {
      const body = document.body;
      const fromBody = clean(body ? body.innerText || body.textContent : "");
      if (fromBody.length > raw.length) raw = fromBody;
    }

    return {
      title: document.title || "",
      url: location.href,
      text: raw.slice(0, 18000), // limite prudente per i token
      length: raw.length,
    };
  }

  /**
   * Recupera le tracce dei sottotitoli del video CORRENTE.
   * Su YouTube (SPA) la fonte affidabile è il player #movie_player:
   * ytInitialPlayerResponse può essere assente o riferito al primo video caricato.
   */
  function getCaptionTracks() {
    // 1) Player API (riflette sempre il video attualmente aperto).
    const player =
      document.getElementById("movie_player") ||
      document.querySelector(".html5-video-player");
    if (player) {
      try {
        if (typeof player.getPlayerResponse === "function") {
          const pr = player.getPlayerResponse();
          const tracks =
            pr &&
            pr.captions &&
            pr.captions.playerCaptionsTracklistRenderer &&
            pr.captions.playerCaptionsTracklistRenderer.captionTracks;
          if (tracks && tracks.length) return tracks;
        }
      } catch (e) {
        /* prova la fonte successiva */
      }
      try {
        const list = player.getOption && player.getOption("captions", "tracklist");
        if (list && list.length) return list;
      } catch (e) {
        /* prova la fonte successiva */
      }
    }

    // 2) Variabile globale della pagina.
    const pr = getInitialPlayerResponse();
    const tracks =
      pr &&
      pr.captions &&
      pr.captions.playerCaptionsTracklistRenderer &&
      pr.captions.playerCaptionsTracklistRenderer.captionTracks;
    if (tracks && tracks.length) return tracks;

    return null;
  }

  /** ytInitialPlayerResponse globale o embedded nell'HTML. */
  function getInitialPlayerResponse() {
    if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
    try {
      const html = document.documentElement.innerHTML;
      const marker = "ytInitialPlayerResponse";
      const idx = html.indexOf(marker);
      if (idx === -1) return null;
      const start = html.indexOf("{", idx);
      if (start === -1) return null;

      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < html.length; i++) {
        const ch = html[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') {
          inStr = true;
        } else if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0) return JSON.parse(html.slice(start, i + 1));
        }
      }
    } catch (e) {
      /* ignora */
    }
    return null;
  }

  /**
   * Estrae un oggetto JSON dall'HTML a partire da un marcatore, usando un
   * matcher a parentesi che ignora le graffe dentro le stringhe.
   */
  function extractJsonObject(html, marker) {
    try {
      const idx = html.indexOf(marker);
      if (idx === -1) return null;
      const start = html.indexOf("{", idx);
      if (start === -1) return null;

      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < html.length; i++) {
        const ch = html[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') {
          inStr = true;
        } else if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0) return JSON.parse(html.slice(start, i + 1));
        }
      }
    } catch (e) {
      /* ignora */
    }
    return null;
  }

  /** Estrae il testo dalle tracce sottotitoli via baseUrl (json3 oppure XML). */
  async function fetchTranscriptFromBase(base, diag) {
    if (!base) {
      if (diag) diag.push("baseUrl: assente");
      return null;
    }

    try {
      const json3Url = base + (base.indexOf("?") === -1 ? "?" : "&") + "fmt=json3";
      const res = await fetch(json3Url, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        const text = (data.events || [])
          .map((e) => (e.segs || []).map((s) => s.utf8 || "").join(""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (diag) diag.push("baseUrl json3: HTTP " + res.status + ", " + text.length + " caratteri");
        if (text.length > 50) return text;
      } else if (diag) {
        diag.push("baseUrl json3: HTTP " + res.status);
      }
    } catch (e) {
      if (diag) diag.push("baseUrl json3: errore (" + (e && e.message ? e.message : e) + ")");
    }

    try {
      const res = await fetch(base, { credentials: "include" });
      if (res.ok) {
        const xml = await res.text();
        // Niente DOMParser: su YouTube è bloccato da Trusted Types.
        const text = (xml.match(/<text[^>]*>([\s\S]*?)<\/text>/g) || [])
          .map((t) => t.replace(/<[^>]+>/g, ""))
          .join(" ")
          .replace(/&amp;/g, "&")
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/\s+/g, " ")
          .trim();
        if (diag) diag.push("baseUrl xml: HTTP " + res.status + ", " + text.length + " caratteri");
        if (text.length > 50) return text;
      } else if (diag) {
        diag.push("baseUrl xml: HTTP " + res.status);
      }
    } catch (e) {
      if (diag) diag.push("baseUrl xml: errore (" + (e && e.message ? e.message : e) + ")");
    }

    return null;
  }

  /** Trova il parametro `params` dell'endpoint getTranscript in ytInitialData. */
  function findTranscriptParams(ytInitialData) {
    if (!ytInitialData || typeof ytInitialData !== "object") return null;

    const panels = ytInitialData.engagementPanels;
    if (Array.isArray(panels)) {
      for (const p of panels) {
        const r = p && p.engagementPanelSectionListRenderer;
        const cont = r && r.content && r.content.continuationItemRenderer;
        const gep =
          cont && cont.continuationEndpoint && cont.continuationEndpoint.getTranscriptEndpoint;
        if (gep && gep.params) return gep.params;
      }
    }

    let found = null;
    (function walk(node) {
      if (found || !node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node.getTranscriptEndpoint && node.getTranscriptEndpoint.params) {
        found = node.getTranscriptEndpoint.params;
        return;
      }
      for (const k in node) walk(node[k]);
    })(ytInitialData);

    return found;
  }

  /** Raccoglie tutto il testo dai segmenti della risposta get_transcript. */
  function collectTranscript(data) {
    const parts = [];
    const seen = new Set();

    (function walk(node) {
      if (!node || typeof node !== "object") return;
      if (seen.has(node)) return;
      seen.add(node);

      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }

      const seg = node.transcriptSegmentRenderer;
      if (seg && seg.snippet) {
        if (seg.snippet.simpleText) parts.push(seg.snippet.simpleText);
        else if (seg.snippet.runs)
          parts.push(seg.snippet.runs.map((r) => r.text || "").join(""));
      }

      const cue = node.transcriptCueRenderer;
      if (cue && cue.cue) {
        if (cue.cue.simpleText) parts.push(cue.cue.simpleText);
        else if (cue.cue.runs) parts.push(cue.cue.runs.map((r) => r.text || "").join(""));
      }

      for (const k in node) walk(node[k]);
    })(data);

    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  /**
   * Metodo alternativo: scarica la pagina FRESCA del video (evita la staleness
   * della SPA), estrae la chiave InnerTube e ytInitialData, poi chiama
   * youtubei/v1/get_transcript.
   */
  async function fetchTranscriptViaInnertube(diag) {
    try {
      const res = await fetch(location.href, { credentials: "include" });
      if (!res.ok) {
        if (diag) diag.push("pagina fresca: HTTP " + res.status);
        return null;
      }
      const html = await res.text();

      const apiKey = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
      const clientVersion = (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1];
      const visitorData = (html.match(/"VISITOR_DATA":"([^"]+)"/) || [])[1];
      const pageContext = extractJsonObject(html, '"INNERTUBE_CONTEXT"');
      const ytInitialData = extractJsonObject(html, "ytInitialData");
      if (diag) diag.push("apiKey InnerTube: " + (apiKey ? "trovata" : "MANCANTE"));
      if (diag) diag.push("visitorData: " + (visitorData ? "trovato" : "assente"));
      if (!apiKey) return null;

      const params = findTranscriptParams(ytInitialData);
      if (diag) {
        diag.push(
          "params getTranscript: " +
            (params ? "trovati (" + String(params).slice(0, 16) + "…)" : "MANCANTI")
        );
      }
      if (!params) return null;

      const hl = (navigator.language || "it").slice(0, 2);
      const contexts = [];
      if (pageContext && pageContext.client) {
        if (visitorData && !pageContext.client.visitorData) pageContext.client.visitorData = visitorData;
        contexts.push(pageContext);
      }
      contexts.push({
        client: {
          clientName: "WEB",
          clientVersion: clientVersion || "2.20240101.00.00",
          hl: hl,
          ...(visitorData ? { visitorData } : {}),
        },
      });

      const baseHeaders = {
        "Content-Type": "application/json",
        "X-Youtube-Client-Name": "1",
      };
      if (clientVersion) baseHeaders["X-Youtube-Client-Version"] = clientVersion;
      if (visitorData) baseHeaders["X-Goog-Visitor-Id"] = visitorData;

      for (const context of contexts) {
        const name = (context.client && context.client.clientName) || "?";
        let apiRes;
        try {
          apiRes = await fetch(
            "https://www.youtube.com/youtubei/v1/get_transcript?key=" +
              encodeURIComponent(apiKey) +
              "&prettyPrint=false",
            {
              method: "POST",
              headers: baseHeaders,
              credentials: "include",
              body: JSON.stringify({ context, params }),
            }
          );
        } catch (e) {
          if (diag) diag.push("get_transcript [" + name + "]: errore (" + (e && e.message ? e.message : e) + ")");
          continue;
        }

        if (!apiRes.ok) {
          let body = "";
          try {
            body = (await apiRes.text()).slice(0, 200).replace(/\s+/g, " ");
          } catch (_) {
            body = "";
          }
          if (diag) {
            diag.push("get_transcript [" + name + "]: HTTP " + apiRes.status + (body ? " → " + body : ""));
          }
          continue;
        }

        const data = await apiRes.json();
        const text = collectTranscript(data);
        if (diag) {
          diag.push("get_transcript [" + name + "]: HTTP " + apiRes.status + ", " + text.length + " caratteri");
        }
        if (text.length > 50) return text;
      }

      return null;
    } catch (e) {
      if (diag) diag.push("get_transcript: errore (" + (e && e.message ? e.message : e) + ")");
      return null;
    }
  }

  /** Utility: attesa. */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Ultima risorsa: YouTube stesso renderizza il pannello "Trascrizione".
   * Espande la descrizione, clicca il pulsante e raccoglie i segmenti.
   */
  async function scrapeTranscriptPanel(diag) {
    try {
      // 1) Espandi la descrizione (pulsante "…altro"), se presente e visibile.
      const expand = document.querySelector("tp-yt-paper-button#expand");
      if (expand && expand.offsetParent !== null) {
        expand.click();
        await sleep(500);
      }

      // 2) Trova il pulsante "Mostra trascrizione".
      let btn = document.querySelector(
        "ytd-video-description-transcript-section-renderer button"
      );
      if (!btn) {
        const all = Array.from(document.querySelectorAll("button, ytd-button-renderer"));
        btn = all.find((b) =>
          /trascrizione|transcript/i.test(
            (b.textContent || "") + " " + (b.getAttribute("aria-label") || "")
          )
        );
      }
      if (!btn) {
        if (diag) diag.push("pannello Trascrizione: pulsante non trovato");
        return null;
      }

      btn.click();

      // 3) Attendi che i segmenti vengano renderizzati.
      let segments = [];
      for (let i = 0; i < 24; i++) {
        await sleep(250);
        segments = document.querySelectorAll("ytd-transcript-segment-renderer");
        if (segments.length > 0) break;
      }
      if (!segments.length) {
        if (diag) diag.push("pannello Trascrizione: nessun segmento renderizzato");
        return null;
      }

      const text = Array.from(segments)
        .map((s) => {
          const el = s.querySelector(".segment-text") || s.querySelector("#segment-text") || s;
          return (el.innerText || el.textContent || "").trim();
        })
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (diag) {
        diag.push(
          "pannello Trascrizione: " + segments.length + " segmenti, " + text.length + " caratteri"
        );
      }
      return text.length > 50 ? text : null;
    } catch (e) {
      if (diag) diag.push("pannello Trascrizione: errore (" + (e && e.message ? e.message : e) + ")");
      return null;
    }
  }

  /** Sceglie la traccia sottotitoli in base alla lingua del browser/utente. */
  function pickTrack(tracks) {
    const prefs = [
      navigator.language && navigator.language.slice(0, 2),
      "it",
      "en",
    ];
    for (const p of prefs) {
      if (!p) continue;
      const t = tracks.find((x) =>
        (x.languageCode || "").toLowerCase().startsWith(p.toLowerCase())
      );
      if (t) return t;
    }
    return tracks[0];
  }

  function buildYouTubeResult(transcript) {
    const title = document.title || "";
    return {
      title,
      url: location.href,
      text: ("Video: " + title + "\n\nTrascrizione:\n" + transcript).slice(0, 18000),
      length: transcript.length,
      source: "youtube-transcript",
    };
  }

  async function extractYouTube() {
    const empty = { title: document.title || "", url: location.href, text: "" };
    const diag = [];
    try {
      // 1) Tracce dal player live → scarico via baseUrl (json3/XML)
      const tracks = getCaptionTracks();
      diag.push("tracce sottotitoli trovate: " + (tracks ? tracks.length : 0));
      if (tracks && tracks.length) {
        const track = pickTrack(tracks);
        diag.push("lingua scelta: " + ((track && (track.languageCode || track.name)) || "?"));
        const base = track && (track.baseUrl || track.url);
        const viaBase = await fetchTranscriptFromBase(base, diag);
        if (viaBase) return buildYouTubeResult(viaBase);
      }

      // 2) Metodo alternativo: endpoint interno get_transcript
      const viaInner = await fetchTranscriptViaInnertube(diag);
      if (viaInner) return buildYouTubeResult(viaInner);

      // 3) Ultima risorsa: leggi il pannello "Trascrizione" renderizzato da YouTube
      const viaPanel = await scrapeTranscriptPanel(diag);
      if (viaPanel) return buildYouTubeResult(viaPanel);

      // 4) Nessuna traccia disponibile
      if (!tracks || !tracks.length) {
        return Object.assign(empty, { noCaptions: true, debug: diag });
      }

      // Tracce presenti ma non scaricabili con alcun metodo.
      return Object.assign(empty, { captionsUnreachable: true, debug: diag });
    } catch (e) {
      diag.push("errore imprevisto: " + (e && e.message ? e.message : e));
      return Object.assign(empty, { captionsUnreachable: true, debug: diag });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Lettura PDF (scheda attiva) + OCR
 *
 * Chrome non permette ai content script di leggere il suo visualizzatore
 * PDF interno. Quindi scarichiamo il file dall'origine della scheda
 * (permesso concesso da host_permissions) e lo analizziamo con pdf.js.
 * ------------------------------------------------------------------ */

const PDF_TEXT_MIN = 200; // sotto questa soglia consideriamo il PDF "scansionato"
const PDF_MAX_TEXT_PAGES = 60;
const PDF_MAX_OCR_PAGES = 20;

let pdfWorkerReady = false;
function ensurePdfWorker() {
  if (pdfWorkerReady || !window.pdfjsLib) return;
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.js");
  pdfWorkerReady = true;
}

/** Riconosce se una scheda mostra un PDF (URL .pdf o viewer di Chrome). */
function looksLikePdfUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    if (/\.pdf$/i.test(u.pathname)) return true;
    return /[?&](format|type|file)=.*pdf/i.test(u.search);
  } catch (_) {
    return false;
  }
}

/** Scarica i byte del PDF e verifica l'intestazione "%PDF". */
async function fetchPdfBytes(url) {
  let res;
  try {
    res = await fetch(url, { credentials: "include" });
  } catch (networkErr) {
    // Spesso significa che manca l'host permission per l'origine del PDF.
    // Con activeTab di solito basta; se no, chiediamo l'accesso e riproviamo una volta.
    if (await requestOriginAccess(url)) {
      try {
        res = await fetch(url, { credentials: "include" });
      } catch (_) {
        throw new Error("Non riesco a scaricare il PDF da questa scheda. Se è un file locale, aprine una copia online.");
      }
    } else {
      throw new Error(
        "Serve l'accesso al sito per leggere questo PDF. Concedi il permesso quando richiesto e riprova."
      );
    }
  }
  if (!res.ok) throw new Error(`Impossibile scaricare il PDF (HTTP ${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const header = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (header !== "%PDF") {
    throw new Error("Il documento non è un PDF leggibile. Apri un PDF e riprova.");
  }
  return bytes;
}

/** Chiede il permesso host per l'origine dell'URL (deve avvenire su gesto utente). */
async function requestOriginAccess(url) {
  try {
    const origin = new URL(url).origin + "/*";
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (_) {
    return false;
  }
}

async function openPdf(bytes) {
  ensurePdfWorker();
  if (!window.pdfjsLib) throw new Error("Libreria PDF non caricata. Ricarica l'estensione (↻).");
  // isEvalSupported: false è necessario per rispettare la CSP di Chrome (niente eval).
  return window.pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
}

/** Estrae lo strato di testo (PDF digitali). Restituisce anche info sul documento. */
async function extractPdfText(pdf) {
  const pages = Math.min(pdf.numPages, PDF_MAX_TEXT_PAGES);
  const parts = [];
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const line = content.items.map((it) => it.str || "").join(" ");
    parts.push(line);
  }
  const text = parts
    .join("\n\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, pagesRead: pages, numPages: pdf.numPages };
}

/** Renderizza le prime pagine in JPEG base64 (per l'OCR di PDF scansionati). */
async function renderPdfToImages(pdf) {
  const pages = Math.min(pdf.numPages, PDF_MAX_OCR_PAGES);
  const images = [];
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 1400 / base.width);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    images.push(dataUrl.slice(dataUrl.indexOf(",") + 1));
  }
  return { images, pagesRead: pages, numPages: pdf.numPages };
}

/** Chiede al service worker di eseguire l'OCR via Gemini Vision. */
async function ocrImages(images, geminiKey, settings) {
  const response = await chrome.runtime.sendMessage({
    type: "OCR",
    payload: {
      images,
      apiKey: geminiKey,
      model: DEFAULT_MODELS.gemini,
      language: settings.language,
    },
  });
  if (!response || response.error) {
    throw new Error(response && response.error ? response.error : "OCR non riuscito.");
  }
  return response.text;
}

/* ------------------------------------------------------------------ *
 * UI helpers
 * ------------------------------------------------------------------ */

function showStatus(text) {
  $("statusText").textContent = text;
  $("status").classList.remove("hidden");
}

function hideStatus() {
  $("status").classList.add("hidden");
}

function showError(message) {
  $("error").textContent = message;
  $("error").classList.remove("hidden");
}

function hideError() {
  $("error").classList.add("hidden");
}

/* ------------------------------------------------------------------ *
 * Markdown sicuro (solo per il riassunto AI)
 * ------------------------------------------------------------------ */

/**
 * Escape dei caratteri HTML. Va eseguito SEMPRE per primo: l'output
 * dell'AI non deve mai poter iniettare HTML reale.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Applica la formattazione inline su una stringa GIÀ escapata.
 * Ordine: bold → italic → code inline → link (solo http/https).
 */
function formatInline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
}

/**
 * Converte il testo Markdown dell'AI in HTML sicuro.
 * Strategia: prima si esegue l'escape di TUTTO il testo, poi si applicano
 * le trasformazioni. Così nessun tag/attributo proveniente dall'AI può
 * sopravvivere. Supporta: # ## ###, **bold**, *italic*, `code`,
 * [link](https://…), liste - * e numerate 1., paragrafi separati da riga vuota.
 */
function renderMarkdown(raw) {
  if (raw == null) return "";
  const escaped = escapeHtml(raw);

  const lines = escaped.split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let listType = null; // "ul" | "ol"
  let listItems = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push("<p>" + paragraph.map(formatInline).join("<br>") + "</p>");
      paragraph = [];
    }
  };

  const flushList = () => {
    if (listItems.length) {
      html.push(
        "<" + listType + ">" +
          listItems.map((item) => "<li>" + formatInline(item) + "</li>").join("") +
        "</" + listType + ">"
      );
    }
    listItems = [];
    listType = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Riga vuota: chiude paragrafo e lista.
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    let match;

    // Titoli (#, ##, ###).
    if ((match = trimmed.match(/^###\s+(.*)$/))) {
      flushParagraph();
      flushList();
      html.push("<h3>" + formatInline(match[1]) + "</h3>");
      continue;
    }
    if ((match = trimmed.match(/^##\s+(.*)$/))) {
      flushParagraph();
      flushList();
      html.push("<h2>" + formatInline(match[1]) + "</h2>");
      continue;
    }
    if ((match = trimmed.match(/^#\s+(.*)$/))) {
      flushParagraph();
      flushList();
      html.push("<h3>" + formatInline(match[1]) + "</h3>");
      continue;
    }

    // Liste puntate (- oppure *).
    if ((match = trimmed.match(/^[-*]\s+(.*)$/))) {
      flushParagraph();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(match[1]);
      continue;
    }

    // Liste numerate (1. 2. …).
    if ((match = trimmed.match(/^\d+\.\s+(.*)$/))) {
      flushParagraph();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(match[1]);
      continue;
    }

    // Testo normale: va nel paragrafo corrente.
    flushList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();

  return html.join("");
}

function showResult(text) {
  $("resultText").innerHTML = renderMarkdown(text);
  $("result").classList.remove("hidden");
}

function hideResult() {
  $("result").classList.add("hidden");
  hideResultNote();
}

/** Aggiunge un messaggio alla chat e restituisce l'elemento creato. */
function appendChatMessage(role, text, pending) {
  const el = document.createElement("div");
  el.className = "chat-msg " + role + (pending ? " pending" : "");
  if (role === "assistant" && !pending) {
    // renderMarkdown esegue l'escape dell'HTML per primo: è sicuro.
    el.innerHTML = renderMarkdown(text);
  } else {
    el.textContent = text;
  }
  const box = $("chatMessages");
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el;
}

/** Rende visibile la chat e conserva il contenuto appena estratto. */
function enableChat(content) {
  lastContent = content || "";
  chatHistory = [];
  $("chatMessages").innerHTML = "";
  $("chat").classList.remove("hidden");
}

/* ------------------------------------------------------------------ *
 * Azione principale: riassumi
 * ------------------------------------------------------------------ */

async function summarize() {
  hideError();
  hideResult();

  const settings = await loadSettings();
  const button = $("summarizeBtn");
  button.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) {
      throw new Error("Impossibile accedere alla scheda attiva.");
    }

    if (looksLikePdfUrl(tab.url)) {
      await summarizePdf(tab.url, settings);
    } else {
      await summarizeWebPage(tab, settings);
    }
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  } finally {
    hideStatus();
    button.disabled = false;
  }
}

/** Controlla che ci sia una chiave valida per il provider scelto (non serve per Ollama). */
function assertProviderKey(settings) {
  if (settings.provider !== "local" && !settings.apiKey.trim()) {
    throw new Error("Inserisci la chiave API nelle impostazioni (⚙) prima di continuare.");
  }
}

/** Riassunto di una normale pagina web (testo estratto dalla pagina). */
async function summarizeWebPage(tab, settings) {
  try {
    assertProviderKey(settings);
  } catch (err) {
    showError(err.message);
    $("toggleSettings").click();
    return;
  }

  showStatus("Analisi della pagina…");

  let injection;
  try {
    injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageContent,
      // MAIN world: necessario per leggere ytInitialPlayerResponse su YouTube.
      world: "MAIN",
    });
  } catch (e) {
    throw new Error(
      "Non posso leggere questa pagina (le pagine chrome://, il Web Store e le pagine interne di Chrome sono bloccate). Apri una pagina web normale e riprova."
    );
  }

  const page = injection && injection[0] && injection[0].result;
  if (page && (page.noCaptions || page.captionsUnreachable)) {
    const motivo = page.noCaptions
      ? "Questo video non ha sottotitoli disponibili."
      : "I sottotitoli esistono ma non è stato possibile scaricarli.";
    const dettagli =
      page.debug && page.debug.length ? "\n\nDiagnostica:\n• " + page.debug.join("\n• ") : "";
    throw new Error(motivo + dettagli);
  }
  if (!page || !page.text || page.text.length < 50) {
    const info = page
      ? `\n\nDiagnostica: titolo «${page.title || "(nessuno)"}», testo trovato ${page.length || 0} caratteri.\nURL: ${page.url || "-"}`
      : "";
    throw new Error("Non ho trovato abbastanza testo da riassumere in questa pagina." + info);
  }

  await requestSummary(page.text, settings);
  enableChat(page.text);
}

/** Riassunto di un PDF aperto nella scheda attiva (con OCR se scansionato). */
async function summarizePdf(url, settings) {
  assertProviderKey(settings);
  showStatus("Download del PDF…");
  const bytes = await fetchPdfBytes(url);
  const pdf = await openPdf(bytes);

  showStatus("Estrazione del testo dal PDF…");
  const extracted = await extractPdfText(pdf);
  let content = extracted.text;
  let usedOcr = false;

  if (content.length < PDF_TEXT_MIN) {
    // Nessuno strato di testo → PDF scansionato: serve l'OCR.
    showStatus("PDF scansionato: preparazione OCR…");
    const geminiKey =
      settings.geminiOcrKey.trim() ||
      (settings.provider === "gemini" ? settings.apiKey.trim() : "");
    if (!geminiKey) {
      throw new Error(
        "Questo PDF sembra scansionato (immagini) e serve l'OCR. Aggiungi una chiave Gemini gratuita " +
          "in ⚙ (campo «Chiave Gemini per OCR»). Guida: https://aistudio.google.com/apikey"
      );
    }
    const rendered = await renderPdfToImages(pdf);
    showStatus(`OCR in corso su ${rendered.pagesRead} pagine…`);
    content = await ocrImages(rendered.images, geminiKey, settings);
    usedOcr = true;
  }

  if (!content || content.length < 50) {
    throw new Error("Non ho trovato abbastanza testo in questo PDF.");
  }

  await requestSummary(content.slice(0, 18000), settings);

  enableChat(content);
  showResultNote(
    usedOcr
      ? `PDF scansionato: testo riconosciuto via OCR (${extracted.numPages} pagine).`
      : `PDF digitale: ${extracted.numPages} pagine lette.`
  );
}

/** Invia il testo al service worker e mostra il riassunto. */
async function requestSummary(text, settings) {
  assertProviderKey(settings);
  showStatus("Invio a " + providerLabel(settings.provider) + "…");

  const response = await chrome.runtime.sendMessage({
    type: "SUMMARIZE",
    payload: {
      text,
      language: settings.language,
      provider: settings.provider,
      apiKey: settings.apiKey,
      model: settings.models[settings.provider],
    },
  });

  if (!response) {
    throw new Error("Nessuna risposta dal background. Ricarica l'estensione e riprova.");
  }
  if (response.error) {
    throw new Error(response.error);
  }

  showResult(response.summary);
}

/** Riga informativa (es. fonte del PDF) mostrata sopra il riassunto. */
function showResultNote(text) {
  const el = $("resultNote");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("hidden");
}

function hideResultNote() {
  const el = $("resultNote");
  if (el) el.classList.add("hidden");
}

function providerLabel(provider) {
  return (
    {
      gemini: "Gemini",
      groq: "Groq",
      openrouter: "OpenRouter",
      local: "Ollama",
      openai: "OpenAI",
      anthropic: "Anthropic",
    }[provider] || provider
  );
}

/** Adatta l'etichetta del pulsante e mostra se la scheda è un PDF. */
async function updateModeForActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isPdf = !!(tab && looksLikePdfUrl(tab.url));
    const label = $("summarizeBtn").querySelector(".btn-label");
    if (label) label.textContent = isPdf ? "Riassumi PDF" : "Riassumi";
    $("pdfBadge").classList.toggle("hidden", !isPdf);
  } catch (_) {
    /* nessuna scheda accessibile: lascia l'etichetta predefinita */
  }
}

/* ------------------------------------------------------------------ *
 * Event listeners
 * ------------------------------------------------------------------ */

document.addEventListener("DOMContentLoaded", async () => {
  const settings = await loadSettings();
  fillSettingsForm(settings);
  updateModeForActiveTab();

  $("toggleSettings").addEventListener("click", () => {
    $("settings").classList.toggle("hidden");
  });

  $("provider").addEventListener("change", (e) => {
    const provider = e.target.value;
    updateApiKeyVisibility(provider);
    $("model").value = settings.models[provider] || DEFAULT_MODELS[provider] || "";
  });

  $("saveSettings").addEventListener("click", async () => {
    const provider = $("provider").value;
    const updated = {
      provider,
      apiKey: $("apiKey").value.trim(),
      geminiOcrKey: $("geminiOcrKey").value.trim(),
      language: $("language").value,
      models: { ...settings.models, [provider]: $("model").value.trim() || DEFAULT_MODELS[provider] },
    };
    settings.provider = updated.provider;
    settings.apiKey = updated.apiKey;
    settings.geminiOcrKey = updated.geminiOcrKey;
    settings.language = updated.language;
    settings.models = updated.models;

    await saveSettings(updated);
    hideError();
    hideResultNote();
    showResult("✓ Impostazioni salvate.");
    $("settings").classList.add("hidden");
  });

  $("summarizeBtn").addEventListener("click", summarize);

  $("copyBtn").addEventListener("click", async () => {
    const text = $("resultText").innerText;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    $("copyBtn").textContent = "✓";
    setTimeout(() => ($("copyBtn").textContent = "⧉"), 1200);
  });

  $("chatForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("chatInput");
    const question = input.value.trim();
    if (!question || chatBusy) return;

    input.value = "";
    appendChatMessage("user", question);
    chatBusy = true;
    $("chatSend").disabled = true;
    const thinking = appendChatMessage("assistant", "Sto pensando…", true);

    try {
      const settings = await loadSettings();
      const response = await chrome.runtime.sendMessage({
        type: "CHAT",
        payload: {
          question,
          context: lastContent,
          language: settings.language,
          history: chatHistory,
          provider: settings.provider,
          apiKey: settings.apiKey,
          model: settings.models[settings.provider],
        },
      });

      if (!response || response.error) {
        throw new Error(
          response && response.error ? response.error : "Nessuna risposta dal background."
        );
      }

      thinking.remove();
      appendChatMessage("assistant", response.reply);
      chatHistory.push({ role: "user", content: question });
      chatHistory.push({ role: "assistant", content: response.reply });
    } catch (err) {
      thinking.remove();
      appendChatMessage("error", err && err.message ? err.message : String(err));
    } finally {
      chatBusy = false;
      $("chatSend").disabled = false;
      input.focus();
    }
  });
});