const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 120;
const MAX_SESSION_STATE_BYTES = 850;
const MAX_ALICE_TEXT = 1000;
const GEMINI_TIMEOUT_MS = 3000;
const SERPER_TIMEOUT_MS = 600;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко — обычно в 1–3 предложениях.",
  "Не используй Markdown, списки, таблицы, звёздочки или заголовки.",
  "История предыдущих сообщений в contents является частью текущего диалога.",
  "Обязательно учитывай её при ответах на уточняющие вопросы, местоимения и ссылки на сказанное ранее.",
  "Если пользователь сообщил факт о себе, например город проживания, используй этот факт в последующих ответах в рамках текущего диалога.",
  "Не утверждай, что не знаешь ранее сообщённый факт, если он присутствует в истории.",
  "Если предоставлен контекст из поиска, используй его, но не выдавай неподтверждённые сведения за факты."
].join(" ");

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) {
    return text || "Не удалось подготовить ответ.";
  }

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );

  if (sentenceEnd >= 200) {
    return candidate.slice(0, sentenceEnd + 1).trim();
  }

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 150 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function cleanHistoryText(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, MAX_HISTORY_MESSAGE_CHARS);
}

/**
 * Упорядочивает историю для Gemini. Повторяющиеся роли объединяются,
 * а не отбрасываются. В истории остаются только завершённые пары user/model.
 */
function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];

  const normalized = [];

  for (const item of history) {
    if (!item || (item.role !== "user" && item.role !== "model")) continue;

    const text = cleanHistoryText(item.text);
    if (!text) continue;

    const last = normalized[normalized.length - 1];
    if (last && last.role === item.role) {
      last.text = `${last.text} / ${text}`.slice(0, MAX_HISTORY_MESSAGE_CHARS);
    } else {
      normalized.push({ role: item.role, text });
    }
  }

  // Gemini conversations should begin with a user message.
  if (normalized.length && normalized[0].role !== "user") normalized.shift();

  // Drop an incomplete final user message. Successful turns are always user + model.
  if (normalized.length && normalized[normalized.length - 1].role === "user") {
    normalized.pop();
  }

  let result = normalized.slice(-MAX_HISTORY_MESSAGES);
  if (result.length && result[0].role !== "user") result = result.slice(1);
  if (result.length && result[result.length - 1].role === "user") result.pop();

  return result;
}

function historyBytes(history) {
  // The Yandex session_state limit is in bytes, not JavaScript string characters.
  return Buffer.byteLength(JSON.stringify({ history }), "utf8");
}

function fitHistoryToSessionLimit(history) {
  let result = normalizeHistory(history);

  // Remove the oldest complete turn(s) until the serialized state fits.
  while (result.length > 2 && historyBytes(result) > MAX_SESSION_STATE_BYTES) {
    result = result.slice(2);
  }

  // Extremely long Unicode/emoji content can still exceed the limit with one turn.
  while (result.length && historyBytes(result) > MAX_SESSION_STATE_BYTES) {
    let longestIndex = 0;
    for (let i = 1; i < result.length; i++) {
      if (Array.from(result[i].text).length > Array.from(result[longestIndex].text).length) {
        longestIndex = i;
      }
    }

    const chars = Array.from(result[longestIndex].text);
    if (chars.length <= 12) {
      result = [];
      break;
    }

    result[longestIndex].text = chars.slice(0, Math.max(12, Math.floor(chars.length * 0.7))).join("");
  }

  return result;
}

function aliceResponse(text, endSession = false, history = []) {
  const sessionHistory = fitHistoryToSessionLimit(history);

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
  // Avoid searching broad follow-ups such as "где я живу?".
  // These patterns target requests where fresh information is useful.
  return /погод|новост|курс валют|курс доллара|курс евро|цен[аы]|сколько стоит|стоимость|сегодняшн|сейчас|последн(?:ие|их|яя|ий|юю)|свеж(?:ие|ую|ие данные)|актуальн|прогноз|расписание|результаты матч|котировки/i.test(text);
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("UPSTREAM_TIMEOUT");
    }
    throw error;
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
      SERPER_TIMEOUT_MS
    );

    if (!response.ok) {
      console.error("Serper request failed with status:", response.status);
      return "";
    }

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 3)
      .map((item, index) => {
        const title = String(item.title || "").slice(0, 120);
        const snippet = String(item.snippet || "").slice(0, 200);
        return `${index + 1}. ${title}: ${snippet}`.trim();
      });

    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.error("Serper request failed:", error?.message || error);
    return "";
  }
}

async function askGemini(text, history, searchContext) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error("INVALID_GEMINI_MODEL");

  const contents = normalizeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const currentPrompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}`
    : text;

  // Always add the current user turn separately. Do not merge it into an old turn.
  contents.push({
    role: "user",
    parts: [{ text: currentPrompt }]
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const { response, data } = await fetchJson(
    url,
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
          temperature: 0.5,
          maxOutputTokens: 200
        }
      })
    },
    GEMINI_TIMEOUT_MS
  );

  if (!response.ok) {
    const message = String(data?.error?.message || `HTTP_${response.status}`);
    const status = Number(response.status || 0);
    const lower = message.toLowerCase();

    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429 || lower.includes("quota") || lower.includes("resource_exhausted")) {
      throw new Error("GEMINI_QUOTA");
    }
    if (status === 503 || lower.includes("high demand")) throw new Error("GEMINI_BUSY");
    if (status === 404) throw new Error("GEMINI_MODEL_NOT_FOUND");

    console.error("Gemini request failed:", status, message.slice(0, 300));
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (answer) return answer;

  console.error("Gemini returned no text. Finish reason:", candidate?.finishReason || "unknown");
  throw new Error("GEMINI_EMPTY_RESPONSE");
}

function errorForUser(error) {
  const message = String(error?.message || "");

  if (message === "MISSING_GEMINI_KEY") {
    return "Сервер не настроен. Проверьте переменную GEMINI_API_KEY в Vercel.";
  }
  if (message === "GEMINI_KEY_REJECTED") {
    return "Не удалось подключиться к Gemini. Проверьте API-ключ и доступ к модели в Vercel.";
  }
  if (message === "GEMINI_QUOTA") {
    return "Сейчас исчерпан лимит запросов к Gemini. Попробуйте немного позже.";
  }
  if (message === "GEMINI_BUSY") {
    return "Сейчас сервис перегружен. Попробуйте ещё раз через несколько секунд.";
  }
  if (message === "GEMINI_MODEL_NOT_FOUND" || message === "INVALID_GEMINI_MODEL") {
    return "Не удалось найти выбранную модель Gemini. Проверьте переменную GEMINI_MODEL в Vercel.";
  }
  if (message === "UPSTREAM_TIMEOUT") {
    return "Ответ задерживается. Попробуйте спросить короче.";
  }
  if (message === "GEMINI_EMPTY_RESPONSE") {
    return "Не получилось сформировать ответ. Попробуйте переформулировать вопрос.";
  }

  return "Не удалось подготовить ответ. Попробуйте ещё раз немного позже.";
}

function parseRequestBody(body) {
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return body && typeof body === "object" ? body : {};
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

  const body = parseRequestBody(req.body);
  const text = String(
    body?.request?.command || body?.request?.original_utterance || ""
  ).trim();

  // Yandex Dialogs returns the previous response's session_state here.
  const oldHistory = fitHistoryToSessionLimit(body?.state?.session?.history);

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
    const updatedHistory = fitHistoryToSessionLimit([
      ...oldHistory,
      { role: "user", text },
      { role: "model", text: answer }
    ]);

    return res.status(200).json(aliceResponse(answer, false, updatedHistory));
  } catch (error) {
    console.error("Handler caught error:", error?.message || error);
    // Do not destroy the previous history on a transient upstream error.
    return res.status(200).json(aliceResponse(errorForUser(error), false, oldHistory));
  }
}
