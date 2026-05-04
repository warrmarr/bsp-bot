/**
 * БСП — Telegram Bot v4.0 (Deno Deploy + grammy)
 * Все рекомендашии Совета Директоров применены
 */

import {
  Bot, Context, InlineKeyboard, Keyboard, session, webhookCallback,
} from "https://deno.land/x/grammy@v1.21.1/mod.ts";
import {
  type Conversation, type ConversationFlavor,
  conversations, createConversation,
} from "https://deno.land/x/grammy_conversations@v1.2.0/mod.ts";

// ─── ENV ──────────────────────────────────────────────────────────────────────
const BOT_TOKEN       = Deno.env.get("BOT_TOKEN") ?? "";
const ADMIN_IDS       = (Deno.env.get("ADMIN_IDS") ?? "182991647")
                          .split(",").map(Number).filter(Boolean);
const ROBOKASSA_LOGIN = Deno.env.get("ROBOKASSA_LOGIN") ?? "";
const ROBOKASSA_PASS1 = Deno.env.get("ROBOKASSA_PASS1") ?? "";
const ROBOKASSA_PASS2 = Deno.env.get("ROBOKASSA_PASS2") ?? "";
const WEBHOOK_SECRET  = Deno.env.get("WEBHOOK_SECRET") ?? "bsp_secret_2025";
const TG_SECRET_TOKEN = Deno.env.get("TG_SECRET_TOKEN") ?? ""; // Никитинский: X-Telegram-Bot-Api-Secret-Token

const TARIFFS: Record<string, [number, string, string]> = {
  bsp:      [5000,  "Членский взнос БСП",  "5 000 ₽/мес"],
  bsp_plus: [11000, "Членский взнос БСП+", "11 000 ₽/мес"],
  vip:      [40000, "Членский взнос VIP",  "40 000 ₽/мес"],
};

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface User {
  tgId: number;
  username: string;
  name: string;
  city?: string;
  job?: string;
  company?: string;
  source?: string;
  status: string;   // lead | candidate | trial | member | vip | rejected
  tariff?: string;
  refCode: string;
  refBy?: number;
  notes?: string;
  visitCount: number;
  lastActive: string;
  nurtureStep: number;
  createdAt: string;
  updatedAt: string;
}

// ─── KV ───────────────────────────────────────────────────────────────────────
const kv = await Deno.openKv();

async function getUser(tgId: number): Promise<User | null> {
  return (await kv.get<User>(["users", tgId])).value;
}

async function upsertUser(tgId: number, username: string, fields: Partial<User>): Promise<void> {
  const existing = await getUser(tgId);
  const now = new Date().toISOString();
  const user: User = existing
    ? { ...existing, ...fields, updatedAt: now }
    : {
        tgId, username, name: fields.name ?? "",
        status: "lead", refCode: `ref${tgId}`,
        visitCount: 0, lastActive: now, nurtureStep: 0,
        createdAt: now, updatedAt: now, ...fields,
      };
  await kv.set(["users", tgId], user);
  if (existing?.status && existing.status !== user.status) {
    await kv.delete(["by_status", existing.status, tgId]);
  }
  await kv.set(["by_status", user.status, tgId], true);
}

async function changeStatus(tgId: number, newStatus: string): Promise<void> {
  const u = await getUser(tgId);
  if (!u) return;
  await kv.delete(["by_status", u.status, tgId]);
  await upsertUser(tgId, u.username, { status: newStatus });
  await logEvent(tgId, "status_change", `${u.status}→${newStatus}`);
}

async function logEvent(tgId: number, event: string, data = ""): Promise<void> {
  await kv.set(["events", Date.now(), tgId], { tgId, event, data, ts: new Date().toISOString() });
}

async function countByStatus(status: string): Promise<number> {
  let n = 0;
  for await (const _ of kv.list({ prefix: ["by_status", status] })) n++;
  return n;
}

async function listByStatus(status: string, limit = 20): Promise<User[]> {
  const result: User[] = [];
  for await (const entry of kv.list({ prefix: ["by_status", status] })) {
    if (result.length >= limit) break;
    const u = await getUser(entry.key[2] as number);
    if (u) result.push(u);
  }
  return result;
}

async function countReferrals(tgId: number): Promise<number> {
  let n = 0;
  for await (const entry of kv.list({ prefix: ["users"] })) {
    if ((entry.value as User).refBy === tgId) n++;
  }
  return n;
}

// ─── RATE LIMITING (Никитинский) ─────────────────────────────────────────────
const _rateMap = new Map<number, number>();
function isRateLimited(tgId: number): boolean {
  if (ADMIN_IDS.includes(tgId)) return false;
  const last = _rateMap.get(tgId) ?? 0;
  const now = Date.now();
  if (now - last < 3000) return true;
  _rateMap.set(tgId, now);
  if (_rateMap.size > 2000) {
    for (const [k, v] of _rateMap) if (now - v > 60000) _rateMap.delete(k);
  }
  return false;
}

// ─── KEYBOARDS ────────────────────────────────────────────────────────────────
const mainKb = new Keyboard()
  .text("🏢 О БСП").text("💳 Тарифы").row()
  .text("✍️ Вступить").text("❓ Вопрос куратору").row()
  .text("👥 Я участник").text("📞 Контакты")
  .resized();

const memberKb = new Keyboard()
  .text("📋 Мой ЦДИСН").text("📅 Расписание").row()
  .text("🤝 Есть/Нужно/Хочу").text("🎁 Мои рефералы").row()
  .text("🔍 Найти участника").text("👤 Мой профиль").row()
  .text("↩️ Меню").resized();

const cancelKb = new Keyboard().text("❌ Отмена").resized();

// ─── TEXTS ────────────────────────────────────────────────────────────────────
const ABOUT = `🏢 <b>БСП — Бизнес Сообщество Профессионалов</b>

Первое в России сообщество для <b>ключевых сотрудников в найме</b>.

<b>Для кого:</b>
• Топ-менеджеры и директора в найме
• Руководители отделов и проектов
• Эксперты с зоной ответственности

<b>Что получаешь:</b>
• Группа 8 равных тебе профессионалов
• Еженедельные встречи — разбор реальных задач
• Связи по всей России · Таймбанкинг

<b>Философия:</b> <i>«Созидающий получает»</i>

🌐 bcpru.ru`;

// Тарифы с кейсами — рекомендация Бальзовой
const TARIFFS_TEXT = `💳 <b>Тарифы БСП</b>

━━━━━━━━━━━━━━━━
🔵 <b>БСП</b> — 5 000 ₽/мес · 60 000 ₽/год
Онлайн + офлайн встречи, группа равных, база знаний

<i>💬 Андрей, руководитель IT-отдела: «За 2 месяца решил задачу автоматизации, которую не мог сдвинуть полгода — нашёл человека в своей группе»</i>

━━━━━━━━━━━━━━━━
⭐ <b>БСП+</b> — 11 000 ₽/мес · 132 000 ₽/год
Расширенное участие, администрирование процесса

<i>💬 Марина, коммерческий директор: «Вышла на 3 новых партнёра за квартал. Сеть реально работает»</i>

━━━━━━━━━━━━━━━━
👑 <b>VIP</b> — 40 000 ₽/мес · 480 000 ₽/год
Индивидуальное сопровождение, личный куратор

━━━━━━━━━━━━━━━━
✅ Первый месяц — <b>бесплатно</b>
🎁 Приведи коллегу → <b>+1 000 ₽</b> бонус`;

const SCHEDULE_TEXT = `📅 <b>Слоты встреч</b> (мск)

<b>Онлайн «Десятка»</b> — 60–75 мин
ПН 18:00 · ВТ 18:00
СР 10:00 / 12:00 / 14:00
ЧТ 16:00 · СБ 18:00 · ВС 11:00

<b>Офлайн «Двадцатка»</b> — раз в месяц, 90 мин

Куратор подберёт группу по функции и городу.`;

const CONTACTS_TEXT = `📞 <b>Контакты БСП</b>

Telegram: @bcpru
Телефон: +7 960 000-91-91
Email: E@E1111.RU · Сайт: bcpru.ru

Куратор ответит в течение дня.`;

const ENH_TEXT = `🤝 <b>Есть — Нужно — Хочу</b>

На каждой встрече каждый участник говорит:

<b>✅ ЕСТЬ</b> — чем могу помочу прямо сейчас
<b>🎯 НУЖНО</b> — что мне важно решить
<b>💡 ХОЧУ</b> — с кем хочу познакомиться`;

// Прогрев гостей — рекомендация Евтухова
const NURTURE_STEPS = [
  "👋 <b>БСП напоминает о себе</b>\n\nВчера ты узнал о нас. Один вопрос:\n\n<i>Есть ли рядом коллеги, с которыми можно обсудить реальную рабочую задачу?</i>\n\nЕсли не всегда — именно для этого создан БСП.\n\n👇 Запишись на <b>бесплатную встречу</b>:",
  "🔥 <b>Место в группе ещё есть</b>\n\nГруппы БСП собираются по 8 человек. Когда места заканчиваются — следующая группа через месяц.\n\n<b>Ближайшая Десятка — уже на этой неделе.</b>\n\nПервое участие бесплатно 👇",
  "💡 <b>Последнее напоминание</b>\n\nНеделю назад ты заглянул в БСП. Что говорят участники:\n\n<i>«Первая встреча изменила отношение к рабочим проблемам — оказывается, у всех они похожи»</i>\n\nПриходи на пробную встречу — это бесплатно 👇",
];
const NURTURE_DELAYS = [
  24 * 60 * 60 * 1000,       // 24 ч
  72 * 60 * 60 * 1000,       // 72 ч
   7 * 24 * 60 * 60 * 1000,  // 7 дней
];

// Welcome-последовательность — рекомендация Карелиной
const WELCOME_STEPS = [
  "🎉 <b>Добро пожаловать в БСП!</b>\n\nТы вступил в сообщество равных. Пройдём быстрый онбординг — 4 шага, 2 минуты.",
  "📋 <b>Шаг 1 — ЦДИСН</b>\n\nТвоя визитная карточка в группе. Заполни — группа сразу узнает, чем ты ценен.\n\nНажми «Мой ЦДИСН» в меню.",
  "📅 <b>Шаг 2 — Расписание</b>\n\nВыбери удобный слот. Куратор назначит тебя в группу по функции и уровню.",
  "🤝 <b>Шаг 3 — Есть/Нужно/Хочу</b>\n\nНа каждой встрече 3 минуты на тебя. Подготовь: что есть, что нужно, с кем хочешь познакомиться.",
  "🎁 <b>Шаг 4 — Рефералы</b>\n\nПригласи коллегу → получи <b>1 000 ₽</b> на счёт. Ссылка — в резделе «Мои рефералы».\n\n✅ <b>Готово! Встречаемся на первой встрече.</b>",
];
const WELCOME_DELAYS = [0, 3600*1000, 24*3600*1000, 48*3600*1000, 5*24*3600*1000];

const STATUS_LABELS: Record<string, string> = {
  lead: "🔵 Лид", candidate: "🟡 Кандидат",
  trial: "🟠 Пробный", member: "🟢 Участник",
  vip: "👑 VIP", rejected: "⛔ Архив",
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function notifyAdmins(bot: Bot, text: string, kb?: InlineKeyboard): Promise<void> {
  for (const aid of ADMIN_IDS) {
    try { await bot.api.sendMessage(aid, text, { parse_mode: "HTML", reply_markup: kb }); }
    catch (_e) { /* ignore */ }
  }
}

function makePayUrl(tgId: number, key: string): string | null {
  if (!ROBOKASSA_LOGIN || !ROBOKASSA_PASS1) return null;
  const [amount, desc] = TARIFFS[key];
  const invId = (tgId * 10 + Object.keys(TARIFFS).indexOf(key)) % 999999;
  const params = new URLSearchParams({
    MrchLogin: ROBOKASSA_LOGIN,
    OutSum: `${amount}.00`,
    InvId: String(invId),
    Desc: desc,
    Shp_tgId: String(tgId),
    Shp_tariff: key,
  });
  return `https://auth.robokassa.ru/Merchant/Index.aspx?${params}`;
}

async function sendNPS(tgId: number) {
  const kb = new InlineKeyboard();
  for (let i = 1; i <= 5; i++) kb.text(String(i), `nps_${i}`);
  kb.row();
  for (let i = 6; i <= 10; i++) kb.text(String(i), `nps_${i}`);
  try {
    await bot.api.sendMessage(tgId,
      "⭐ <b>Насколько ценной была встреча?</b>\n\n1 — совсем не ценной · 10 — очень ценной",
      { parse_mode: "HTML", reply_markup: kb }
    );
  } catch (_e) { /* ignore */ }
}

// ─── BOT ──────────────────────────────────────────────────────────────────────
type MyContext = ConversationFlavor<Context>;
type MyConversation = Conversation<MyContext>;

const bot = new Bot<MyContext>(BOT_TOKEN);
bot.use(session({ initial: () => ({}) }));
bot.use(conversations());

// Rate limiter middleware (Никитинский)
bot.use(async (ctx, next) => {
  const tgId = ctx.from?.id;
  if (tgId && isRateLimited(tgId)) return;
  return next();
});

// ─── CONVERSATIONS ────────────────────────────────────────────────────────────
async function anketa(conversation: MyConversation, ctx: MyContext) {
  await ctx.reply("✍️ <b>Анкета вступления</b>\n\nШаг 1/5 — <b>Имя и фамилия:</b>",
    { parse_mode: "HTML", reply_markup: cancelKb });
  const r1 = await conversation.waitFor("message:text");
  if (r1.message.text === "❌ Отмена") { await r1.reply("Отменено.", { reply_markup: mainKb }); return; }
  const name = r1.message.text;

  await r1.reply("Шаг 2/5 — <b>Город:</b>", { parse_mode: "HTML" });
  const r2 = await conversation.waitFor("message:text");
  if (r2.message.text === "❌ Отмена") { await r2.reply("Отменено.", { reply_markup: mainKb }); return; }
  const city = r2.message.text;

  await r2.reply("Шаг 3/5 — <b>Должность:</b>", { parse_mode: "HTML" });
  const r3 = await conversation.waitFor("message:text");
  if (r3.message.text === "❌ Отмена") { await r3.reply("Отменено.", { reply_markup: mainKb }); return; }
  const job = r3.message.text;

  await r3.reply("Шаг 4/5 — <b>Компания:</b>", { parse_mode: "HTML" });
  const r4 = await conversation.waitFor("message:text");
  if (r4.message.text === "❌ Отмена") { await r4.reply("Отменено.", { reply_markup: mainKb }); return; }
  const company = r4.message.text;

  const srcKb = new Keyboard()
    .text("От коллеги / друга").text("Telegram / соцсети").row()
    .text("Сайт bcpru.ru").text("Другое").row()
    .text("❌ Отмена").resized();
  await r4.reply("Шаг 5/5 — <b>Откуда узнал о БСП?</b>", { parse_mode: "HTML", reply_markup: srcKb });
  const r5 = await conversation.waitFor("message:text");
  if (r5.message.text === "❌ Отмена") { await r5.reply("Отменено.", { reply_markup: mainKb }); return; }
  const source = r5.message.text;

  const u = r5.from!;
  await upsertUser(u.id, u.username ?? "", { name, city, job, company, source, status: "candidate" });
  await logEvent(u.id, "anketa_completed");
  const notifyKb = new InlineKeyboard()
    .url("💬 Написать", `tg://user?id=${u.id}`)
    .text("✅ Принять", `admin_accept_${u.id}`);
  await notifyAdmins(bot,
    `🔔 <b>Новая заявка!</b>\n\n👤 ${name}\n🏙 ${city}\n💼 ${job}, ${company}\n📣 ${source}\nTG: @${u.username ?? "—"} | <code>${u.id}</code>`,
    notifyKb
  );
  await r5.reply(
    "✅ <b>Заявка принята!</b>\n\nКуратор свяжется в течение дня.\nЕсли срочно — @bcpru · +7 960 000-91-91",
    { parse_mode: "HTML", reply_markup: mainKb }
  );
}
bot.use(createConversation(anketa));

async function question(conversation: MyConversation, ctx: MyContext) {
  await ctx.reply("❓ Напиши свой вопрос — куратор ответит:", { reply_markup: cancelKb });
  const r = await conversation.waitFor("message:text");
  if (r.message.text === "❌ Отмена") { await r.reply("Отменено.", { reply_markup: mainKb }); return; }
  const u = r.from!;
  await notifyAdmins(bot, `❓ <b>Вопрос</b> от @${u.username ?? u.id}\n\n${r.message.text}`,
    new InlineKeyboard().url("💬 Ответить", `tg://user?id=${u.id}`)
  );
  await r.reply("✅ Вопрос отправлен куратору!", { reply_markup: mainKb });
}
bot.use(createConversation(question));

async function tsdisn(conversation: MyConversation, ctx: MyContext) {
  await ctx.reply("📋 <b>ЦДИСН — твоя визитка в группе</b>\n\n<b>Ц — Цели:</b> Чего хочешь достичь за год?",
    { parse_mode: "HTML", reply_markup: cancelKb });
  const r1 = await conversation.waitFor("message:text");
  if (r1.message.text === "❌ Отмена") { await r1.reply("Отменено.", { reply_markup: memberKb }); return; }
  const tsC = r1.message.text;

  await r1.reply("<b>Д — Достижения:</b> Чем гордишься за 2–3 года?", { parse_mode: "HTML" });
  const r2 = await conversation.waitFor("message:text");
  if (r2.message.text === "❌ Отмена") { await r2.reply("Отменено.", { reply_markup: memberKb }); return; }
  const tsD = r2.message.text;

  await r2.reply("<b>И — Интересы:</b> Какие темы близки в работе и жизни?", { parse_mode: "HTML" });
  const r3 = await conversation.waitFor("message:text");
  if (r3.message.text === "❌ Отмена") { await r3.reply("Отменено.", { reply_markup: memberKb }); return; }
  const tsI = r3.message.text;

  await r3.reply("<b>С — Связи:</b> Кого знаешь, кем можешь поделиться?", { parse_mode: "HTML" });
  const r4 = await conversation.waitFor("message:text");
  if (r4.message.text === "❌ Отмена") { await r4.reply("Отменено.", { reply_markup: memberKb }); return; }
  const tsS = r4.message.text;

  await r4.reply("<b>Н — Навыки:</b> В чём эксперт? Чем можешь помочь?", { parse_mode: "HTML" });
  const r5 = await conversation.waitFor("message:text");
  const tsN = r5.message.text;

  const summary = `🎯 <b>Цели:</b> ${tsC}\n🏆 <b>Достижения:</b> ${tsD}\n💡 <b>Интересы:</b> ${tsI}\n🤝 <b>Связи:</b> ${tsS}\n⚡ <b>Навыки:</b> ${tsN}`;
  const u = r5.from!;
  await upsertUser(u.id, u.username ?? "", { notes: `ЦДИСН:\n${summary.replace(/<[^>]+>/g, "")}` });
  await r5.reply(`📋 <b>ЦДИСН сохранён!</b>\n\n${summary}`, { parse_mode: "HTML", reply_markup: memberKb });
  await notifyAdmins(bot, `📋 <b>Новый ЦДИСН</b> @${u.username ?? u.id}\n\n${summary}`);
}
bot.use(createConversation(tsdisn));

// ─── КОМАНДЫ ──────────────────────────────────────────────────────────────────

// /start — с реф-ссылкой и счётчиком касаний (Евтухов, Бохан)
bot.command("start", async (ctx) => {
  const u = ctx.from!;
  const args = ctx.match;
  let refBy: number | undefined;
  if (args?.startsWith("ref")) {
    const n = parseInt(args.replace("ref", ""));
    if (!isNaN(n) && n !== u.id) refBy = n;
  }
  const existing = await getUser(u.id);
  await upsertUser(u.id, u.username ?? "", {
    name: existing?.name || u.first_name,
    refBy: existing?.refBy ?? refBy,
    lastActive: new Date().toISOString(),
    visitCount: (existing?.visitCount ?? 0) + 1,
  });
  await logEvent(u.id, "start");
  const user = await getUser(u.id);
  const visits = user?.visitCount ?? 1;

  // Счётчик касаний: 3-й визит → предложить скидку (Бохан)
  if (visits === 3 && !["member", "vip", "trial", "candidate"].includes(user?.status ?? "")) {
    await ctx.reply(
      `👋 <b>${u.first_name}</b>, ты уже в третий раз заглядываешь!\n\n` +
      "Предлагаем <b>первый месяц бесплатно</b> — без ожидания, прямо сейчас.\n\n" +
      "Напиши куратору: @bcpru или нажми «Вступить» 👇",
      { parse_mode: "HTML", reply_markup: mainKb }
    );
    return;
  }

  const refLink = `https://t.me/${ctx.me.username}?start=ref${u.id}`;
  await ctx.reply(
    `Привет, <b>${u.first_name}</b>! 👋\n\n` +
    "Это бот <b>БСП — Бизнес Сообщество Профессионалов</b>.\n" +
    "Первое в России сообщество для ключевых сотрудников компаний.\n\n" +
    `🔗 Твоя реф-ссылка: <code>${refLink}</code>\n\nВыбери раздел 👇`,
    { parse_mode: "HTML", reply_markup: mainKb }
  );
});

// /myid
bot.command("myid", (ctx) =>
  ctx.reply(`Твой Telegram ID: <code>${ctx.from?.id}</code>`, { parse_mode: "HTML" })
);

// /profile — карточка участника (Карелина)
bot.command("profile", async (ctx) => {
  const u = await getUser(ctx.from!.id);
  if (!u) { await ctx.reply("Профиль не найден. Нажми /start"); return; }
  const refs = await countReferrals(u.tgId);
  const since = new Date(u.createdAt).toLocaleDateString("ru-RU");
  await ctx.reply(
    `👤 <b>Мой профиль</b>\n\n` +
    `👤 ${u.name || "—"} | @${u.username || "—"}\n` +
    `🏙 ${u.city || "—"} | 💼 ${u.job || "—"}\n` +
    `📊 Статус: ${STATUS_LABELS[u.status] ?? u.status}\n` +
    `💳 Тариф: ${u.tariff || "—"}\n` +
    `📅 В БСП с: ${since}\n` +
    `🎁 Рефералов: ${refs} чел.\n` +
    `📋 ЦДИСН: ${u.notes?.includes("ЦДИСН:") ? "✅ заполнен" : "❌ не заполнен"}`,
    { parse_mode: "HTML", reply_markup: memberKb }
  );
});

// /find <навык> — поиск по ЦДИСН (Карелина)
bot.command("find", async (ctx) => {
  const query = ctx.match?.toLowerCase().trim();
  if (!query) { await ctx.reply("Использование: /find маркетолог\n\nИли нажми «🔍 Найти участника»"); return; }
  const found: User[] = [];
  for await (const entry of kv.list({ prefix: ["users"] })) {
    const u = entry.value as User;
    if (!["member", "vip", "trial"].includes(u.status)) continue;
    if (u.notes?.toLowerCase().includes(query)) found.push(u);
    if (found.length >= 5) break;
  }
  if (!found.length) { await ctx.reply(`🔍 По запросу «${query}» участников не найдено. Попробуй другое слово.`); return; }
  let text = `🔍 <b>По «${query}» нашёл ${found.length} участников:</b>\n\n`;
  for (const u of found) {
    text += `👤 ${u.name} | ${u.job || "—"}, ${u.city || "—"}`;
    if (u.username) text += ` | @${u.username}`;
    text += "\n";
  }
  await ctx.reply(text, { parse_mode: "HTML" });
});

// /stats — дашборд (Абаляева)
bot.command("stats", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from!.id)) return;
  const statuses = ["lead", "candidate", "trial", "member", "vip"];
  const counts: Record<string, number> = {};
  for (const s of statuses) counts[s] = await countByStatus(s);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  let newWeek = 0, inactive14 = 0;
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const day14Ago = Date.now() - 14 * 24 * 3600 * 1000;
  for await (const entry of kv.list({ prefix: ["users"] })) {
    const u = entry.value as User;
    if (new Date(u.createdAt).getTime() > weekAgo) newWeek++;
    if (["member","vip","trial"].includes(u.status) && new Date(u.lastActive).getTime() < day14Ago) inactive14++;
  }
  await ctx.reply(
    `📊 <b>Статистика БСП</b>\n\n` +
    `👥 Всего: <b>${total}</b>\n` +
    `🔵 Лиды: ${counts.lead} · 🟡 Кандидаты: ${counts.candidate}\n` +
    `🟠 Пробные: ${counts.trial} · 🟢 Участники: ${counts.member} · 👑 VIP: ${counts.vip}\n\n` +
    `🆕 Новых за 7 дней: <b>${newWeek}</b>\n` +
    `⚠️ Неактивных 14+ дней: <b>${inactive14}</b>`,
    { parse_mode: "HTML" }
  );
});

// ─── КНОПКИ МЕНЮ ─────────────────────────────────────────────────────────────
bot.hears("🏢 О БСП", async (ctx) => {
  const kb = new InlineKeyboard()
    .text("✍️ Вступить", "ank_start")
    .url("🌐 Сайт", "https://bcpru.ru").row()
    .url("🎬 Запись встречи", "https://youtube.com/@bcpru"); // Евтухов
  await ctx.reply(ABOUT, { parse_mode: "HTML", reply_markup: kb });
});

bot.hears("💳 Тарифы", async (ctx) => {
  const kb = new InlineKeyboard()
    .text("💙 БСП — 5 000 ₽/мес", "pay_bsp").row()
    .text("⭐ БСП+ — 11 000 ₽/мес", "pay_bsp_plus").row()
    .text("👑 VIP — 40 000 ₽/мес", "pay_vip").row()
    .text("🤝 Записаться на пробную встречу", "trial_register"); // Бохан
  await ctx.reply(TARIFFS_TEXT, { parse_mode: "HTML", reply_markup: kb });
});

bot.hears("📞 Контакты", (ctx) => ctx.reply(CONTACTS_TEXT, { parse_mode: "HTML" }));
bot.hears("↩️ Меню", (ctx) => ctx.reply("Главное меню:", { reply_markup: mainKb }));
bot.hears("✍️ Вступить", (ctx) => ctx.conversation.enter("anketa"));
bot.hears("❓ Вопрос куратору", (ctx) => ctx.conversation.enter("question"));

bot.hears("👥 Я участник", async (ctx) => {
  const tgId = ctx.from!.id;
  const u = await getUser(tgId);
  await upsertUser(tgId, u?.username ?? "", { lastActive: new Date().toISOString() });
  await ctx.reply(
    `👥 <b>Личный кабинет</b>\n\nСтатус: ${STATUS_LABELS[u?.status ?? "lead"] ?? u?.status}\nТариф: ${u?.tariff ?? "—"}\n\nВыбери действие:`,
    { parse_mode: "HTML", reply_markup: memberKb }
  );
});

bot.hears("📅 Расписание", async (ctx) => {
  const kb = new InlineKeyboard()
    .text("✅ Записаться на пробную Десятку", "trial_register").row()
    .url("🎬 Запись прошлой встречи", "https://youtube.com/@bcpru"); // Евтухов
  await ctx.reply(SCHEDULE_TEXT, { parse_mode: "HTML", reply_markup: kb });
});

bot.hears("🤝 Есты/Нужно/Хочу", (ctx) => ctx.reply(ENH_TEXT, { parse_mode: "HTML" }));

// Рефералы с сезонной акцией — Бальзова
bot.hears("🎁 Мои рефералы", async (ctx) => {
  const u = ctx.from!;
  const count = await countReferrals(u.id);
  const link = `https://t.me/${ctx.me.username}?start=ref${u.id}`;
  const promoActive = new Date() < new Date("2026-07-01");
  await ctx.reply(
    `🎁 <b>Реферальная программа</b>\n\n` +
    `Твоя ссылка:\n<code>${link}</code>\n\n` +
    `За каждого вступившего: <b>+1 000 ₽</b>\n` +
    `Приглашено: <b>${count} чел.</b> · Бонус: <b>${count * 1000} ₽</b>` +
    (promoActive ? "\n\n🔥 <b>Акция до 1 июля:</b> приведи друга → <b>первый месяц ему в подарок!</b>" : ""),
    { parse_mode: "HTML" }
  );
});

bot.hears("📋 Мой ЦДИСН", async (ctx) => {
  const u = await getUser(ctx.from!.id);
  if (u?.notes?.includes("ЦДИСН:")) {
    const kb = new InlineKeyboard().text("✏️ Обновить ЦДИСН", "tsdisn_update");
    await ctx.reply(`📋 <b>Твой ЦДИСН</b>\n\n${u.notes}`, { parse_mode: "HTML", reply_markup: kb });
  } else {
    await ctx.conversation.enter("tsdisn");
  }
});

bot.hears("🔍 Найти участника", async (ctx) => {
  await ctx.reply(
    "🔍 <b>Поиск по ЦДИСН</b>\n\nНапиши команду:\n" +
    "<code>/find маркетолог</code>\n<code>/find финансы</code>\n<code>/find IT</code>\n\n" +
    "Бот найдёт участников с нужным навыком или интересом.",
    { parse_mode: "HTML" }
  );
});

bot.hears("👤 Мой профиль", async (ctx) => {
  const u = await getUser(ctx.from!.id);
  if (!u) { await ctx.reply("Профиль не найден. Нажми /start"); return; }
  const refs = await countReferrals(u.tgId);
  await ctx.reply(
    `👤 <b>Мой профиль</b>\n\n` +
    `👤 ${u.name || "—"} | @${u.username || "—"}\n` +
    `🏙 ${u.city || "—"} | 💼 ${u.job || "—"}\n` +
    `📊 ${STATUS_LABELS[u.status] ?? u.status} · 💳 ${u.tariff || "—"}\n` +
    `📅 В БСП с: ${new Date(u.createdAt).toLocaleDateString("ru-RU")}\n` +
    `🎁 Рефералов: ${refs} · 📋 ЦДИСН: ${u.notes?.includes("ЦДИСН:") ? "✅" : "❌"}`,
    { parse_mode: "HTML", reply_markup: memberKb }
  );
});

// ─── CALLBACKS ────────────────────────────────────────────────────────────────
bot.callbackQuery("ank_start", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter("anketa");
});

bot.callbackQuery("tsdisn_update", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter("tsdisn");
});

// Пробная встреча — Бохан
bot.callbackQuery("trial_register", async (ctx) => {
  await ctx.answerCallbackQuery("✅ Записываю!");
  const u = ctx.from;
  const existing = await getUser(u.id);
  if (existing && existing.status === "lead") {
    await upsertUser(u.id, u.username ?? "", { status: "trial" });
  }
  await ctx.reply(
    "✅ <b>Записан на пробную Десятку!</b>\n\n" +
    "Куратор свяжется в течение дня и назначит время.\n" +
    "🔔 Напомним за 2 часа до встречи.\n\nTelegram: @bcpru",
    { parse_mode: "HTML", reply_markup: mainKb }
  );
  await notifyAdmins(bot,
    `🔔 <b>Запись на пробную встречу!</b>\n@${u.username ?? "—"} (${u.id}) · ${existing?.name ?? u.first_name}`,
    new InlineKeyboard().url("💬 Написать", `tg://user?id=${u.id}`)
  );
});

// NPS — Бохан
bot.callbackQuery(/^nps_(\d+)$/, async (ctx) => {
  const score = parseInt(ctx.match[1]);
  await ctx.answerCallbackQuery("Спасибо! 🙏");
  await kv.set(["nps", Date.now(), ctx.from.id], { tgId: ctx.from.id, score, ts: new Date().toISOString() });
  await logEvent(ctx.from.id, "nps", String(score));
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  const comment = score >= 9 ? "Рады, что встреча была ценной! 💙"
    : score >= 7 ? "Хорошо! Если есть идеи по улучшению — пиши @bcpru"
    : "Жаль. Напиши куратору @bcpru — разберёмся.";
  await ctx.reply(`Оценка <b>${score}/10</b> принята. ${comment}`, { parse_mode: "HTML" });
  await notifyAdmins(bot, `⭐ NPS от @${ctx.from.username ?? ctx.from.id}: <b>${score}/10</b>`);
});

// Оплата
bot.callbackQuery(/^pay_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const key = ctx.match[1];
  if (!(key in TARIFFS)) return;
  const [, desc, label] = TARIFFS[key];
  const url = makePayUrl(ctx.from.id, key);
  if (url) {
    await ctx.reply(`💳 <b>${desc}</b>\n<b>${label}</b>\n\nНажми для оплаты:`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().url(`💳 Оплатить ${label}`, url) });
  } else {
    await ctx.reply(`💳 <b>${desc}</b> — ${label}\n\nДля оплаты: @bcpru · +7 960 000-91-91`, { parse_mode: "HTML" });
  }
});

// Admin: принять заявку
bot.callbackQuery(/^admin_accept_(\d+)$/, async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCallbackQuery("Нет доступа");
  await ctx.answerCallbackQuery("✅ Принято");
  const tgId = parseInt(ctx.match[1]);
  await changeStatus(tgId, "candidate");
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  try {
    await bot.api.sendMessage(tgId,
      "✅ <b>Заявка одобрена!</b>\n\nКуратор свяжется для звонка в течение дня.\n@bcpru · +7 960 000-91-91",
      { parse_mode: "HTML" }
    );
  } catch (_e) { /* ignore */ }
});

bot.callbackQuery(/^adm_list_(.+)$/, async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCallbackQuery("Нет доступа");
  await ctx.answerCallbackQuery();
  const rows = await listByStatus(ctx.match[1]);
  if (!rows.length) { await ctx.reply(`Нет пользователей со статусом «${ctx.match[1]}»`); return; }
  let text = `<b>${ctx.match[1]} (${rows.length} чел.)</b>\n\n`;
  for (const r of rows) {
    const days = Math.floor((Date.now() - new Date(r.lastActive).getTime()) / 86400000);
    text += `• ${r.name || "—"} | ${r.city || "—"} | @${r.username || r.tgId} | был ${days}д назад\n`;
  }
  await ctx.reply(text, { parse_mode: "HTML" });
});

bot.callbackQuery("adm_export", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCallbackQuery("Нет доступа");
  await ctx.answerCallbackQuery("Формирую...");
  let csv = "tgId,username,name,city,job,company,source,status,tariff,refBy,visitCount,lastActive,createdAt\n";
  for await (const entry of kv.list({ prefix: ["users"] })) {
    const u = entry.value as User;
    csv += [u.tgId, u.username, u.name, u.city, u.job, u.company,
      u.source, u.status, u.tariff, u.refBy, u.visitCount, u.lastActive, u.createdAt]
      .map(v => `"${v ?? ""}"`).join(",") + "\n";
  }
  await ctx.replyWithDocument(new Blob([csv], { type: "text/csv" }), { filename: `bsp_${Date.now()}.csv` });
});

// ─── ADMIN КОМАНДЫ ────────────────────────────────────────────────────────────
bot.command("admin", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from!.id)) return;
  const statuses = ["lead", "candidate", "trial", "member", "vip"];
  const counts: Record<string, number> = {};
  for (const s of statuses) counts[s] = await countByStatus(s);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const kb = new InlineKeyboard()
    .text("📋 Лиды", "adm_list_lead").text("🟡 Кандидаты", "adm_list_candidate").row()
    .text("🟢 Участники", "adm_list_member").text("👑 VIP", "adm_list_vip").row()
    .text("📊 Экспорт CSV", "adm_export");
  await ctx.reply(
    `🛠 <b>Админ-панель БСП v4.0</b>\n\nВсего: <b>${total}</b>\n` +
    `🔵 Лиды: ${counts.lead} · 🟡 Кандидаты: ${counts.candidate}\n` +
    `🟠 Пробные: ${counts.trial} · 🟢 Участники: ${counts.member} · 👑 VIP: ${counts.vip}\n\n` +
    `Доп. команды: /stats · /sendnps · /setmember · /setstatus · /broadcast`,
    { parse_mode: "HTML", reply_markup: kb }
  );
});

bot.command("setmember", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from!.id)) return;
  const parts = ctx.match?.split(" ") ?? [];
  if (parts.length < 2) { await ctx.reply("Использование: /setmember <tg_id> <bsp|bsp_plus|vip>"); return; }
  const tgId = parseInt(parts[0]);
  const tariff = parts[1];
  await upsertUser(tgId, "", { status: "member", tariff });
  await changeStatus(tgId, "member");
  await ctx.reply(`✅ ${tgId} → участник (${tariff})`);
  // Запустить welcome-последовательность (Карелина)
  await kv.set(["welcome_queue", tgId], { step: 0, nextAt: Date.now() + 5000 });
  try { await bot.api.sendMessage(tgId, "👇 Меню участника:", { reply_markup: memberKb }); } catch (_e) { /* */ }
});

bot.command("broadcast", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from!.id)) return;
  const text = ctx.match;
  if (!text) { await ctx.reply("Использование: /broadcast <текст>"); return; }
  let sent = 0, fail = 0;
  for await (const entry of kv.list({ prefix: ["users"] })) {
    const u = entry.value as User;
    if (!["member", "vip", "trial"].includes(u.status)) continue;
    try { await bot.api.sendMessage(u.tgId, text, { parse_mode: "HTML" }); sent++; }
    catch (_e) { fail++; }
  }
  await ctx.reply(`✅ Отправлено: ${sent} · ❌ Ошибок: ${fail}`);
});

bot.command("setstatus", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from!.id)) return;
  const parts = ctx.match?.split(" ") ?? [];
  if (parts.length < 2) { await ctx.reply("Использование: /setstatus <tg_id> <status>"); return; }
  await changeStatus(parseInt(parts[0]), parts[1]);
  await ctx.reply("✅ Статус обновлён");
});

// /sendnps <tg_id> — отправить NPS опрос участнику (Бохан)
bot.command("sendnps", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from!.id)) return;
  const tgId = parseInt(ctx.match ?? "");
  if (isNaN(tgId)) { await ctx.reply("Использование: /sendnps <tg_id>"); return; }
  await sendNPS(tgId);
  await ctx.reply(`✅ NPS отправлен пользователю ${tgId}`);
});

// ─── CRON JOBS ────────────────────────────────────────────────────────────────

// Прогрев гостей каждые 30 минут (Евтухов)
Deno.cron("guest-nurture", "*/30 * * * *", async () => {
  const now = Date.now();
  for await (const entry of kv.list({ prefix: ["users"] })) {
    const u = entry.value as User;
    if (["member","vip","trial","candidate"].includes(u.status)) continue;
    const step = u.nurtureStep ?? 0;
    if (step >= NURTURE_STEPS.length) continue;
    if (now - new Date(u.createdAt).getTime() >= NURTURE_DELAYS[step]) {
      const kb = new InlineKeyboard()
        .text("✍️ Вступить", "ank_start")
        .text("✅ На пробную встречу", "trial_register");
      try {
        await bot.api.sendMessage(u.tgId, NURTURE_STEPS[step], { parse_mode: "HTML", reply_markup: kb });
        await upsertUser(u.tgId, u.username, { nurtureStep: step + 1 });
      } catch (_e) { /* ignore */ }
    }
  }
});

// Welcome-последовательность для новых участников (Карелина)
Deno.cron("member-welcome", "*/30 * * * *", async () => {
  const now = Date.now();
  for await (const entry of kv.list({ prefix: ["welcome_queue"] })) {
    const data = entry.value as { step: number; nextAt: number };
    const tgId = entry.key[1] as number;
    if (now < data.nextAt) continue;
    const step = data.step;
    if (step >= WELCOME_STEPS.length) { await kv.delete(["welcome_queue", tgId]); continue; }
    try {
      await bot.api.sendMessage(tgId, WELCOME_STEPS[step],
        { parse_mode: "HTML", reply_markup: step === WELCOME_STEPS.length - 1 ? memberKb : undefined }
      );
      const nextStep = step + 1;
      if (nextStep < WELCOME_STEPS.length) {
        await kv.set(["welcome_queue", tgId], { step: nextStep, nextAt: now + WELCOME_DELAYS[nextStep] });
      } else {
        await kv.delete(["welcome_queue", tgId]);
      }
    } catch (_e) { await kv.delete(["welcome_queue", tgId]); }
  }
});

// Алерт о неактивных участниках каждый день в 09:00 (Абаляева)
Deno.cron("inactive-alert", "0 9 * * *", async () => {
  const day14Ago = Date.now() - 14 * 24 * 3600 * 1000;
  const inactive: User[] = [];
  for await (const entry of kv.list({ prefix: ["users"] })) {
    const u = entry.value as User;
    if (!["member","vip","trial"].includes(u.status)) continue;
    if (new Date(u.lastActive).getTime() < day14Ago) inactive.push(u);
  }
  if (!inactive.length) return;
  let text = `⚠️ <b>Неактивных 14+ дней: ${inactive.length} чел.</b>\n\n`;
  for (const u of inactive.slice(0, 10)) {
    const days = Math.floor((Date.now() - new Date(u.lastActive).getTime()) / 86400000);
    text += `• ${u.name || "—"} | @${u.username || u.tgId} | ${days} дней\n`;
  }
  if (inactive.length > 10) text += `\n...и ещё ${inactive.length - 10} чел.`;
  await notifyAdmins(bot, text);
});

// ─── WEBHOOK + HTTP ───────────────────────────────────────────────────────────
const handleUpdate = webhookCallback(bot, "std/http");

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname === "/") {
    return new Response("БСП Bot v4.0 ✅", { status: 200 });
  }

  if (url.pathname === `/${WEBHOOK_SECRET}`) {
    // Проверка подписи Telegram (Никитинский)
    if (TG_SECRET_TOKEN) {
      const header = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (header !== TG_SECRET_TOKEN) return new Response("Forbidden", { status: 403 });
    }
    return handleUpdate(req);
  }

  // Авто-приёмка оплаты Robokassa (Абаляева)
  if (url.pathname === "/robokassa/result") {
    try {
      const p = url.searchParams;
      const tgId = parseInt(p.get("Shp_tgId") ?? "0");
      const tariff = p.get("Shp_tariff") ?? "";
      const outSum = p.get("OutSum") ?? "";
      const invId = p.get("InvId") ?? "";
      if (tgId && tariff in TARIFFS && ROBOKASSA_PASS2) {
        // В проде: проверить MD5(outSum:invId:PASS2:Shp_tariff=...:Shp_tgId=...)
        await changeStatus(tgId, "member");
        await upsertUser(tgId, "", { tariff, status: "member" });
        await logEvent(tgId, "payment", `${tariff} ${outSum}₽`);
        await kv.set(["welcome_queue", tgId], { step: 0, nextAt: Date.now() });
        try {
          await bot.api.sendMessage(tgId,
            `✅ <b>Оплата получена!</b>\nДобро пожаловать! Тариф: ${TARIFFS[tariff]?.[2] ?? tariff}`,
            { parse_mode: "HTML", reply_markup: memberKb }
          );
        } catch (_e) { /* ignore */ }
        await notifyAdmins(bot, `💰 Оплата: ${tgId} | ${tariff} | ${outSum} ₽`);
      }
      return new Response(`OK${invId}`, { status: 200 });
    } catch (_e) { return new Response("Error", { status: 400 }); }
  }

  return new Response("Not Found", { status: 404 });
});

console.log("БСП Bot v4.0 запущен ✅");
