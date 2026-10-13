const DEFAULT_MODEL = "gemini-3.8-flash-lite";
const MAX_HISTORY_MESSAGES = 4;
const MAX_HISTORY_MESSAGE_CHARS = 120;
const MAX_ALICE_TEXT = 1000;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко (1-3 предложения).",
  "Не используй Markdown (звёздочки, решётки), списки или таблицы.",
  "Если предоставлен контекст из поиска, опирайся на него."
].join(" ");

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 200) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 150 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function aliceResponse(text, endSession = false, history = []) {
  let sessionHistory = Array.isArray(history) ? history : [];
  
  // Яндекс Диалоги ограничивают session_state до 1000 байт
  if (JSON.stringify({ history: sessionHistory }).length > 850) {
    sessionHistory = sessionHistory.slice(-2);
  }

  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: {
      history: sessionHistory
    }
  };
}

function isSearchIntent(text) {
  return /\b(погода|новости|курс|цена|сколько стоит|когда|где|кто|что сейчас|последние|свежие|актуальные)\b/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string" && item.text.trim())
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.trim().slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function fetchJson(url, options, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      800
    );

    if (!response.ok) return "";

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 150);
        const snippet = String(item.snippet || "").slice(0, 250);
        return `${i + 1}. ${title}: ${snippet}`.trim();
      });

    return items.length ? items.join("\n") : "";
  } catch (_) {
    return "";
  }
}

async function askGemini(text, history, searchContext) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();

  // Gemini строго требует чередование user -> model и старт с user
  const contents = [];
  let lastRole = null;
  for (const item of safeHistory(history)) {
    if (item.role !== lastRole) {
      contents.push({ role: item.role, parts: [{ text: item.text }] });
      lastRole = item.role;
    }
  }

  if (contents.length > 0 && contents[0].role === "model") {
    contents.shift();
  }

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}`
    : text;

  // Если последнее сообщение в истории уже было user, склеиваем, иначе пушим
  if (contents.length > 0 && contents[contents.length - 1].role === "user") {
    contents[contents.length - 1].parts[0].text += `\n${prompt}`;
  } else {
    contents.push({ role: "user", parts: [{ text: prompt }] });
  }

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature: 0.6,
          maxOutputTokens: 200
        }
      })
    },
    3800
  );

  if (!response.ok) {
    const status = Number(response.status);
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    const errMsg = data?.error?.message || `HTTP_${status}`;
    throw new Error(`GEMINI_ERROR_${errMsg}`);
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) throw new Error("GEMINI_EMPTY_RESPONSE");
  return answer;
}

function errorForUser(error) {
  const msg = error?.message || "";
  if (msg === "MISSING_GEMINI_KEY") return "Сервер не настроен. Проверьте переменную GEMINI_API_KEY в Vercel.";
  if (msg === "GEMINI_KEY_REJECTED") return "Не удалось подключиться к Gemini. Проверьте API-ключ в Vercel.";
  if (msg === "GEMINI_QUOTA") return "Превышен лимит запросов к Gemini. Попробуйте немного позже.";
  if (msg.includes("AbortError") || msg.includes("aborted")) return "Не успела подготовить ответ. Спросите ещё раз короче.";
  return `Ошибка: ${msg || "неизвестно"}`;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (_) {
      body = {};
    }
  }
  body = body && typeof body === "object" ? body : {};

  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я готов помочь. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  try {
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      searchContext = await searchWeb(text);
    }

    const answer = await askGemini(text, oldHistory, searchContext);

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    console.error("Handler caught error:", error?.message || error);
    return res.status(200).json(aliceResponse(errorForUser(error), false, oldHistory));
  }
}
