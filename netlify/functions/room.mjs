// Комната игры «Что бы ты выбрала?»: хранит вопрос и ответы в Netlify Blobs,
// новые вопросы и комментарии к ответам придумывает Claude.
import { getStore } from "@netlify/blobs";
import Anthropic from "@anthropic-ai/sdk";

export const config = { path: "/api/room" };

const PLAYERS = { vanya: "Ваня", zlata: "Злата" };

export const TOPICS = {
  cute: "милое и уютное",
  romance: "романтика",
  travel: "путешествия и свидания",
  food: "еда и вкусняшки",
  future: "наше будущее",
  funny: "смешное и абсурдное",
  spicy: "пикантное, флирт с намёком (без откровенностей)",
  english: "английский язык и IT, по-доброму подшучивая над профессиями",
};

// Запасные вопросы, если ИИ недоступен (нет ключа или ошибка)
const FALLBACK = [
  ["Свидание на море", "Свидание в горах"],
  ["Проснуться вместе в 6 утра и встретить рассвет", "Проспать до обеда в обнимку"],
  ["Готовить ужин вместе", "Заказать доставку и смотреть фильм"],
  ["Поцелуй под дождём", "Поцелуй под снегом"],
  ["Поездка во Львов на кофе", "Поездка в Киев на прогулку по Подолу"],
  ["Читать мысли друг друга", "Телепортироваться друг к другу раз в день"],
  ["Пицца", "Суши"],
  ["Кошка", "Собака"],
  ["Медленный танец на кухне", "Караоке дуэтом"],
  ["Домик в Карпатах", "Квартира с видом на город"],
  ["Получать голосовые", "Получать длинные сообщения"],
  ["Новый год вдвоём", "Новый год с друзьями"],
  ["Один долгий звонок", "Много коротких в течение дня"],
  ["Пикник в парке", "Ужин при свечах"],
  ["Спросить «How are you?» и услышать честный ответ", "Услышать «I miss you» без повода"],
  ["Массаж", "Завтрак в постель"],
];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const keys = room => ({
  state: `${room}/state`,
  score: `${room}/score`,
  choice: (round, p) => `${room}/r${round}/${p}`,
  comment: round => `${room}/r${round}/comment`,
});

// ===== ИИ =====
let client;
const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);
const getClient = () => (client ??= new Anthropic());

const ABOUT_US =
  "Пара: Ваня (Киев, айтишник) и Злата (Львов, репетитор английского). " +
  "Познакомились на Badoo, встречаются с 14 октября 2026 года, пока на расстоянии и ещё не виделись вживую. " +
  "Злата очень милая и любит пастельный розовый. Пиши по-русски, тепло и с юмором. " +
  "Не касайся войны, политики и бывших.";

async function askClaude(prompt, schema, maxTokens) {
  const response = await getClient().beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    system: ABOUT_US,
    messages: [{ role: "user", content: prompt }],
  });
  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") return null;
  const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
  return JSON.parse(text);
}

async function makeQuestion(topicKey, custom, history) {
  const topic = custom?.trim() ? custom.trim().slice(0, 80) : TOPICS[topicKey] ?? TOPICS.cute;
  if (aiEnabled()) {
    try {
      const recent = history.slice(-25).map(h => `- ${h}`).join("\n") || "(пока не было)";
      const q = await askClaude(
        `Придумай один новый вопрос для игры «Что бы ты выбрал(а)?» для этой пары. Тема: ${topic}.\n` +
          "Два варианта, оба привлекательные, чтобы выбор был интересным. Каждый вариант до 70 символов, без нумерации.\n" +
          `Не повторяй уже заданные:\n${recent}`,
        {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          required: ["a", "b"],
          additionalProperties: false,
        },
        2000,
      );
      if (q?.a && q?.b) return { a: q.a, b: q.b, topic, ai: true };
    } catch (err) {
      console.error("question generation failed:", err);
    }
  }
  const unused = FALLBACK.filter(([a, b]) => !history.includes(`${a} | ${b}`));
  const [a, b] = (unused.length ? unused : FALLBACK)[Math.floor(Math.random() * (unused.length || FALLBACK.length))];
  return { a, b, topic, ai: false };
}

async function makeComment(question, picks) {
  const text = Object.entries(picks)
    .map(([p, c]) => `${PLAYERS[p]} выбрал${p === "zlata" ? "а" : ""}: «${c === "a" ? question.a : question.b}»`)
    .join("; ");
  const same = picks.vanya === picks.zlata;
  if (aiEnabled()) {
    try {
      const r = await askClaude(
        `Вопрос: «${question.a}» или «${question.b}». ${text}. ` +
          `${same ? "Они совпали." : "Они выбрали разное."} ` +
          "Напиши один короткий милый комментарий к результату (до 140 символов), можно с одним эмодзи.",
        {
          type: "object",
          properties: { comment: { type: "string" } },
          required: ["comment"],
          additionalProperties: false,
        },
        1500,
      );
      if (r?.comment) return r.comment;
    } catch (err) {
      console.error("comment generation failed:", err);
    }
  }
  return same ? "Совпали! Вы на одной волне 💗" : "Разные ответы. Отличный повод обсудить 😉";
}

// ===== Логика комнаты (store передаётся снаружи, чтобы её можно было тестировать) =====
async function view(store, k, me) {
  const state = (await store.get(k.state, { type: "json" })) ?? null;
  const score = (await store.get(k.score, { type: "json" })) ?? { matches: 0, total: 0 };
  if (!state) return { round: 0, question: null, score };
  const picks = {};
  for (const p of Object.keys(PLAYERS)) picks[p] = await store.get(k.choice(state.round, p));
  const both = picks.vanya && picks.zlata;
  const partner = me === "vanya" ? "zlata" : "vanya";
  return {
    round: state.round,
    question: state.question,
    mine: picks[me] ?? null,
    partnerChose: Boolean(picks[partner]),
    reveal: both ? picks : null,
    comment: both ? await store.get(k.comment(state.round)) : null,
    score,
  };
}

export async function handle(req, store) {
  const url = new URL(req.url);
  const room = (url.searchParams.get("room") || "vanya-zlata").replace(/[^a-z0-9-]/gi, "").slice(0, 40);
  const k = keys(room);

  if (req.method === "GET") {
    const me = url.searchParams.get("me");
    if (!PLAYERS[me]) return json({ error: "Укажи игрока: me=vanya или me=zlata" }, 400);
    return json(await view(store, k, me));
  }

  if (req.method !== "POST") return json({ error: "Метод не поддерживается" }, 405);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Некорректный запрос" }, 400);
  }
  const { action, me } = body;
  if (!PLAYERS[me]) return json({ error: "Укажи игрока: vanya или zlata" }, 400);

  if (action === "next") {
    const state = (await store.get(k.state, { type: "json" })) ?? { round: 0, history: [] };
    // если второй игрок уже переключил вопрос, не переключаем ещё раз
    if (typeof body.fromRound === "number" && body.fromRound !== state.round) return json(await view(store, k, me));
    const question = await makeQuestion(body.topic, body.custom, state.history);
    const next = {
      round: state.round + 1,
      question,
      history: [...state.history, `${question.a} | ${question.b}`].slice(-60),
    };
    await store.setJSON(k.state, next);
    return json(await view(store, k, me));
  }

  if (action === "choose") {
    const state = await store.get(k.state, { type: "json" });
    if (!state || body.round !== state.round) return json({ error: "Вопрос уже сменился, обнови страницу" }, 409);
    if (body.choice !== "a" && body.choice !== "b") return json({ error: "Выбери вариант a или b" }, 400);
    if (await store.get(k.choice(state.round, me))) return json(await view(store, k, me));
    await store.set(k.choice(state.round, me), body.choice);

    const partner = me === "vanya" ? "zlata" : "vanya";
    const other = await store.get(k.choice(state.round, partner));
    if (other) {
      const picks = { [me]: body.choice, [partner]: other };
      const score = (await store.get(k.score, { type: "json" })) ?? { matches: 0, total: 0 };
      score.total += 1;
      if (picks.vanya === picks.zlata) score.matches += 1;
      await store.setJSON(k.score, score);
      await store.set(k.comment(state.round), await makeComment(state.question, picks));
    }
    return json(await view(store, k, me));
  }

  if (action === "reset") {
    await store.setJSON(k.score, { matches: 0, total: 0 });
    return json(await view(store, k, me));
  }

  return json({ error: "Неизвестное действие" }, 400);
}

export default async req => handle(req, getStore({ name: "would-you-rather", consistency: "strong" }));
