import { buildSystemPrompt } from "./prompt.js";
import {
  toolDefinitions,
  executeTool,
  pickSuggestedPhotos,
  getPhotoUrls,
} from "./tools.js";

// TODO: set the base URL and model for your OpenAI-compatible provider.
const LLM_BASE_URL = "https://opencode.ai/zen/go/v1";
const LLM_MODEL = "deepseek-v4.1-flash";

const LLM_TIMEOUT_MS = 20_000;
const MAX_ROUNDS = 8;
const MAX_HISTORY = 20;

const FALLBACK_REPLY = "Just go Berseh Food Centre lah.";
const FOOD_WORDS = /\b(eat|lunch|food|makan|hungry|restaurant|hawker)\b/i;

/**
 * Run the agentic loop for one user turn and return Uncle's reply, plus one
 * image for each place the reply suggests.
 *
 * history is the prior conversation as OpenAI-style {role, content} messages.
 */
export async function runLoop(history, message, env) {
  // If the Places key is missing, Uncle cannot search for food, so give a
  // safe answer to food questions. Everything else still goes to the model.
  if (!env.GOOGLE_PLACES_API_KEY && FOOD_WORDS.test(message)) {
    return { reply: FALLBACK_REPLY, images: [] };
  }

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...sanitizeHistory(history),
    { role: "user", content: message },
  ];

  // One session id per turn, shared by every model call in this loop run,
  // so the OpenCode Go endpoint can route and cache consistently.
  const sessionId = crypto.randomUUID();

  // Photos of every place the searches returned, keyed by place name.
  const photos = new Map();

  let round = 0;
  while (round < MAX_ROUNDS) {
    const assistant = await callModel(messages, env, sessionId);
    messages.push(assistant);

    const toolCalls = assistant.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const reply = assistant.content ?? "";
      console.log("DEBUG photos", [...photos.keys()]);
      const images = await getPhotoUrls(pickSuggestedPhotos(reply, photos), env);
      return { reply, images };
    }

    for (const call of toolCalls) {
      const args = parseArgs(call.function.arguments);
      console.log(`round ${round}: ${call.function.name}`, args);
      const result = await executeTool(call.function.name, args, env, photos);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
    round++;
  }

  return {
    reply: "Uncle tried too many times already. Ask something simpler.",
    images: [],
  };
}

async function callModel(messages, env, sessionId) {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENCODE_API_KEY}`,
      "x-opencode-session": sessionId,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      tools: toolDefinitions,
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`LLM returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return data.choices[0].message;
}

/**
 * Keep only the last few user and assistant text messages from the client.
 *
 * The browser sends history, so it cannot be trusted to contain system or
 * tool messages, or to stay a reasonable size.
 */
export function sanitizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }
  return history
    .filter(
      (m) =>
        (m?.role === "user" || m?.role === "assistant") &&
        typeof m.content === "string",
    )
    .slice(-MAX_HISTORY)
    .map(({ role, content }) => ({ role, content }));
}

function parseArgs(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}
