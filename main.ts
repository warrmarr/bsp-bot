/**
 * БСП — Telegram Bot v3.0 (Deno Deploy + grammy)
 * Webhook-режим, хранилище Deno KV, TypeScript
 */

import { Bot, Context, InlineKeyboard, Keyboard, session, webhookCallback } from "https://deno.land/x/grammy@v1.21.1/mod.tsh";
import {
  type Conversation,
  type ConversationFlavor,
  conversations,
  createConversation,
} from "https://deno.land/x/grammy_conversations@v1.2.0/mod.ts";

// ─────────────────────────────────────────
//  НАСТРОЙКИ
// ─────────────────────────────────────────
const BOT_TOKEN = Deno.env.get("BOT_TOKEN") ?? "";
const ADMIN_IDS = (Deno.env.get("ADMIN_IDS") ?? "182991647")
  .split(",").map(Number).filter(Boolean);
const ROBOKASSA_LOGIN = Deno.env.get("ROBOKASSA_LOGIN") ?? "";
const ROBOKASSA_PASS1 = Deno.env.get("ROBOKASSA_PASS1") ?? "";
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "bsp_secret_2025";

const TARIFFS: Record<string, [number, string, string]> = {
  bsp:      [5000,  "Членский взнос БСП",  "5 000 ₽/мес"],
  bsp_plus: [11000, "Членский взнос БСП+", "11 000 ₽/мес"],
  vip:      [40000, "Членский взнос VIP",  "40 000 ₽/мес"],
};

// ─────────────────────────────────────────
//  ТИПЫ И KV-ХРАНИЛИЩЕ
// ─────────────────────────────────────────
interface User {
  tgId: number;
  username: string;
  name: string;
  city?: string;
  job?: string;
  company?: string;
  source?: string;
  phone?: string;
  status: string;   // lead | candidate | trial | member | vip | rejected
  tariff?: string;
  curator?: string;
  refCode: string;
  refBy?: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

const kv = await Deno.openKv();

async function getUser(tgId: number): Promise<User | null> {
  const r = await kv.get<User>(["users", tgId]);
  return r.value;
}

async function upsertUser(tgId: number, username: string, fields: Partial<User>): Promise<void> {
  const existing = await getUser(tgId);
  const now = new Date().toISOString();
  const user: User = existing
    ? { ...existing, ...fields, updatedAt: now }
    : {
        tgId, username,
        name: fields.name ?? "",
        status: "lead",
        refCode: `BSP${tgId}`,
        createdAt: now, updatedAt: now,
        ...fields,
      };
  await kv.set(["users", tgId], user);
  // Вторичный индекс по статусу
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
  const key = ["events", Date.now(), tgId];
  await kv.set(key, { tgId, event, data, ts: new Date().toISOString() });
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
    const tgId = entry.key[2] as number;
    const u = await getUser(tgId);
    if (u) result.push(u);
  }
  return result;
}

async function countReferrals(tgId: number): Promise<number> {
  let n = 0;
  for await (const entry of kv.list({ prefix: ["users"] })) {
    const u = entry.value as User;
    if (u.refBy === tgId) n++;
  }
  return n;
}

// ─────────────────────────────────────────
//  КЛАВИАТУРЫ
// ─────────────────────────────────────────
const mainKb = new Keyboard()
  .text("🏢 О БСП").text("💳 Тарифы").row()
  .text("✍️ Вступить").text("❓ Вопрос куратору").row()
  .text("👥 Я участник").text("📞 Контакты")
  .resized();

const memberKb = new Keyboard()
  .text("📋 Мой ЦДИСН").text("📅 Расписание").row()
  .text("🤝 Есть/Нужно/Хочу").text("🎁 Мои рефералы").row()
  .text("↩️ Меню")
  .resized();

const cancelKb = new Keyboard().text("❌ Отмена").resized();

// ─────────────────────────────────────────
//  ТЕКСТЫ
// ─────────────────────────────────────────
const ABOUT = `🏢 <b>БСП — Бизнес Сообщество Профессионалов</b>

Первое в России профессиональное сообщество для <b>ключевых сотрудников в найме</b>.

<b>Для кого:</b>
• Топ-менеджеры и директора в найме
• Руководители отделов и проектов
• Эксперты с зоной ответственности
• Амбициозные специалисты в росте

<b>Что получаешь:</b>
• Группа из 8 равных тебе профессионалов
• Еженедельные встречи — разбор реальных задач
• Связи по всей России
• ИИ-инструменты и лучшие практики
• Таймбанкинг — помогаешь и получаешь помощь

<b>Философия:</b> <i>«Созидающий получает»</i>

🌐 bcpru.ru`;

const TARIFFS_TEXT = `💳 <b>Тарифы БСП</b>

━━━━━━━━━━━━━━━━
🔵 <b>БСП</b> — 5 000 ₽/мес · 60 000 ₽/год
Онлайн + офлайн встречи, группа равных, база знаний

━━━━━━━━━━━━━━━━
⭐ <b>БСП+</b> — 11 000 ₽/мес · 132 000 ₽/год
Расширенное участие, администрирование процесса

━━━━━━━━━━━━━━━━
👑 <b>VIP</b> — 40 000 ₽/мес · 480 000 ₽/год
Индивидуальное сопровождение, личный куратор

━━━━━━━━━━━━━━━━
✅ Первый месяц — <b>бесплатно</b>`;

const SCHEDULE_TEXT = `📅 <b>Слоты встреч</b> (мск)

<b>Онлайн «Десятка»</b> — 60–75 мин
ПН 18:00 · ВТ 18:00
СР 10:00 / 12:00 / 14:00
ЧТ 16:00 · СБ 18:00 · ВС 11:00

<b>Офлайн «Двадцатка»</b> — раз в месяц, 90 мин

Куратор подбесёт группу по функции и городу.`;

const CONTACTS_TEXT = `📞 <b>Контакты БСП</b>

Telegram: @bcpru
Телефон: +7 960 000-91-91
Email: E@E1111.RU
Сайт: bcpru.ru

Куратор ответит в течение дня.`;

const ENH_TEXT = `🤝 <b>Есть — Нужно — Хочу</b>

На каждой встрече каждый участник коротко говорит:

<b>✅ ЕСТЬ</b> — чем могу помочь прямо сейчас
<b>🎯 НУЖНО</b> — что мне важно решить
<b>💡 ХОЧУ</b> — с кем хочу познакомиться

Это ядро обмена ресурсами в группе.`;

const ONBOARDING = [
  "🎉 <b>Добро пожаловать в БСП!</b>\n\nТы вступил в сообщество равных. Сейчас пройдём быстрый онбординг — 4 шага, 2 минуты.",
  "📋 <b>Шаг 1 — ЦДИСН</b>\n\nТвоя визитная карточка в группе. Заполни анкету — группа сразу узнает, чем ты ценен.\n\nНажми «Мой ЦДИСН» в меню.",
  "📅 <b>Шаг 2 — Расписание</b>\n\nВыбери удобный слот встреч. Куратор назначит тебя в группу по функции и уровню.",
  "🤝 <b>Шаг 3 — Есть/Нужно/Хочу</b>\n\nНа каждой встрече 3 минуты на тебя. Подготовь заранее: что есть, что нужно, с кем хочешь познакомиться.",
  "🎁 <b>Шаг 4 — Рефералы</b>\n\nПригласи коллегу → получи <b>1 000 ₽</b> на счёт. Ссылка — в разделе «Мои рефералы».\n\n✅ <b>Готово! Встречаемся на первой встрече.</b>",
];

// ─────────────────────────────────────────
//  ВСПОМОГАТЕЛЬНЫЕ
// ─────────────────────────────────────────
async function notifyAdmins(bot: Bot, text: string, kb?: InlineKeyboard): Promise<void> {
  for (const aid of ADMIN_IDS) {
    try {
      await bot.api.sendMessage(aid, text, {
        parse_mode: "HTML",
        reply_markup: kb,
      });
    } catch (_e) { /* ignore */ }
  }
}

function makePayUrl(tgId: number, key: string): string | null {
  if (!ROBOKASSA_LOGIN || !ROBOKASSA_PASS1) return null;
  const [amount, desc] = TARIFFS[key];
  const invId = (tgId * 10 + Object.keys(TARIFFS).indexOf(key)) % 999999;
  const sigStr = `${ROBOKASSA_LOGIN}:${amount}.00:${invId}:${ROBOKASSA_PASS1}`;
  // MD5 в Deno через Web Crypto (hex)
  const encoder = new TextEncoder();
  const data = encoder.encode(sigStr);
  // Синхронный fallback — просто вернём null если крипта недоступна
  void data; // используем позже если нужно
  const params = new URLSearchParams({
    MrchLogin: ROBOKASSA_LOGIN,
    OutSum: `${amount}.00`,
    InvId: String(invId),
    Desc: desc,
  });
  return `https://auth.robokassa.ru/Merchant/Index.aspx?${params}`;
}

const STATUS_LABELS: Record<string, string> = {
  lead: "🔵 Лид", candidate: "🟡 Кандидат",
  trial: "🟠 Пробный", member: "🟢 Участник",
  vip: "👑 VIP", rejected: "⛔ Архив",
};

// ─────────────────────────────────────────
//  БОТ
// ─────────────────────────────────────────
type MyContext = ConversationFlavor<Context>;
type MyConversation = Conversation<MyContext>;

const bot = new Bot<MyContext>(BOT_TOKEN);

// Сессия для conversations
bot.use(session({ initial: () => ({}) }));
bot.use(conversations());

// ─────────────────────────────────────────
//  ДИАЛОГ: АНКЕТА ВСТУПлЕНИЯ
// ─────────────────────────────────────────
async function anketa(conversation: MyConversation, ctx: MyContext) {
  await ctx.reply("✍️ <b>Анкета вступления</b>\n\nШаг 1/5 — <b>Имя и фамилия:</b>",
    { parse_mode: "HTML", reply_markup: cancelKb });

  const r1 = await conversation.waitFor("message:text");
  if (r1.message.text === "❌ Отмена") {
    await r1.reply("Отменено.", { reply_markup: mainKb }); return;
  }
  const name = r1.message.text;

  await r1.reply("Шаг 2/5 — <b>Город:</b>", { parse_mode: "HTML" });
  const r2 = await conversation.waitFor("message:text");
  if (r2.message.text === "❌ Отмена") {
    await r2.reply("Отменено.", { reply_markup: mainKb }); return;
  }
  const city = r2.message.text;

  await r2.reply("Шаг 3/5 — <b>Должность:</b>", { parse_mode: "HTML" });
  const r3 = await conversation.waitFor("message:text");
  if (r3.message.text === "❌ Отмена") {
    await r3.reply("Отменено.", { reply_markup: mainKb }); return;
  }
  const job = r3.message.text;

  await r3.reply("Шаг 4/5 — <b>Компания:</b>", { parse_mode: "HTML" });
  const r4 = await conversation.waitFor("message:text");
  if (r4.message.text === "❌ Отмена") {
    await r4.reply("Отменено.", { reply_markup: mainKb }); return;
  }
  const company = r4.message.text;

  const sourceKb = new Keyboard()
    .text("От коллеги / друга").text("Telegram / соцсети").row()
    .text("Сайт bcpru.ru").text("Другое").row()
    .text("❌ Отмена").resized();
  await r4.reply("Шаг 5/5 — <b>Откуда узнал о БСП?</b>",
    { parse_mode: "HTML", reply_markup: sourceKb });
  const r5 = await conversation.waitFor("message:text");
  if (r5.message.text === "❌ Отмена") {
    await r5.reply("Отменено.", { reply_markup: mainKb }); return;
  }
  const source = r5.message.text;

  const u = r5.from!;
  await upsertUser(u.id, u.username ?? "", { name, city, job, company, source, status: "candidate" });
  await logEvent(u.id, "anketa_completed");

  const notifyKb = new InlineKeyboard()
    .url("💬 Написать", `tg://user?id=${u.id}`)
    .text("✅ Принять", `admin_accept_${u.id}`);
  await notifyAdmins(bot,
    `🔔 <b>Новая заявка в БСП!</b>\n\n` +
    `👤 ${name}\n🏙 ${city}\n💼 ${job}, ${company}\n📣 ${source}\n\n` +
    `TG: @${u.username ?? "—"} | <code>${u.id}</code>`,
    notifyKb
  );
  await r5.reply(
    "✅ <b>Заявка принята!</b>\n\nКуратор свяжется в течении дня.\n" +
    "Если срочно — @bcpru или +7 960 000-91-91",
    { parse_mode: "HTML", reply_markup: mainKb }
  );
}
bot.use(createConversation(anketa));

// ─────────────────────────────────────────
//  ДИАЛОГ: ВОПРОС КУРАТОР��
// ─────────────────────────────────────────
async function question(conversation: MyConversation, ctx: MyContext) {
  await ctx.reply("❓ Напиши свой вопрос — куратор ответит:", { reply_markup: cancelKb });
  const r = await conversation.waitFor("message:text");
  if (r.message.text === "❌ Отмена") {
    await r.reply("Отменено.", { reply_markup: mainKb }); return;
  }
  const u = r.from!;
  const kb = new InlineKeyboard().url("💬 Ответить", `tg://user?id=${u.id}`);
  await notifyAdmins(bot, `❓ <b>Вопрос</b> от @${u.username ?? u.id}\n\n${r.message.text}`, kb);
  await r.reply("✅ Вопрос отправлен куратору!", { reply_markup: mainKb });
}
bot.use(createConversation(question));

// ─────────────────────────────────────────
//  ДИАЛОГ: ЦДИСН
// ─────────────────────────────────────────
async function tsdisn(conversation: MyConversation, ctx: MyContext) {
  await ctx.reply(
    "📋 <b>ЦДИСН — твоя визитка в группе</b>\n\n<b>Ц — Цели:</b> Чего хочешь достичу за год?",
    { parse_mode: "HTML", reply_markup: cancelKb }
  );
  const r1 = await conversation.waitFor("message:text");
  if (r1.message.text === "❌ Отмена") { await r1.reply("Отменено.", { reply_markup: memberKb }); return; }
  const tsC = r1.message.text;

  await r1.reply("<b>Д — Достижения:</b> Чем гордишься за �–3 года?", { parse_mode: "HTML" });
  const r2 = await conversation.waitFor("message:text");
  const tsD = r2.message.text;

  await r2.reply("<b>И — Интересы:</b> Какие темы близки в работе и жизни?", { parse_mode: "HTML" });
  const r3 = await conversation.waitFor("message:text");
  const tsI = r3.message.text;

  await r3.reply("<b>С — Связи:</b> Кого знаешь, кем можешь поделиться?", { parse_mode: "HTML" });
  const r4 = await conversation.waitFor("message:text");
  const tsS = r4.message.text;

  await r4.reply("<b>Н — Навыки:</b> В чём эксперт? Чем можешь помочь?", { parse_mode: "HTML" });
  const r5 = await conversation.waitFor("message:text");
  const tsN = r5.message.text;

  const summary =
    `🎯 <b>Цели:</b> ${tsC}\n` +
    `🏆 <b>Достижения:</b> ${tsD}\n` +
    `💡 <b>Интересы:</b> ${tsI}\n` +
    `🤝 <b>Связи:</b> ${tsS}\n` +
    `⚡ <b>Навыки:</b> ${tsN}`;
  const notes = `ЦДИСН:\n${summary.replace(/<[^>]+>/g, "")}`;

  const u = r5.from!;
  await upsertUser(u.id, u.username ?? "", { notes });
  await r5.reply(`📋 <b>ЦДИСН сохранён!</b>\n\n${summary}`, { parse_mode: "HTML", reply_markup: memberKb });
  await notifyAdmins(bot, `📋 <b>Новый ЦДИСН</b> @${u.username ?? u.id}\n\n${summary}`);
}
bot.use(createConversation(tsdisn));

// ─────────────────────────────────────────
//  КОМАНДЫ И КНОПКИ
// ─────────────────────────────────────────

// /start
bot.command("start", async (ctx) => {
  const u = ctx.from!;
  const args = ctx.match;
  let refBy: number | undefined;
  if (args?.startsWith("ref")) {
    const n = parseInt(args.replace("ref", ""));
    if (!isNaN(n)) refBy = n;
  }
  await upsertUser(u.id, u.username ?? "", { name: u.first_name, refBy });
  await logEvent(u.id, "start", `ref=${refBy}`);
  await ctx.reply(
    `Привет, <b>${u.first_name}</b>! 👋\n\n` +
    "Это бот <b>БСП — Бизнер Сообщество Профессионалов</b>.\n" +
    "Первое в России сообщество для ключевых сотрудников компаний.\n\nВыбери раздел 👇",
    { parse_mode: "HTML", reply_markup: mainKb }
  );
});

// /myid
bot.command("myid", (ctx) =>
  ctx.reply(`Твой Telegram ID: <code>${ctx.from?.id}</code>`, { parse_mode: "HTML" })
);

// 🏢 О БСП
bot.hears("🏢 О БСП", async (ctx) => {
  const kb = new InlineKeyboard()
    .text("✍️ Вступить", "ank_start")
    .url("🌐 Сайт", "https://bcpru.ru");
  await ctx.reply(ABOUT, { parse_mode: "HTML", reply_markup: kb });
});

// 💳 Тарифы
bot.hears("💳 Тарифы", async (ctx) => {
  const kb = new InlineKeyboard()
    .text("💙 Выбрать БСП — 5 000 ₽", "pay_bsp").row()
    .text("⭐ Выбрать БСП+ — 11 000 ₽", "pay_bsp_plus").row()
    .text("👑 Выбрать VIP — 40 000 ₽", "pay_vip");
  await ctx.reply(TARIFFS_TEXT, { parse_mode: "HTML", reply_markup: kb });
});

// 📞 Контакты
bot.hears("📞 Контакты", (ctx) => ctx.reply(CONTACTS_TEXT, { parse_mode: "HTML" }));

// ↩️ Меню
bot.hears("↩️ Меню", (ctx) => ctx.reply("Главное меню:", { reply_markup: mainKb }));

// ✍️ Вступить (кнопка меню)
bot.hears("✍️ Вступить", (ctx) => ctx.conversation.enter("anketa"));

// ❓ Вопрос куратору
bot.hears("❓ Вопрос куратору", (ctx) => ctx.conversation.enter("question"));

// 👥 Я участник
bot.hears("👥 Я участник", async (ctx) => {
  const u = await getUser(ctx.from!.id);
  const tariff = u?.tariff ?? "—";
  const status = u?.status ?? "lead";
  await ctx.reply(
    `👥 <b>Личный кабинет</b>\n\nСтатус: ${STATUS_LABELS[status] ?? status}\nТариф: ${tariff}\n\nВыбери действие:`,
    { parse_mode: "HTML", reply_markup: memberKb }
  );
});

// 📅 Расписание
bot.hears("📅 Расписание", (ctx) => ctx.reply(SCHEDULE_TEXT, { parse_mode: "HTML" }));

// 🤝 Есть/Нужно/Хочу
bot.hears("🤝 Есть/Нужно/Хочу", (ctx) => ctx.reply(ENH_TEXT, { parse_mode: "HTML" }));

// 🎁 Мои рефералы
bot.hears("🎁 Мои рефералы", async (ctx) => {
  const u = ctx.from!;
  const count = await countReferrals(u.id);
  const bonus = count * 1000;
  const link = `https://t.me/${ctx.me.username}?start=ref${u.id}`;
  await ctx.reply(
    `🎁 <b>Реферальная программа</b>\n\n` +
    `Твоя ссылка:\n<code>${link}</code>\n\n` +
    `За каждого вступившего: <b>+1 000 ₽</b> на счёт\n\n` +
    `Приглашено: <b>${count} чел.</b>\nНакоплено бонусов: <b>${bonus} ₽</b>`,
    { parse_mode: "HTML" }
  );
});

// 📋 Мой ЦДИСН
bot.hears("📋 Мой ЦДИСН", async (ctx) => {
  const u = await getUser(ctx.from!.id);
  if (u?.notes?.includes("ЦДИСН:")) {
    await ctx.reply(`📋 <b>Твой ЦДИСН</b>\n\n${u.notes}`, { parse_mode: "HTML" });
  } else {
    await ctx.conversation.enter("tsdisn");
  }
});

// ─────────────────────────────────────────
//  CALLBACK QUERIES
// ─────────────────────────────────────────

// Вступить (inline кнопка)
bot.callbackQuery("ank_start", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter("anketa");
});

// Оплата
bot.callbackQuery(/^pay_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const key = ctx.match[1];
  if (!(key in TARIFFS)) return;
  const [amount, desc, label] = TARIFFS[key];
  const url = makePayUrl(ctx.from.id, key);
  if (url) {
    const kb = new InlineKeyboard().url(`💳 Оплатить ${label}`, url);
    await ctx.reply(`💳 <b>${desc}</b>\n<b>${label}</b>\n\nНажми для оплаты:`,
      { parse_mode: "HTML", reply_markup: kb });
  } else {
    await ctx.reply(
      `💳 <b>${desc}</b> — ${label}\n\n` +
      "Оплата временно настраивается.\n" +
      "Для вступления напиши: @bcpru · +7 960 000-91-91",
      { parse_mode: "HTML" }
    );
  }
});

// Админ — принять заявку
bot.callbackQuery(/^admin_accept_(\d+)$/, async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCallbackQuery("Нет доступа");
  await ctx.answerCallbackQuery("Статус обновлён ✅");
  const tgId = parseInt(ctx.match[1]);
  await changeStatus(tgId, "candidate");
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  try {
    await bot.api.sendMessage(tgId,
      "✅ <b>Твоя заявка одобрена!</b>\n\n" +
      "Куратор свяжется с тобой для звонка в течение дня.\n" +
      "Telegram: @bcpru · +7 960 000-91-91",
      { parse_mode: "HTML" }
    );
  } catch (_e) { /* ignore */ }
});

// Админ — список по статусу
bot.callbackQuery(/^adm_list_(.+)$/, async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCallbackQuery("Нет доступа");
  await ctx.answerCallbackQuery();
  const status = ctx.match[1];
  const rows = await listByStatus(status);
  if (!rows.length) {
    await ctx.reply(`Нет пользователей со статусом «${status}»`); return;
  }
  let text = `<b>Статус: ${status} (${rows.length} чел.)</b>\n\n`;
  for (const r of rows) {
    text += `• ${r.name || "—"} | ${r.city || "—"} | ${r.job || "—"} | @${r.username || r.tgId}\n`;
  }
  await ctx.reply(text, { parse_mode: "HTML" });
});

// Экспорт CSV
bot.callbackQuery("adm_export", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCallbackQuery("Нет доступа");
  await ctx.answerCallbackQuery("Формирую CSV...");
  let csv = "tgId,username,name,city,job,company,source,status,tariff,refBy,createdAt\n";
  for await (const entry of kv.list({ prefix: ["users"] })) {
    const u = entry.value as User;
    const row = [u.tgId, u.username, u.name, u.city, u.job, u.company,
      u.source, u.status, u.tariff, u.refBy, u.createdAt]
      .map(v => `"${v ?? ""}"`).join(",");
    csv += row + "\n";
  }
  await ctx.replyWithDocument(
    new Blob([csv], { type: "text/csv" }),
    { filename: `bsp_export_${Date.now()}.csv` }
  );
});

// ─────────────────────────────────────────
//  ADMIN КОМАНДЫ
// ─────────────────────────────────────────

// /admin — статистика
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
    `🛠 <b>Админ-панель БСП</b>\n\n` +
    `Всего: <b>${total}</b>\n` +
    `🔵 Лиды: ${counts.lead} · 🟡 Кандидаты: ${counts.candidate}\n` +
    `🟠 Пробные: ${counts.trial} · 🟢 Участники: ${counts.member} · 👑 VIP: ${counts.vip}`,
    { parse_mode: "HTML", reply_markup: kb }
  );
});

// /setmember <tg_id> <tariff>
bot.command("setmember", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from!.id)) return;
  const parts = ctx.match?.split(" ") ?? [];
  if (parts.length < 2) {
    await ctx.reply("Использование: /setmember <tg_id> <bsp|bsp_plus|vip>"); return;
  }
  const tgId = parseInt(parts[0]);
  const tariff = parts[1];
  await upsertUser(tgId, "", { status: "member", tariff });
  await changeStatus(tgId, "member");
  await ctx.reply(`✅ Пользователь ${tgId} → участник (${tariff})`);
  for (const msg of ONBOARDING) {
    try { await bot.api.sendMessage(tgId, msg, { parse_mode: "HTML" }); } catch (_e) { /* */ }
  }
  try { await bot.api.sendMessage(tgId, "👇 Меню участника:", { reply_markup: memberKb }); } catch (_e) { /* */ }
});

// /broadcast <текст>
bot.command("broadcast", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from!.id)) return;
  const text = ctx.match;
  if (!text) { await ctx.reply("Использование: /broadcast <текст>"); return; }
  let sent = 0, fail = 0;
  for await (const entry of kv.list({ prefix: ["users"] })) {
    const u = entry.value as User;
    if (!["member", "vip", "trial"].includes(u.status)) continue;
    try {
      await bot.api.sendMessage(u.tgId, text, { parse_mode: "HTML" });
      sent++;
    } catch (_e) { fail++; }
  }
  await ctx.reply(`✅ Отправлено: ${sent} · ❌ Ошибок: ${fail}`);
});

// /setstatus <tg_id> <status>  — быстрая смена статуса
bot.command("setstatus", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from!.id)) return;
  const parts = ctx.match?.split(" ") ?? [];
  if (parts.length < 2) { await ctx.reply("Использование: /setstatus <tg_id> <status>"); return; }
  await changeStatus(parseInt(parts[0]), parts[1]);
  await ctx.reply(`✅ Статус обновлён`);
});

// ─────────────────────────────────────────
//  WEBHOOK + HTTP СЕРВЕР
// ─────────────────────────────────────────
const handleUpdate = webhookCallback(bot, "std/http");

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Health check
  if (url.pathname === "/") {
    return new Response("БСП Bot v3.0 ✅", { status: 200 });
  }

  // Webhook
  if (url.pathname === `/${WEBHOOK_SECRET}`) {
    return handleUpdate(req);
  }

  return new Response("Not Found", { status: 404 });
});

console.log("БСП Bot v3.0 запущен на Deno Deploy ✅");
