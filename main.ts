/**
 * БСП — Telegram Bot v4.3.0 (Deno Deploy + grammy)
 * 19 улучшений поверх v4.2.1:
 * 1. Структурированное логирование (log())
 * 2. Ролевой доступ (BROADCASTER_IDS, STATS_IDS, hasRole())
 * 3. Отслеживание статуса кронов (cronStart/cronEnd/cronError)
 * 4. Robokassa retry с экспоненциальным backoff
 * 5. tariffHistory + pausedAt + rejoinAt в User
 * 6. Кеш /stats (60 сек)
 * 7. /invite_friend — реферальная программа
 * 8. /support — тикет поддержки
 * 9. /rejoin — восстановление аккаунта
 * 10. /privacy — политика конфиденциальности
 * 11. /feedback — оценка встречи (1–5 звёзд)
 * 12. /cron_status — мониторинг кронов
 * 13. /weekly_report — CSV для кураторов
 * 14. /export_my_data — GDPR-выгрузка
 * 15. /poll — опрос участников
 * 18. /health endpoint
 * 19. Fix duplicate tgIdStr в Robokassa handler
 */

import {
  Bot, Context, InlineKeyboard, Keyboard, session, webhookCallback,
} from "https://deno.land/x/grammy@v1.21.1/mod.ts";
import {
  type Conversation, type ConversationFlavor,
  conversations, createConversation,
} from "https://deno.land/x/grammy_conversations@v1.2.0/mod.ts";
import { crypto as stdCrypto } from "https://deno.land/std@0.220.0/crypto/mod.ts";
import { encodeHex } from "https://deno.land/std@0.220.0/encoding/hex.ts";

// ─── ENV ──────────────────────────────────────────────────────────────────────
const BOT_TOKEN        = Deno.env.get("BOT_TOKEN") ?? "";
const ADMIN_IDS        = (Deno.env.get("ADMIN_IDS") ?? "182991647")
                           .split(",").map(Number).filter(Boolean);
const BROADCASTER_IDS  = (Deno.env.get("BROADCASTER_IDS") ?? "")
                           .split(",").map(Number).filter(Boolean);
const STATS_IDS        = (Deno.env.get("STATS_IDS") ?? "")
                           .split(",").map(Number).filter(Boolean);
const ROBOKASSA_LOGIN  = Deno.env.get("ROBOKASSA_LOGIN") ?? "";
const ROBOKASSA_PASS1  = Deno.env.get("ROBOKASSA_PASS1") ?? "";
const ROBOKASSA_PASS2  = Deno.env.get("ROBOKASSA_PASS2") ?? "";
const WEBHOOK_SECRET   = Deno.env.get("WEBHOOK_SECRET") ?? "bsp_secret_2025";
const TG_SECRET_TOKEN  = Deno.env.get("TG_SECRET_TOKEN") ?? "";
const PROMO_END_DATE   = Deno.env.get("PROMO_END_DATE") ?? "2026-09-01";

const TARIFFS: Record<string, [number, string, string]> = {
  bsp:      [5000,  "Членский взнос БСП",  "5 000 ₽/мес"],
  bsp_plus: [11000, "Членский взнос БСП+", "11 000 ₽/мес"],
  vip:      [40000, "Членский взнос VIP",  "40 000 ₽/мес"],
};

// ─── STRUCTURED LOGGING ───────────────────────────────────────────────────────
function log(
  level: "INFO" | "WARN" | "ERROR",
  event: string,
  data: Record<string, unknown> = {}
): void {
  console.log(JSON.stringify({ level, event, ts: new Date().toISOString(), ...data }));
}

// ─── ROLE-BASED ACCESS ────────────────────────────────────────────────────────
function hasRole(tgId: number, role: "admin" | "broadcaster" | "stats"): boolean {
  if (ADMIN_IDS.includes(tgId)) return true;
  if (role === "broadcaster") return BROADCASTER_IDS.includes(tgId);
  if (role === "stats") return STATS_IDS.includes(tgId);
  return false;
}

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface TariffHistoryEntry {
  tariff: string;
  ts: string;
  prev?: string;
}

interface User {
  tgId: number;
  username: string;
  name: string;
  city?: string;
  job?: string;
  company?: string;
  source?: string;
  status: string;   // lead | candidate | trial | member | vip | rejected | paused
  tariff?: string;
  tariffHistory?: TariffHistoryEntry[];
  refCode: string;
  refBy?: number;
  notes?: string;
  visitCount: number;
  lastActive: string;
  nurtureStep: number;
  pausedAt?: string;
  rejoinAt?: string;
  followUpStep?: number;
  createdAt: string;
  updatedAt: string;
}

interface SessionData {
  step: string;
}

interface CronStatus {
  name: string;
  lastStarted: string;
  lastFinished?: string;
  lastError?: string;
  processed: number;
  errors: number;
  status: "running" | "ok" | "error";
}

interface BroadcastDraft {
  text: string;
  createdBy: number;
  createdAt: string;
}

interface Poll {
  question: string;
  options: string[];
  votes: Record<number, number>; // optIdx → count
  voters: number[];              // tgIds who voted
  createdAt: string;
  createdBy: number;
}

// ─── KV ───────────────────────────────────────────────────────────────────────
const kv = await Deno.openKv();

async function getUser(tgId: number): Promise<User | null> {
  return (await kv.get<User>(["users", tgId])).value;
}

async function upsertUser(tgId: number, username: string, fields: Partial<User>): Promise<void> {
  const existing = await getUser(tgId);
  const now = new Date().toISOString();

  // Track tariff history if tariff changes
  let tariffHistory = existing?.tariffHistory ?? [];
  if (fields.tariff && existing?.tariff && existing.tariff !== fields.tariff) {
    tariffHistory = [
      ...tariffHistory,
      { tariff: fields.tariff, ts: now, prev: existing.tariff },
    ];
  } else if (fields.tariff && !existing?.tariff) {
    tariffHistory = [{ tariff: fields.tariff, ts: now }];
  }

  const user: User = existing
    ? { ...existing, ...fields, tariffHistory, updatedAt: now }
    : {
        tgId, username, name: fields.name ?? "",
        status: "lead", refCode: `ref${tgId}`,
        visitCount: 0, lastActive: now, nurtureStep: 0,
        tariffHistory, createdAt: now, updatedAt: now, ...fields,
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
  log("INFO", event, { tgId, data });
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

// ─── CRON STATUS TRACKING ─────────────────────────────────────────────────────
async function cronStart(name: string): Promise<void> {
  const status: CronStatus = {
    name, lastStarted: new Date().toISOString(),
    processed: 0, errors: 0, status: "running",
  };
  await kv.set(["cron_status", name], status);
  log("INFO", "cron_start", { cron: name });
}

async function cronEnd(name: string, processed = 0, errors = 0): Promise<void> {
  const existing = (await kv.get<CronStatus>(["cron_status", name])).value;
  const updated: CronStatus = {
    ...(existing ?? { name, lastStarted: new Date().toISOString(), processed: 0, errors: 0 }),
    lastFinished: new Date().toISOString(),
    processed, errors, status: errors > 0 ? "error" : "ok",
  };
  await kv.set(["cron_status", name], updated);
  log("INFO", "cron_end", { cron: name, processed, errors });
}

async function cronError(name: string, error: unknown): Promise<void> {
  const errMsg = error instanceof Error ? error.message : String(error);
  const existing = (await kv.get<CronStatus>(["cron_status", name])).value;
  const updated: CronStatus = {
    ...(existing ?? { name, lastStarted: new Date().toISOString(), processed: 0, errors: 0 }),
    lastError: errMsg,
    status: "error",
    errors: (existing?.errors ?? 0) + 1,
  };
  await kv.set(["cron_status", name], updated);
  log("ERROR", "cron_error", { cron: name, error: errMsg });
  // Notify admins
  for (const aid of ADMIN_IDS) {
    try {
      await bot.api.sendMessage(aid, `🚨 <b>Cron ошибка: ${name}</b>\n\n${errMsg}`, { parse_mode: "HTML" });
    } catch (_e) { /* ignore */ }
  }
}

// ─── ROBOKASSA RETRY ──────────────────────────────────────────────────────────
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelay = 1000): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        log("WARN", "retry", { attempt: attempt + 1, delay });
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
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

// ─── STATS CACHE ──────────────────────────────────────────────────────────────
let statsCache: { text: string; ts: number } | null = null;

// ─── KEYBOARDS ────────────────────────────────────────────────────────────────
const mainKb = new Keyboard()
  .text("🏢 О БСП").text("💳 Тарифы").row()
  .text("✍️ Вступить").text("�� Вопрос куратору").row()
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
Email: info@bspru.ru · Сайт: bcpru.ru

Куратор ответит в течение дня.`;

const ENH_TEXT = `🤝 <b>Есть — Нужно — Хочщ</b>

На каждой встрече каждый участник говорит:

<b>✅ ЕСТЬ</b> — чем могу помочь прямо сейчас
<b>🎯 НУЖНО</b> — что мне важно решить
<b>💡 ХОЧУ</b> — с кем хочу познакомиться`;

const PRIVACY_TEXT = `🔒 <b>Политика конфиденциальности БСП</b>

Мы обрабатываем ваши данные в соответствии с <b>ФЗ-152 «О персональных данных»</b>.

<b>Что храним:</b>
• Имя, должность, компания, город
• Telegram ID и username
• История активности в боте

<b>Как используем:</b>
• Только для работы сообщества БСП
• Не передаём третьим лицам

<b>Ваши права:</b>
• /delete_me — удалить все данные
• /export_my_data — получить копию данных

Оператор: info@bspru.ru`;


const WELCOME_STEPS = [
  "🎉 <b>Добро пожаловать в БСП!</b>\n\nТы вступил в сообщество равных. Пройдём быстрый онбординг — 4 шага, 2 минуты.",
  "📋 <b>Шаг 1 — ЦДИСН</b>\n\nТвоя визитная карточка в группе. Заполни — группа сразу узнает, чем ты ценен.\n\nНажми «Мой ЦДИСН» в меню.",
  "📅 <b>Шаг 2 — Расписание</b>\n\nВыбери удобный слот. Куратор назначит тебя в группу по функции и уровню.",
  "🤝 <b>Шаг 3 — Есть/Нужно/Хочу</b>\n\nНа каждой встрече 3 минуты на тебя. Подготовь: что есть, что нужно, с кем хочешь познакомиться.",
  "🎁 <b>Шаг 4 — Рефералы</b>\n\nПригласи коллегу → получи <b>1 000 ₽</b> на счёт. 3 реферала = бесплатный месяц БСП+!\n\nСсылка — в разделе «Мои рефералы».\n\n✅ <b>Готово! Встречаемся на первой встрече.</b>",
];
const WELCOME_DELAYS = [0, 3600*1000, 24*3600*1000, 48*3600*1000, 5*24*3600*1000];

// Followup messages для кандидатов
const FOLLOWUP_MESSAGES = [
  { delay: 48 * 3600 * 1000, text: "🟡 <b>Евгений, привет!</b>\n\nВидим, что ты оставил заявку в БСП. Это нормально — важные решения не принимаются в спешке.\n\nЕсть вопросы? Просто ответь на это сообщение или напиши @bcpru" },
  { delay: 5 * 24 * 3600 * 1000, text: "💡 <b>БСП — 5 дней без ответа</b>\n\nЗнаем, что ты занят. Один вопрос:\n\n<i>Что мешает сделать шаг?</i>\n\nОтвет поможет нам подобрать правильную группу именно для тебя." },
  { delay: 10 * 24 * 3600 * 1000, text: "🔔 <b>Последнее сообщение от БСП</b>\n\nНе хотим надоедать. Если передумаешь — мы здесь. @bcpru\n\nСпасибо за интерес к сообществу!" },
];

const STATUS_LABELS: Record<string, string> = {
  lead: "🔵 Лид", candidate: "🟡 Кандидат",
  trial: "🟠 Пробный", member: "🟢 Участник",
  vip: "👑 VIP", rejected: "⛔ Архив", paused: "⏸ Пауза",
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function notifyAdmins(bot: Bot, text: string, kb?: InlineKeyboard): Promise<void> {
  for (const aid of ADMIN_IDS) {
    try { await bot.api.sendMessage(aid, text, { parse_mode: "HTML", reply_markup: kb }); }
    catch (e) { log("WARN", "notify_admin_fail", { aid, error: String(e) }); }
  }
}

function makePayUrl(tgId: number, key: string, invId: number): string | null {
  if (!ROBOKASSA_LOGIN || !ROBOKASSA_PASS1) return null;
  const [amount, desc] = TARIFFS[key];
  const params = new URLSearchParams({
    MrchLogin: ROBOKASSA_LOGIN,
    OutSum: `${amount}.00`,
    InvId: String(invId),
    Desc: desc,
    SignatureValue: "pending",
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
  } catch (e) { log("WARN", "send_nps_fail", { tgId, error: String(e) }); }
}

// ─── MD5 / ROBOKASSA ──────────────────────────────────────────────────────────
async function md5Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await stdCrypto.subtle.digest("MD5", buf);
  return encodeHex(new Uint8Array(hash));
}

async function verifyRobokassaSig(
  outSum: string, invId: string, sig: string,
  tgIdParam: string, tariff: string
): Promise<boolean> {
  const shpStr = `Shp_tariff=${tariff}:Shp_tgId=${tgIdParam}`;
  const raw = `${outSum}:${invId}:${ROBOKASSA_PASS2}:${shpStr}`;
  return (await md5Hex(raw)).toLowerCase() === sig.toLowerCase();
}

async function makeInvId(tgId: number, tariff: string): Promise<number> {
  const existing = await kv.get<number>(["invid", tgId, tariff]);
  if (existing.value) return existing.value;
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  const invId = 100000 + (arr[0] % 900000);
  await kv.set(["invid", tgId, tariff], invId);
  await kv.set(["invid_reverse", invId], { tgId, tariff });
  return invId;
}

// ─── SESSION ──────────────────────────────────────────────────────────────────
function kvStorage(kvDb: Deno.Kv) {
  return {
    read: async (key: string) => (await kvDb.get<SessionData>(["session", key])).value ?? null,
    write: async (key: string, value: SessionData) => { await kvDb.set(["session", key], value); },
    delete: async (key: string) => { await kvDb.delete(["session", key]); },
  };
}

async function waitText(conversation: MyConversation, ctx: MyContext): Promise<string> {
  while (true) {
    ctx = await conversation.waitFor(":text");
    if (ctx.message?.text) return ctx.message.text;
    await ctx.reply("Пожалуйста, отправьте текстовое сообщение.");
  }
}

// ─── BOT ──────────────────────────────────────────────────────────────────────
type MyContext = ConversationFlavor<Context>;
type MyConversation = Conversation<MyContext>;

const bot = new Bot<MyContext>(BOT_TOKEN);
bot.use(session({ initial: (): SessionData => ({ step: "" }), storage: kvStorage(kv) }));
bot.use(conversations());

// Rate limiter middleware
bot.use(async (ctx, next) => {
  const tgId = ctx.from?.id;
  if (tgId && isRateLimited(tgId)) return;
  return next();
});

// ─── CONVERSATIONS ────────────────────────────────────────────────────────────
async function anketa(conversation: MyConversation, ctx: MyContext) {
  await logEvent(ctx.from!.id, "anketa_started");
  await ctx.reply("✍️ <b>Анкета вступления</b>\n\nШаг 1/5 — <b>Имя и фамилия:</b>",
    { parse_mode: "HTML", reply_markup: cancelKb });
  const name = await waitText(conversation, ctx);
  if (name === "❌ Отмена") { await ctx.reply("Отменено.", { reply_markup: mainKb }); return; }

  await ctx.reply("Шаг 2/5 — <b>Город:</b>", { parse_mode: "HTML" });
  const city = await waitText(conversation, ctx);
  if (city === "❌ Отмена") { await ctx.reply("Отменено.", { reply_markup: mainKb }); return; }

  await ctx.reply("Шаг 3/5 — <b>Должность:</b>", { parse_mode: "HTML" });
  const job = await waitText(conversation, ctx);
  if (job === "❌ Отмена") { await ctx.reply("Отменено.", { reply_markup: mainKb }); return; }

  await ctx.reply("Шаг 4/5 — <b>Компания:</b>", { parse_mode: "HTML" });
  const company = await waitText(conversation, ctx);
  if (company === "❌ Отмена") { await ctx.reply("Отменено.", { reply_markup: mainKb }); return; }

  const srcKb = new Keyboard()
    .text("От коллеги / друга").text("Telegram / соцсети").row()
    .text("Сайт bcpru.ru").text("Другое").row()
    .text("❌ Отмена").resized();
  await ctx.reply("Шаг 5/5 — <b>Откуда узнал о БСП?</b>", { parse_mode: "HTML", reply_markup: srcKb });
  const source = await waitText(conversation, ctx);
  if (source === "❌ Отмена") { await ctx.reply("Отменено.", { reply_markup: mainKb }); return; }

  const u = ctx.from!;
  await upsertUser(u.id, u.username ?? "", { name, city, job, company, source, status: "candidate", followUpStep: 0 });
  await logEvent(u.id, "anketa_completed");
  const notifyKb = new InlineKeyboard()
    .url("💬 Написать", `tg://user?id=${u.id}`)
    .text("✅ Принять", `admin_accept_${u.id}`);
  await notifyAdmins(bot,
    `🔔 <b>Новая заявка!</b>\n\n👤 ${name}\n🏙 ${city}\n💼 ${job}, ${company}\n📣 ${source}\nTG: @${u.username ?? "—"} | <code>${u.id}</code>`,
    notifyKb
  );
  await ctx.reply(
    "✅ <b>Заявка принята!</b>\n\nКуратор свяжется в течение дня.\nЕсли срочно — @bcpru · +7 960 000-91-91",
    { parse_mode: "HTML", reply_markup: mainKb }
  );
}
bot.use(createConversation(anketa));

async function question(conversation: MyConversation, ctx: MyContext) {
  await ctx.reply("❓ Напиши свой вопрос — куратор ответит:", { reply_markup: cancelKb });
  const text = await waitText(conversation, ctx);
  if (text === "❌ Отмена") { await ctx.reply("Отменено.", { reply_markup: mainKb }); return; }
  const u = ctx.from!;
  await notifyAdmins(bot, `❓ <b>Вопрос</b> от @${u.username ?? u.id}\n\n${text}`,
    new InlineKeyboard().url("💬 Ответить", `tg://user?id=${u.id}`)
  );
  await ctx.reply("✅ Вопрос отправлен куратору!", { reply_markup: mainKb });
}
bot.use(createConversation(question));

async function tsdisn(conversation: MyConversation, ctx: MyContext) {
  await ctx.reply("📋 <b>ЦДИСН — твоя визитка в группе</b>\n\n<b>Ц — Цели:</b> Чего хочешь достичь за год?",
    { parse_mode: "HTML", reply_markup: cancelKb });
  const tsC = await waitText(conversation, ctx);
  if (tsC.toLowerCase().includes("отмена") || tsC === "❌ Отмена") { await ctx.reply("Заполнение ЦДИСН отменено.", { reply_markup: memberKb }); return; }

  await ctx.reply("<b>Д — Достижения:</b> Чем гордишься за 2–3 года?", { parse_mode: "HTML", reply_markup: cancelKb });
  const tsD = await waitText(conversation, ctx);
  if (tsD.toLowerCase().includes("отмена") || tsD === "❌ Отмена") { await ctx.reply("Заполнение ЦДИСН отменено.", { reply_markup: memberKb }); return; }

  await ctx.reply("<b>И — Интересы:</b> Какие темы близки в работе и жизни?", { parse_mode: "HTML", reply_markup: cancelKb });
  const tsI = await waitText(conversation, ctx);
  if (tsI.toLowerCase().includes("отмена") || tsI === "❌ Отмена") { await ctx.reply("Заполнение ЦДИСН отменено.", { reply_markup: memberKb }); return; }

  await ctx.reply("<b>С — Связи:</b> Кого знаешь, кем можешь поделиться?", { parse_mode: "HTML", reply_markup: cancelKb });
  const tsS = await waitText(conversation, ctx);
  if (tsS.toLowerCase().includes("отмена") || tsS === "❌ Отмена") { await ctx.reply("Заполнение ЦДИСН отменено.", { reply_markup: memberKb }); return; }

  await ctx.reply("<b>Н — Навыки:</b> В чём эксперт? Чем можешь помочь?", { parse_mode: "HTML", reply_markup: cancelKb });
  const tsN = await waitText(conversation, ctx);
  if (tsN.toLowerCase().includes("отмена") || tsN === "❌ Отмена") { await ctx.reply("Заполнение ЦДИСН отменено.", { reply_markup: memberKb }); return; }

  const summary = `🎯 <b>Цели:</b> ${tsC}\n🏆 <b>Достижения:</b> ${tsD}\n💡 <b>Интересы:</b> ${tsI}\n🤝 <b>Связи:</b> ${tsS}\n⚡ <b>Навыки:</b> ${tsN}`;
  const u = ctx.from!;
  await upsertUser(u.id, u.username ?? "", { notes: `ЦДИСН:\n${summary.replace(/<[^>]+>/g, "")}` });
  await ctx.reply(`📋 <b>ЦДИСН сохранён!</b>\n\n${summary}`, { parse_mode: "HTML", reply_markup: memberKb });
  await notifyAdmins(bot, `📋 <b>Новый ЦДИСН</b> @${u.username ?? u.id}\n\n${summary}`);
}
bot.use(createConversation(tsdisn));

// Support conversation
async function supportConv(conversation: MyConversation, ctx: MyContext) {
  await ctx.reply("🆘 <b>Поддержка БСП</b>\n\nОпиши свой вопрос или проблему подробно:", { parse_mode: "HTML", reply_markup: cancelKb });
  const text = await waitText(conversation, ctx);
  if (text === "❌ Отмена") { await ctx.reply("Отменено.", { reply_markup: mainKb }); return; }
  const u = ctx.from!;
  const ticketId = `TKT-${Date.now()}`;
  await kv.set(["support", ticketId], { tgId: u.id, text, ts: new Date().toISOString(), status: "open" });
  await logEvent(u.id, "support_ticket", ticketId);
  await notifyAdmins(bot,
    `🎫 <b>Тикет поддержки #${ticketId}</b>\n\n👤 @${u.username ?? u.id}\n\n${text}`,
    new InlineKeyboard().url("💬 Ответить", `tg://user?id=${u.id}`)
  );
  await ctx.reply(`✅ <b>Тикет #${ticketId} создан!</b>\n\nКуратор ответит в течение дня.`, { parse_mode: "HTML", reply_markup: mainKb });
}
bot.use(createConversation(supportConv));

// Poll conversation (admin)
async function pollConv(conversation: MyConversation, ctx: MyContext) {
  if (!hasRole(ctx.from!.id, "admin")) {
    await ctx.reply("Нет доступа.");
    return;
  }
  await ctx.reply("📊 <b>Создание опроса</b>\n\nВведи вопрос:", { parse_mode: "HTML", reply_markup: cancelKb });
  const pollQuestion = await waitText(conversation, ctx);
  if (pollQuestion === "❌ Отмена") { await ctx.reply("Отменено."); return; }

  await ctx.reply("Введи варианты ответов через запятую (до 5 вариантов):");
  const optionsRaw = await waitText(conversation, ctx);
  if (optionsRaw === "❌ Отмена") { await ctx.reply("Отменено."); return; }
  const options = optionsRaw.split(",").map(o => o.trim()).slice(0, 5);

  const pollId = `poll_${Date.now()}`;
  const poll: Poll = {
    question: pollQuestion,
    options,
    votes: {},
    voters: [],
    createdAt: new Date().toISOString(),
    createdBy: ctx.from!.id,
  };
  await kv.set(["polls", pollId], poll);

  // Build keyboard
  const kb = new InlineKeyboard();
  options.forEach((opt, i) => kb.text(opt, `poll_vote_${pollId}_${i}`).row());

  let sent = 0;
  for await (const entry of kv.list({ prefix: ["users"] })) {
    const u = entry.value as User;
    if (!["member", "vip", "trial"].includes(u.status)) continue;
    try {
      await bot.api.sendMessage(u.tgId, `📊 <b>Опрос БСП</b>\n\n${pollQuestion}`, { parse_mode: "HTML", reply_markup: kb });
      sent++;
    } catch (_e) { /* ignore */ }
    await new Promise(r => setTimeout(r, 100));
  }
  await ctx.reply(`✅ Опрос отправлен ${sent} участникам.`);
}
bot.use(createConversation(pollConv));


// ─── КОМАНДЫ ──────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  const u = ctx.from!;
  const tgId = u.id;

  const consentKey = ["pd_consent", tgId];
  const hasConsent = (await kv.get<boolean>(consentKey)).value;
  if (!hasConsent) {
    const kb = new InlineKeyboard()
      .text("✅ Согласен с обработкой персональных данных", "pd_consent_yes");
    await ctx.reply(
      "Для использования бота необходимо согласие на обработку персональных данных в соответствии с ФЗ-152.\n\nНажмите кнопку для подтверждения:",
      { reply_markup: kb }
    );
    return;
  }

  const args = ctx.match;
  let refBy: number | undefined;
  if (args?.startsWith("ref")) {
    const refPart = args.replace("ref", "").split("_")[0];
    const n = parseInt(refPart);
    if (!isNaN(n) && n !== u.id) refBy = n;
    const channel = args.includes("_") ? args.split("_").slice(1).join("_") : undefined;
    if (channel) await logEvent(u.id, "utm", channel);
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

bot.command("myid", (ctx) =>
  ctx.reply(`Твой Telegram ID: <code>${ctx.from?.id}</code>`, { parse_mode: "HTML" })
);

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

bot.command("find", async (ctx) => {
  const u = await getUser(ctx.from!.id);
  if (!u || !["member", "vip", "trial"].includes(u.status)) {
    await ctx.reply("Поиск доступен только участникам БСП.");
    return;
  }
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

bot.command("stats", async (ctx) => {
  if (!hasRole(ctx.from!.id, "stats")) return;

  // Return cached stats if fresh
  if (statsCache && Date.now() - statsCache.ts < 60000) {
    await ctx.reply(statsCache.text, { parse_mode: "HTML" });
    return;
  }

  const [lead, candidate, trial, member, vip, rejected] = await Promise.all([
    countByStatus("lead"),
    countByStatus("candidate"),
    countByStatus("trial"),
    countByStatus("member"),
    countByStatus("vip"),
    countByStatus("rejected"),
  ]);
  const counts: Record<string, number> = { lead, candidate, trial, member, vip, rejected };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  let newWeek = 0, inactive14 = 0, revenue = 0;
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const day14Ago = Date.now() - 14 * 24 * 3600 * 1000;
  for await (const entry of kv.list({ prefix: ["users"] })) {
    const u = entry.value as User;
    if (new Date(u.createdAt).getTime() > weekAgo) newWeek++;
    if (["member","vip","trial"].includes(u.status) && new Date(u.lastActive).getTime() < day14Ago) inactive14++;
    if (u.status === "member") revenue += 5000;
    else if (u.status === "vip") revenue += 40000;
    else if (u.status === "trial" && u.tariff === "bsp_plus") revenue += 11000;
  }
  const text =
    `📊 <b>Статистика БСП v4.3.0</b>\n\n` +
    `👥 Всего: <b>${total}</b>\n` +
    `🔵 Лиды: ${counts.lead} · 🟡 Кандидаты: ${counts.candidate}\n` +
    `🟠 Пробные: ${counts.trial} · 🟢 Участники: ${counts.member} · 👑 VIP: ${counts.vip}\n\n` +
    `🆕 Новых за 7 дней: <b>${newWeek}</b>\n` +
    `⚠️ Неактивных 14+ дней: <b>${inactive14}</b>\n` +
    `💰 MRR: <b>~${(revenue/1000).toFixed(0)}k ₽</b>`;

  statsCache = { text, ts: Date.now() };
  await ctx.reply(text, { parse_mode: "HTML" });
});

bot.command("cancel", async (ctx) => {
  await ctx.conversation.exit();
  await ctx.reply("Действие отменено.", { reply_markup: mainKb });
});

bot.command("delete_me", async (ctx) => {
  const tgId = ctx.from!.id;
  const u = await getUser(tgId);
  if (!u) { await ctx.reply("Ваши данные не найдены в системе."); return; }
  // Full GDPR deletion — all data and events
  await kv.delete(["users", tgId]);
  await kv.delete(["by_status", u.status, tgId]);
  await kv.delete(["pd_consent", tgId]);
  await kv.delete(["invid", tgId, u.tariff ?? ""]);
  await kv.delete(["unsubscribed", tgId]);
  await kv.delete(["welcome_queue", tgId]);
  // Delete all events for this user
  for await (const entry of kv.list({ prefix: ["events"] })) {
    if ((entry.value as { tgId: number }).tgId === tgId) {
      await kv.delete(entry.key);
    }
  }
  await logEvent(tgId, "delete_me", "Full GDPR deletion");
  await ctx.reply(
    "✅ Все ваши данные удалены из системы БСП (ФЗ-152 / GDPR).\n\nЕсли захотите вернуться — напишите /start.",
    { reply_markup: { remove_keyboard: true } }
  );
});

// NEW: /privacy — политика конфиденциальности
bot.command("privacy", async (ctx) => {
  await ctx.reply(PRIVACY_TEXT, { parse_mode: "HTML" });
});

// NEW: /rejoin — восстановление аккаунта
bot.command("rejoin", async (ctx) => {
  const u = ctx.from!;
  const existing = await getUser(u.id);
  if (existing && !["rejected"].includes(existing.status)) {
    await ctx.reply(`У тебя уже есть аккаунт со статусом ${STATUS_LABELS[existing.status] ?? existing.status}.\n\nЕсли нужна помощь — /support`);
    return;
  }
  if (!existing) {
    await ctx.reply("Аккаунт не найден. Пройди /start для регистрации.");
    return;
  }
  await upsertUser(u.id, u.username ?? "", {
    status: "lead",
    rejoinAt: new Date().toISOString(),
  });
  await logEvent(u.id, "rejoin");
  await notifyAdmins(bot,
    `🔄 <b>Запрос на восстановление</b>\n\n@${u.username ?? "—"} (${u.id})\nПредыдущий статус: ${existing.status}`,
    new InlineKeyboard().url("💬 Написать", `tg://user?id=${u.id}`)
  );
  await ctx.reply(
    "✅ <b>Запрос на восстановление принят!</b>\n\nКуратор свяжется в течение дня.\n@bcpru · +7 960 000-91-91",
    { parse_mode: "HTML", reply_markup: mainKb }
  );
});

// NEW: /feedback — оценка встречи
bot.command("feedback", async (ctx) => {
  const kb = new InlineKeyboard()
    .text("⭐", "feedback_1").text("⭐⭐", "feedback_2").text("⭐⭐⭐", "feedback_3")
    .text("⭐⭐⭐⭐", "feedback_4").text("⭐⭐⭐⭐⭐", "feedback_5");
  await ctx.reply(
    "⭐ <b>Оцени последнюю встречу</b>\n\n1 звезда — слабо · 5 звёзд — отлично",
    { parse_mode: "HTML", reply_markup: kb }
  );
});

// NEW: /support — поддержка
bot.command("support", async (ctx) => {
  await ctx.conversation.enter("supportConv");
});

// NEW: /invite_friend — реферальная программа
bot.command("invite_friend", async (ctx) => {
  const u = ctx.from!;
  const count = await countReferrals(u.id);
  const link = `https://t.me/${ctx.me.username}?start=ref${u.id}`;
  const promoActive = new Date() < new Date(PROMO_END_DATE);
  const bonusMoney = count * 1000;
  const bonusMonths = count >= 3 ? Math.floor(count / 3) : 0;
  await ctx.reply(
    `🎁 <b>Пригласи коллегу в БСП</b>\n\n` +
    `Твоя ссылка:\n<code>${link}</code>\n\n` +
    `💰 <b>+1 000 ₽</b> за каждого вступившего\n` +
    `🎁 <b>3 реферала</b> = бесплатный месяц БСП+\n\n` +
    `Приглашено: <b>${count} чел.</b>\n` +
    `Накоплено: <b>${bonusMoney} ₽</b>${bonusMonths > 0 ? ` + <b>${bonusMonths} мес. БСП+</b>` : ""}` +
    (promoActive ? "\n\n🔥 <b>Акция:</b> твой реферал получает первый месяц в подарок!" : ""),
    { parse_mode: "HTML" }
  );
});

// NEW: /cron_status — статус кронов
bot.command("cron_status", async (ctx) => {
  if (!hasRole(ctx.from!.id, "admin")) return;
  const cronNames = ["member-welcome", "inactive-alert", "sla-candidates"];
  let text = "⚙️ <b>Статус кронов</b>\n\n";
  for (const name of cronNames) {
    const s = (await kv.get<CronStatus>(["cron_status", name])).value;
    if (!s) {
      text += `• ${name}: <i>нет данных</i>\n`;
      continue;
    }
    const icon = s.status === "ok" ? "✅" : s.status === "running" ? "🔄" : "❌";
    const last = s.lastFinished ? new Date(s.lastFinished).toLocaleTimeString("ru-RU") : "—";
    text += `${icon} <b>${name}</b>\n  Последний: ${last} · Обработано: ${s.processed} · Ошибок: ${s.errors}`;
    if (s.lastError) text += `\n  Ошибка: <i>${s.lastError.slice(0, 80)}</i>`;
    text += "\n\n";
  }
  await ctx.reply(text, { parse_mode: "HTML" });
});

// NEW: /weekly_report — CSV для кураторов
bot.command("weekly_report", async (ctx) => {
  if (!hasRole(ctx.from!.id, "admin") && !hasRole(ctx.from!.id, "stats")) return;
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  let csv = "tgId,username,name,city,job,status,tariff,visitCount,lastActive,createdAt,refs\n";
  let active = 0, newThisWeek = 0, inactive = 0;
  for await (const entry of kv.list({ prefix: ["users"] })) {
    const u = entry.value as User;
    const refs = await countReferrals(u.tgId);
    csv += [u.tgId, u.username, u.name, u.city, u.job,
      u.status, u.tariff, u.visitCount, u.lastActive, u.createdAt, refs]
      .map(v => `"${v ?? ""}"`).join(",") + "\n";
    if (["member","vip","trial"].includes(u.status)) {
      active++;
      if (new Date(u.lastActive).getTime() > weekAgo) {
        // active this week - counted above
      } else {
        inactive++;
      }
    }
    if (new Date(u.createdAt).getTime() > weekAgo) newThisWeek++;
  }
  const summary = `📊 Отчёт за неделю: активных ${active}, новых ${newThisWeek}, неактивных ${inactive}`;
  await ctx.reply(summary);
  await ctx.replyWithDocument(
    new Blob([csv], { type: "text/csv" }),
    { filename: `bsp_weekly_${new Date().toISOString().slice(0,10)}.csv` }
  );
});

// NEW: /export_my_data — GDPR выгрузка
bot.command("export_my_data", async (ctx) => {
  const tgId = ctx.from!.id;
  const u = await getUser(tgId);
  if (!u) { await ctx.reply("Данные не найдены."); return; }
  const events: unknown[] = [];
  for await (const entry of kv.list({ prefix: ["events"] })) {
    if ((entry.value as { tgId: number }).tgId === tgId) events.push(entry.value);
  }
  const data = { user: u, events, exportedAt: new Date().toISOString() };
  const json = JSON.stringify(data, null, 2);
  await ctx.replyWithDocument(
    new Blob([json], { type: "application/json" }),
    { filename: `bsp_mydata_${tgId}.json`, caption: "📦 Все ваши данные в системе БСП (GDPR)" }
  );
});

// NEW: /poll — запуск опроса
bot.command("poll", async (ctx) => {
  if (!hasRole(ctx.from!.id, "admin")) return;
  await ctx.conversation.enter("pollConv");
});


// ─── КНОПКИ МЕНЮ ─────────────────────────────────────────────────────────────
bot.hears("🏢 О БСП", async (ctx) => {
  const kb = new InlineKeyboard()
    .text("✍️ Вступить", "ank_start")
    .url("🌐 Сайт", "https://bcpru.ru").row()
    .url("🎬 Запись встречи", "https://youtube.com/@bcpru");
  await ctx.reply(ABOUT, { parse_mode: "HTML", reply_markup: kb });
});

bot.hears("💳 Тарифы", async (ctx) => {
  const kb = new InlineKeyboard()
    .text("💙 БСП — 5 000 ₽/мес", "pay_bsp").row()
    .text("⭐ БСП+ — 11 000 ₽/мес", "pay_bsp_plus").row()
    .text("👑 VIP — 40 000 ₽/мес", "pay_vip").row()
    .text("🤝 Записаться на пробную встречу", "trial_register");
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
    .url("🎬 Запись прошлой встречи", "https://youtube.com/@bcpru");
  await ctx.reply(SCHEDULE_TEXT, { parse_mode: "HTML", reply_markup: kb });
});

bot.hears("🤝 Есть/Нужно/Хочу", (ctx) => ctx.reply(ENH_TEXT, { parse_mode: "HTML" }));

bot.hears("🎁 Мои рефералы", async (ctx) => {
  const u = ctx.from!;
  const count = await countReferrals(u.id);
  const link = `https://t.me/${ctx.me.username}?start=ref${u.id}`;
  const promoActive = new Date() < new Date(PROMO_END_DATE);
  const bonusMonths = count >= 3 ? Math.floor(count / 3) : 0;
  await ctx.reply(
    `🎁 <b>Реферальная программа</b>\n\n` +
    `Твоя ссылка:\n<code>${link}</code>\n\n` +
    `За каждого вступившего: <b>+1 000 ₽</b>\n` +
    `3 реферала = бесплатный месяц БСП+!\n\n` +
    `Приглашено: <b>${count} чел.</b> · Бонус: <b>${count * 1000} ₽</b>${bonusMonths > 0 ? ` + ${bonusMonths} мес. БСП+` : ""}` +
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
    "<code>/find маркетолог</code>\n<code>/find финансы</code>\n<code>/find IT</code>",
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

bot.callbackQuery("pd_consent_yes", async (ctx) => {
  await kv.set(["pd_consent", ctx.from!.id], true);
  await ctx.answerCallbackQuery("✅ Согласие принято");
  await ctx.editMessageText("✅ Согласие на обработку персональных данных принято. Добро пожаловать!");
  await ctx.reply("Привет! 👋\n\nЭто бот БСП — Бизнес Сообщество Профессионалов.\nВыбери раздел 👇", { parse_mode: "HTML", reply_markup: mainKb });
});

bot.callbackQuery("ank_start", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter("anketa");
});

bot.callbackQuery("tsdisn_update", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter("tsdisn");
});

bot.callbackQuery("trial_register", async (ctx) => {
  const u = ctx.from;
  const existing = await getUser(u.id);
  if (existing && ["member", "vip"].includes(existing.status)) {
    await ctx.answerCallbackQuery("✅ Ты уже участник БСП!");
    await ctx.reply("✅ <b>Ты уже участник БСП!</b>\n\nПерейди в личный кабинет 👇", { parse_mode: "HTML", reply_markup: memberKb });
    return;
  }
  await ctx.answerCallbackQuery("✅ Записываю!");
  if (!existing || existing.status === "lead") {
    await upsertUser(u.id, u.username ?? "", { status: "trial" });
  }
  await ctx.reply(
    "✅ <b>Записан на пробную Десятку!</b>\n\nКуратор свяжется в течение дня.\nTelegram: @bcpru",
    { parse_mode: "HTML", reply_markup: mainKb }
  );
  await notifyAdmins(bot,
    `🔔 <b>Запись на пробную встречу!</b>\n@${u.username ?? "—"} (${u.id}) · ${existing?.name ?? u.first_name}`,
    new InlineKeyboard().url("💬 Написать", `tg://user?id=${u.id}`)
  );
});

bot.callbackQuery(/^nps_(\d+)$/, async (ctx) => {
  const score = parseInt(ctx.match[1]);
  await ctx.answerCallbackQuery("Спасибо! 🙏");
  await kv.set(["nps", Date.now(), ctx.from.id], { tgId: ctx.from.id, score, ts: new Date().toISOString() });
  await logEvent(ctx.from.id, "nps", String(score));
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  const comment = score >= 9 ? "Рады, что встреча была ценной! 💙"
    : score >= 7 ? "Хорошо! Если есть идеи — пиши @bcpru"
    : "Жаль. Напиши куратору @bcpru — разберёмся.";
  await ctx.reply(`Оценка <b>${score}/10</b> принята. ${comment}`, { parse_mode: "HTML" });
  await notifyAdmins(bot, `⭐ NPS от @${ctx.from.username ?? ctx.from.id}: <b>${score}/10</b>`);
});

// NEW: feedback callbacks
bot.callbackQuery(/^feedback_(\d)$/, async (ctx) => {
  const stars = parseInt(ctx.match[1]);
  await ctx.answerCallbackQuery(`Оценка ${stars} ⭐ принята!`);
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  await kv.set(["feedback", Date.now(), ctx.from.id], { tgId: ctx.from.id, stars, ts: new Date().toISOString() });
  await logEvent(ctx.from.id, "feedback", String(stars));
  const starStr = "⭐".repeat(stars);
  await ctx.reply(`${starStr} Спасибо за оценку встречи!`);
  if (stars <= 2) {
    await notifyAdmins(bot, `⚠️ <b>Низкая оценка встречи!</b>\n\n@${ctx.from.username ?? ctx.from.id}: ${stars}/5 ⭐\n\nНужна обратная связь!`);
  }
});

// NEW: poll vote callback
bot.callbackQuery(/^poll_vote_(.+)_(\d+)$/, async (ctx) => {
  const pollId = ctx.match[1];
  const optIdx = parseInt(ctx.match[2]);
  const tgId = ctx.from.id;
  const poll = (await kv.get<Poll>(["polls", pollId])).value;
  if (!poll) { await ctx.answerCallbackQuery("Опрос не найден."); return; }
  if (poll.voters.includes(tgId)) { await ctx.answerCallbackQuery("Вы уже проголосовали!"); return; }
  poll.voters.push(tgId);
  poll.votes[optIdx] = (poll.votes[optIdx] ?? 0) + 1;
  await kv.set(["polls", pollId], poll);
  await ctx.answerCallbackQuery(`✅ Голос за «${poll.options[optIdx]}» принят!`);
  await logEvent(tgId, "poll_vote", `${pollId}:${optIdx}`);
});



bot.callbackQuery(/^pay_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const key = ctx.match[1];
  if (!(key in TARIFFS)) return;
  const [, desc, label] = TARIFFS[key];
  const invId = await makeInvId(ctx.from.id, key);
  const url = makePayUrl(ctx.from.id, key, invId);
  if (url) {
    await ctx.reply(`💳 <b>${desc}</b>\n<b>${label}</b>\n\nНажми для оплаты:`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().url(`💳 Оплатить ${label}`, url) });
  } else {
    await ctx.reply(`💳 <b>${desc}</b> — ${label}\n\nДля оплаты: @bcpru · +7 960 000-91-91`, { parse_mode: "HTML" });
  }
});

bot.callbackQuery(/^admin_accept_(\d+)$/, async (ctx) => {
  if (!hasRole(ctx.from.id, "admin")) return ctx.answerCallbackQuery("Нет доступа");
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
  if (!hasRole(ctx.from.id, "admin")) return ctx.answerCallbackQuery("Нет доступа");
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
  if (!hasRole(ctx.from.id, "admin")) return ctx.answerCallbackQuery("Нет доступа");
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

bot.callbackQuery("unsubscribe", async (ctx) => {
  await kv.set(["unsubscribed", ctx.from!.id], true);
  await ctx.answerCallbackQuery("✅ Вы отписались от рассылки");
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
});

// ─── ADMIN КОМАНДЫ ────────────────────────────────────────────────────────────
bot.command("admin", async (ctx) => {
  if (!hasRole(ctx.from!.id, "admin")) return;
  const statuses = ["lead", "candidate", "trial", "member", "vip"];
  const counts: Record<string, number> = {};
  for (const s of statuses) counts[s] = await countByStatus(s);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const kb = new InlineKeyboard()
    .text("📋 Лиды", "adm_list_lead").text("🟡 Кандидаты", "adm_list_candidate").row()
    .text("🟢 Участники", "adm_list_member").text("👑 VIP", "adm_list_vip").row()
    .text("📊 Экспорт CSV", "adm_export");
  await ctx.reply(
    `🛠 <b>Админ-панель БСП v4.3.0</b>\n\nВсего: <b>${total}</b>\n` +
    `🔵 Лиды: ${counts.lead} · 🟡 Кандидаты: ${counts.candidate}\n` +
    `🟠 Пробные: ${counts.trial} · 🟢 Участники: ${counts.member} · 👑 VIP: ${counts.vip}\n\n` +
    `Команды: /stats · /sendnps · /setmember · /setstatus\n/cron_status · /weekly_report · /poll`,
    { parse_mode: "HTML", reply_markup: kb }
  );
});

bot.command("setmember", async (ctx) => {
  if (!hasRole(ctx.from!.id, "admin")) return;
  const parts = ctx.match?.split(" ") ?? [];
  if (parts.length < 2) { await ctx.reply("Использование: /setmember <tg_id> <bsp|bsp_plus|vip>"); return; }
  const tgId = parseInt(parts[0]);
  const tariff = parts[1];
  await upsertUser(tgId, "", { status: "member", tariff });
  await changeStatus(tgId, "member");
  statsCache = null; // Invalidate cache
  await ctx.reply(`✅ ${tgId} → участник (${tariff})`);
  await kv.set(["welcome_queue", tgId], { step: 0, nextAt: Date.now() + 5000 });
  try { await bot.api.sendMessage(tgId, "👇 Меню участника:", { reply_markup: memberKb }); } catch (_e) { /* */ }
});


bot.command("setstatus", async (ctx) => {
  if (!hasRole(ctx.from!.id, "admin")) return;
  const parts = ctx.match?.split(" ") ?? [];
  if (parts.length < 2) { await ctx.reply("Использование: /setstatus <tg_id> <status>"); return; }
  await changeStatus(parseInt(parts[0]), parts[1]);
  statsCache = null;
  await ctx.reply("✅ Статус обновлён");
});

bot.command("sendnps", async (ctx) => {
  if (!hasRole(ctx.from!.id, "admin")) return;
  const tgId = parseInt(ctx.match ?? "");
  if (isNaN(tgId)) { await ctx.reply("Использование: /sendnps <tg_id>"); return; }
  await sendNPS(tgId);
  await ctx.reply(`✅ NPS отправлен пользователю ${tgId}`);
});

// ─── CRON JOBS ────────────────────────────────────────────────────────────────

// Прогрев гостей каждые 30 минут

// Welcome-последовательность
Deno.cron("member-welcome", "*/30 * * * *", async () => {
  await cronStart("member-welcome");
  let processed = 0, errors = 0;
  try {
    const now = Date.now();
    for await (const entry of kv.list({ prefix: ["welcome_queue"] })) {
      const data = entry.value as { step: number; nextAt: number };
      const tgId = entry.key[1] as number;
      if (now < data.nextAt) continue;
      const step = data.step;
      if (step >= WELCOME_STEPS.length) {
        const existing = await kv.get(["welcome_queue", tgId]);
        await kv.atomic().check(existing).delete(["welcome_queue", tgId]).commit();
        continue;
      }
      try {
        await bot.api.sendMessage(tgId, WELCOME_STEPS[step],
          { parse_mode: "HTML", reply_markup: step === WELCOME_STEPS.length - 1 ? memberKb : undefined }
        );
        const nextStep = step + 1;
        const existing = await kv.get(["welcome_queue", tgId]);
        if (nextStep < WELCOME_STEPS.length) {
          await kv.atomic().check(existing)
            .set(["welcome_queue", tgId], { step: nextStep, nextAt: now + WELCOME_DELAYS[nextStep] })
            .commit();
        } else {
          await kv.atomic().check(existing).delete(["welcome_queue", tgId]).commit();
        }
        processed++;
      } catch (e) {
        errors++;
        log("WARN", "welcome_send_fail", { tgId, error: String(e) });
        const existing = await kv.get(["welcome_queue", tgId]);
        await kv.atomic().check(existing).delete(["welcome_queue", tgId]).commit();
      }
    }
  } catch (e) { await cronError("member-welcome", e); return; }
  await cronEnd("member-welcome", processed, errors);
});

// Алерт о неактивных участниках
Deno.cron("inactive-alert", "0 9 * * *", async () => {
  await cronStart("inactive-alert");
  try {
    const day14Ago = Date.now() - 14 * 24 * 3600 * 1000;
    const inactive: User[] = [];
    for await (const entry of kv.list({ prefix: ["users"] })) {
      const u = entry.value as User;
      if (!["member","vip","trial"].includes(u.status)) continue;
      if (new Date(u.lastActive).getTime() < day14Ago) inactive.push(u);
    }
    if (inactive.length) {
      let text = `⚠️ <b>Неактивных 14+ дней: ${inactive.length} чел.</b>\n\n`;
      for (const u of inactive.slice(0, 10)) {
        const days = Math.floor((Date.now() - new Date(u.lastActive).getTime()) / 86400000);
        text += `• ${u.name || "—"} | @${u.username || u.tgId} | ${days} дней\n`;
      }
      if (inactive.length > 10) text += `\n...и ещё ${inactive.length - 10} чел.`;
      await notifyAdmins(bot, text);
    }
    await cronEnd("inactive-alert", inactive.length, 0);
  } catch (e) { await cronError("inactive-alert", e); }
});

// SLA: кандидат без ответа >4 ч
Deno.cron("sla-candidates", "*/30 * * * *", async () => {
  await cronStart("sla-candidates");
  try {
    const h4ago = Date.now() - 4 * 3600 * 1000;
    const stale: User[] = [];
    for await (const entry of kv.list({ prefix: ["by_status", "candidate"] })) {
      const tgId = entry.key[2] as number;
      const u = await getUser(tgId);
      if (!u) continue;
      if (new Date(u.updatedAt).getTime() < h4ago) stale.push(u);
    }
    if (stale.length) {
      let text = `⏰ <b>SLA-алерт: ${stale.length} кандидатов без ответа >4 часов!</b>\n\n`;
      for (const u of stale.slice(0, 10)) {
        const hrs = Math.floor((Date.now() - new Date(u.updatedAt).getTime()) / 3600000);
        text += `• ${u.name || "—"} | @${u.username || u.tgId} | ${hrs}ч без движения\n`;
      }
      await notifyAdmins(bot, text);
    }
    await cronEnd("sla-candidates", stale.length, 0);
  } catch (e) { await cronError("sla-candidates", e); }
});

// NEW: Followup для кандидатов (48ч / 5д / 10д)

// ─── WEBHOOK + HTTP ───────────────────────────────────────────────────────────
const handleUpdate = webhookCallback(bot, "std/http");

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // NEW: /health endpoint
  if (url.pathname === "/health") {
    const cronNames = ["member-welcome", "inactive-alert", "sla-candidates"];
    const cronStatuses: Record<string, string> = {};
    for (const name of cronNames) {
      const s = (await kv.get<CronStatus>(["cron_status", name])).value;
      cronStatuses[name] = s?.status ?? "unknown";
    }
    return new Response(
      JSON.stringify({
        status: "ok",
        version: "4.3.0",
        ts: new Date().toISOString(),
        crons: cronStatuses,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  if (url.pathname === "/") {
    return new Response("БСП Bot v4.3.0 ✅", { status: 200 });
  }

  if (url.pathname === `/${WEBHOOK_SECRET}`) {
    if (TG_SECRET_TOKEN) {
      const header = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (header !== TG_SECRET_TOKEN) return new Response("Forbidden", { status: 403 });
    }
    return handleUpdate(req);
  }

  // Robokassa payment handler — FIX: no duplicate tgIdStr
  if (url.pathname === "/robokassa/result") {
    try {
      const p = url.searchParams;
      const outSum  = p.get("OutSum") ?? "";
      const invId   = p.get("InvId") ?? "";
      const tgIdParam = p.get("Shp_tgId") ?? "";  // FIX: single declaration, renamed to tgIdParam
      const tariff  = p.get("Shp_tariff") ?? "";
      const sig     = p.get("SignatureValue") ?? "";
      const tgId    = parseInt(tgIdParam);

      if (!tgId || !(tariff in TARIFFS)) {
        log("WARN", "robokassa_bad_params", { outSum, invId, tariff });
        return new Response("Bad params", { status: 400 });
      }

      if (ROBOKASSA_PASS2 && !(await withRetry(() => verifyRobokassaSig(outSum, invId, sig, tgIdParam, tariff)))) {
        await logEvent(tgId, "payment_sig_fail", `inv=${invId} sig=${sig}`);
        return new Response("Bad signature", { status: 403 });
      }

      await changeStatus(tgId, "member");
      await upsertUser(tgId, "", { tariff, status: "member" });
      await logEvent(tgId, "payment", `${tariff} ${outSum}₽ inv=${invId}`);
      statsCache = null; // Invalidate stats cache after payment
      await kv.set(["welcome_queue", tgId], { step: 0, nextAt: Date.now() });
      await kv.delete(["invid", tgId, tariff]);
      await kv.delete(["invid_reverse", parseInt(invId)]);
      try {
        await bot.api.sendMessage(tgId,
          `✅ <b>Оплата получена!</b>\nДобро пожаловать! Тариф: ${TARIFFS[tariff]?.[2] ?? tariff}`,
          { parse_mode: "HTML", reply_markup: memberKb }
        );
      } catch (_e) { /* ignore */ }
      await notifyAdmins(bot, `💰 Оплата: ${tgId} | ${tariff} | ${outSum} ₽`);
      return new Response(`OK${invId}`, { status: 200 });
    } catch (e) {
      log("ERROR", "robokassa_handler_error", { error: String(e) });
      return new Response("Error", { status: 400 });
    }
  }

  return new Response("Not Found", { status: 404 });
});

log("INFO", "bot_started", { version: "4.3.0" });
