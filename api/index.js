export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "Webhook ready" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  console.log("=== REQUEST RECEIVED ===");
  console.log("Method:", req.method);
  console.log("Body:", JSON.stringify(req.body, null, 2));

  const body = req.body || {};
  const text = body?.request?.command || body?.request?.original_utterance || "";
  
  // Читаем историю из хранилища Яндекса
  const history = body?.state?.session?.value?.history || [];
  
  console.log("Extracted text:", text);
  console.log("Extracted history:", JSON.stringify(history));

  // Простой ответ без Gemini (для теста хранилища)
  const newHistory = [
    ...history,
    { role: "user", text: text },
    { role: "model", text: "Тестовый ответ" }
  ].slice(-3);

  const response = {
    version: "1.0",
    response: {
      text: `Вы сказали: "${text}". История: ${history.length} сообщений.`,
      end_session: false
    },
    session_state: {
      history: newHistory
    }
  };

  console.log("Sending response:", JSON.stringify(response, null, 2));
  return res.status(200).json(response);
}
