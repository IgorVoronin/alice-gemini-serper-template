// Конфигурация
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const MAX_HISTORY_PAIRS = 4; // 4 пары вопрос-ответ
const MAX_TEXT_LENGTH = 180; // Лимит символов на сообщение (чтобы уложиться в 1 КБ)
const MAX_ALICE_TEXT = 1000;
const TOTAL_TIMEOUT_MS = 4000;
const SERPER_TIMEOUT_MS = 800;
const GEMINI_TIMEOUT_MS = 2800;

const SYSTEM_PROMPT = "Ты — голосовой помощник в навыке Яндекс Алисы. Отвечай кратко, по-русски, 1-3 предложениями. Не используй markdown, списки, таблицы. Если не знаешь ответа — скажи об этом.";

// Функция для обрезки текста
function truncate(text, max) {
  const str = String(text || "").replace(/\s+/g, " ").trim();
  return str.length > max ? str.slice(0, max) : str;
}

// Функция для ответа Алисе
function buildResponse(text, history = []) {
  return {
    version: "1.0",
    response: {
      text: truncate(text, MAX_ALICE_TEXT) || "Не удалось подготовить ответ.",
      end_session: false
    },
    session_state: { history }
  };
}

// Определение поискового запроса
function isSearchQuery(text) {
  const searchWords = /\b(погода|новости|курс|цена|сколько|когда|где|кто|что сейчас|последние|свежие|актуальные)\b/i;
  return searchWords.test(text);
}

// Поиск через Serper
async function searchWeb(query, timeoutMs) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 }),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!response.ok) return null;

    const data = await response.json();
    const snippets = (data.organic || []).slice(0, 3).map(item => 
      `${item.title}: ${item.snippet}`
    );
    
    return snippets.length > 0 ? snippets.join("\n") : null;
  } catch (error) {
    console.warn("Search failed:", error.message);
    return null;
  }
}

// Запрос к Gemini
async function askGemini(userText, history, searchContext, timeoutMs) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_KEY_MISSING");

  // Формируем контекст для Gemini
  const contents = [];
  
  // Добавляем историю
  for (const msg of history) {
    contents.push({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.text }]
    });
  }

  // Добавляем текущий запрос с контекстом поиска
  let finalPrompt = userText;
  if (searchContext) {
    finalPrompt = `${userText}\n\nКонтекст из поиска:\n${searchContext}`;
  }
  
  contents.push({
    role: "user",
    parts: [{ text: finalPrompt }]
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT }]
          },
          contents,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 200
          }
        }),
        signal: controller.signal
      }
    );

    clearTimeout(timer);

    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 403) throw new Error("GEMINI_KEY_INVALID");
      if (status === 429) throw new Error("GEMINI_RATE_LIMIT");
      throw new Error(`GEMINI_HTTP_${status}`);
    }

    const data = await response.json();
    const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!answer || answer.trim() === "") {
      throw new Error("GEMINI_EMPTY");
    }

    return answer.trim();
  } catch (error) {
    clearTimeout(timer);
    if (error.name === "AbortError") throw new Error("TIMEOUT");
    throw error;
  }
}

// Обработка ошибок для пользователя
function getErrorMessage(error) {
  const msg = error.message;
  if (msg === "GEMINI_KEY_MISSING") return "Навык не настроен. Обратитесь к разработчику.";
  if (msg === "GEMINI_KEY_INVALID") return "Ошибка подключения к нейросети. Попробуйте позже.";
  if (msg === "GEMINI_RATE_LIMIT") return "Превышен лимит запросов. Попробуйте через минуту.";
  if (msg === "GEMINI_EMPTY") return "Не удалось получить ответ. Попробуйте переформулировать вопрос.";
  if (msg === "TIMEOUT") return "Превышено время ожидания. Попробуйте ещё раз.";
  return "Произошла ошибка. Попробуйте ещё раз.";
}

// Главный обработчик
export default async function handler(req, res) {
  // GET запрос — проверка работоспособности
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-assistant",
      message: "Webhook is ready"
    });
  }

  // Только POST
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startTime = Date.now();
  const getRemainingTime = () => TOTAL_TIMEOUT_MS - (Date.now() - startTime);

  try {
    const body = req.body || {};
    
    // Логируем запрос для отладки
    console.log("Request received:", JSON.stringify(body).slice(0, 500));

    // Извлекаем текст запроса
    const userText = String(
      body?.request?.command || 
      body?.request?.original_utterance || 
      ""
    ).trim();

    // Извлекаем историю из хранилища Яндекса
    const savedHistory = body?.state?.session?.value?.history || [];
    
    // Валидируем историю
    const history = savedHistory
      .filter(item => 
        item && 
        (item.role === "user" || item.role === "model") && 
        typeof item.text === "string"
      )
      .map(item => ({
        role: item.role,
        text: truncate(item.text, MAX_TEXT_LENGTH)
      }));

    // Если нет текста — приветствие
    if (!userText) {
      return res.status(200).json(buildResponse(
        "Привет! Я готов помочь. Что хочешь узнать?",
        history
      ));
    }

    // Определяем, нужен ли поиск
    let searchContext = null;
    if (isSearchQuery(userText) && getRemainingTime() > SERPER_TIMEOUT_MS + 500) {
      searchContext = await searchWeb(userText, Math.min(SERPER_TIMEOUT_MS, getRemainingTime() - 500));
    }

    // Получаем ответ от Gemini
    const answer = await askGemini(
      userText,
      history,
      searchContext,
      Math.min(GEMINI_TIMEOUT_MS, getRemainingTime() - 300)
    );

    // Обновляем историю
    const newHistory = [
      ...history,
      { role: "user", text: truncate(userText, MAX_TEXT_LENGTH) },
      { role: "model", text: truncate(answer, MAX_TEXT_LENGTH) }
    ].slice(-MAX_HISTORY_PAIRS * 2);

    // Проверяем размер session_state (должен быть < 1 КБ)
    const sessionStateSize = JSON.stringify({ history: newHistory }).length;
    console.log(`Session state size: ${sessionStateSize} bytes`);

    if (sessionStateSize > 1000) {
      console.warn("Session state too large, trimming history");
      // Если слишком большой — берем только последнее сообщение
      const trimmedHistory = newHistory.slice(-2);
      return res.status(200).json(buildResponse(answer, trimmedHistory));
    }

    return res.status(200).json(buildResponse(answer, newHistory));

  } catch (error) {
    console.error("Handler error:", error.message);
    
    // Пытаемся вернуть историю, если она была
    const body = req.body || {};
    const savedHistory = body?.state?.session?.value?.history || [];
    const history = savedHistory
      .filter(item => item && (item.role === "user" || item.role === "model"))
      .slice(-4);

    return res.status(200).json(buildResponse(
      getErrorMessage(error),
      history
    ));
  }
}

export { handler };
