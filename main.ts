/**
 * БСП — Telegram Bot v4.6.0 (Deno Deploy + grammy)
 * НОВОЕ в v4.6.0:
 * - Эндпоинт GET /pay?plan=bsp|bsp_plus|vip — прямая оплата с сайта без Telegram
 * - /robokassa/result теперь обрабатывает оплаты с сайта (Shp_tgId=0)
 * НОВОЕ в v4.5.0:
 * - Robokassa deep-link: /start pay_bsp|bsp_plus|vip — прямой переход к оплате с сайта
 * Новые сценарии поверх v4.3.0:
 * А-4: Followup кандидатов (48ч/5д/10д) — реализован крон
 * А-1: Умный онбординг — персонализация по источнику
 * А-2: Матчинг агент — /match_me + skill-индексы в KV
 * А-5: Аналитика воронки — /funnel для СД
 * В-2: Daily check-in — /checkin_on, /checkin_off + крон
 * В-3: Таймбанкинг — /give_time, /my_balance, /timebank_top
 * В-4: ЕНХ цифровой формат — conversational flow /enh
 * В-5: Напоминания о встречах — крон + /set_meeting
 * В-1: Прогресс-бар — /my_progress
 * Л-1: Подготовка к встрече — /prep_meeting
 * Л-2: Разбор запроса 7 слоёв — /analyze_request
 * Л-4: Журнал встреч — /meeting_log
 * Л-5: Алерты лидера — крон leader-alerts
 * Л-3: Онбординг в группу — /add_to_group, /group_members
 * FIX: makePayUrl — правильная MD5-подпись Robokassa
 * FIX: /delete_me — logEvent перед удалением
 * FIX: убран мёртвый nurtureStep из User
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
const LEADER_IDS       = (Deno.env.get("LEADER_IDS") ?? "")
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

const VALID_STATUSES = ["lead", "candidate", "trial", "member", "vip", "rejected", "paused"];

// ─── LOGGING ──────────────────────────────────────────────────────────────────
function log(level: "INFO"|"WARN"|"ERROR", event: string, data: Record<string,unknown> = {}): void {
  console.log(JSON.stringify({ level, event, ts: new Date().toISOString(), ...data }));
}

// ─── ROLES ────────────────────────────────────────────────────────────────────
function hasRole(tgId: number, role: "admin"|"broadcaster"|"stats"|"leader"): boolean {
  if (ADMIN_IDS.includes(tgId)) return true;
  if (role === "broadcaster") return BROADCASTER_IDS.includes(tgId);
  if (role === "stats") return STATS_IDS.includes(tgId);
  if (role === "leader") return LEADER_IDS.includes(tgId);
  return false;
}

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface TariffHistoryEntry { tariff: string; ts: string; prev?: string; }

interface User {
  tgId: number; username: string; name: string;
  city?: string; job?: string; company?: string; source?: string;
  status: string;
  tariff?: string; tariffHistory?: TariffHistoryEntry[];
  refCode: string; refBy?: number;
  notes?: string; skills?: string[];
  visitCount: number; lastActive: string;
  pausedAt?: string; rejoinAt?: string;
  followUpStep?: number;
  checkinEnabled?: boolean;
  groupCity?: string;
  createdAt: string; updatedAt: string;
}

interface CronStatus {
  name: string; lastStarted: string; lastFinished?: string;
  lastError?: string; processed: number; errors: number;
  status: "running"|"ok"|"error";
}

interface Poll {
  question: string; options: string[];
  votes: Record<number, number>; voters: number[];
  createdAt: string; createdBy: number;
}

interface MeetingLog {
  city: string; format: string; attendees: number;
  requests: string; nextSteps: string;
  leaderId: number; ts: string;
}

interface GroupSchedule {
  city: string; format: string; weekday: string;
  time: string; zoomLink?: string; leaderId: number;
}

interface TimebankTx {
  fromId: number; toId: number; amount: number;
  reason: string; ts: string;
}

// ─── KV ───────────────────────────────────────────────────────────────────────
const kv = await Deno.openKv();

async function getUser(tgId: number): Promise<User|null> {
  return (await kv.get<User>(["users", tgId])).value;
}

async function upsertUser(tgId: number, username: string, fields: Partial<User>): Promise<void> {
  const existing = await getUser(tgId);
  const now = new Date().toISOString();
  let tariffHistory = existing?.tariffHistory ?? [];
  if (fields.tariff && existing?.tariff && existing.tariff !== fields.tariff) {
    tariffHistory = [...tariffHistory, { tariff: fields.tariff, ts: now, prev: existing.tariff }];
  } else if (fields.tariff && !existing?.tariff) {
    tariffHistory = [{ tariff: fields.tariff, ts: now }];
  }
  const user: User = existing
    ? { ...existing, ...fields, tariffHistory, updatedAt: now }
    : { tgId, username, name: fields.name ?? "", status: "lead",
        refCode: `ref${tgId}`, visitCount: 0, lastActive: now,
        tariffHistory, createdAt: now, updatedAt: now, ...fields };
  await kv.set(["users", tgId], user);
  if (existing?.status && existing.status !== user.status) {
    await kv.delete(["by_status", existing.status, tgId]);
  }
  await kv.set(["by_status", user.status, tgId], true);
  // Обновляем city-индекс
  if (fields.city && fields.city !== existing?.city) {
    if (existing?.city) await kv.delete(["by_city", existing.city, tgId]);
    await kv.set(["by_city", fields.city, tgId], true);
  }
}

async function saveSkillIndex(tgId: number, skillsText: string): Promise<void> {
  const u = await getUser(tgId);
  // Удаляем старые индексы
  for (const sk of u?.skills ?? []) {
    await kv.delete(["by_skill", sk.toLowerCase(), tgId]);
  }
  // Парсим новые навыки (слова длиннее 3 символов)
  const newSkills = skillsText.toLowerCase()
    .split(/[,;\s\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 3)
    .slice(0, 10);
  for (const sk of newSkills) {
    await kv.set(["by_skill", sk, tgId], true);
  }
  await upsertUser(tgId, u?.username ?? "", { skills: newSkills });
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

async function listByStatus(status: string): Promise<User[]> {
  const users: User[] = [];
  for await (const entry of kv.list({ prefix: ["by_status", status] })) {
    const tgId = entry.key[2] as number;
    const u = await getUser(tgId);
    if (u) users.push(u);
  }
  return users;
}

async function countReferrals(tgId: number): Promise<number> {
  let n = 0;
  for await (const entry of kv.list({ prefix: ["users"] })) {
    if ((entry.value as User).refBy === tgId) n++;
  }
  return n;
}

// Таймбанк
async function getTimebankBalance(tgId: number): Promise<number> {
  return (await kv.get<number>(["timebank", tgId])).value ?? 0;
}

async function transferTimebank(fromId: number, toId: number, amount: number, reason: string): Promise<void> {
  const fromBal = await getTimebankBalance(fromId);
  if (fromBal < amount) throw new Error("Недостаточно тайм-кредитов");
  await kv.set(["timebank", fromId], fromBal - amount);
  const toBal = await getTimebankBalance(toId);
  await kv.set(["timebank", toId], toBal + amount);
  const tx: TimebankTx = { fromId, toId, amount, reason, ts: new Date().toISOString() };
  await kv.set(["timebank_tx", Date.now()], tx);
  await logEvent(fromId, "timebank_give", `→${toId} ${amount}ч: ${reason}`);
}

async function addTimebankCredits(tgId: number, amount: number, reason: string): Promise<void> {
  const bal = await getTimebankBalance(tgId);
  await kv.set(["timebank", tgId], bal + amount);
  await kv.set(["timebank_tx", Date.now()], { fromId: 0, toId: tgId, amount, reason, ts: new Date().toISOString() });
}

// ─── CRON STATUS ──────────────────────────────────────────────────────────────
async function cronStart(name: string): Promise<void> {
  await kv.set(["cron_status", name], { name, lastStarted: new Date().toISOString(), processed: 0, errors: 0, status: "running" });
  log("INFO", "cron_start", { cron: name });
}

async function cronEnd(name: string, processed = 0, errors = 0): Promise<void> {
  const existing = (await kv.get<CronStatus>(["cron_status", name])).value;
  await kv.set(["cron_status", name], {
    ...(existing ?? { name, lastStarted: new Date().toISOString(), processed: 0, errors: 0 }),
    lastFinished: new Date().toISOString(), processed, errors, status: errors > 0 ? "error" : "ok",
  });
  log("INFO", "cron_end", { cron: name, processed, errors });
}

async function cronError(name: string, error: unknown): Promise<void> {
  const errMsg = error instanceof Error ? error.message : String(error);
  const existing = (await kv.get<CronStatus>(["cron_status", name])).value;
  await kv.set(["cron_status", name], {
    ...(existing ?? { name, lastStarted: new Date().toISOString(), processed: 0, errors: 0 }),
    lastError: errMsg, status: "error", errors: (existing?.errors ?? 0) + 1,
  });
  log("ERROR", "cron_error", { cron: name, error: errMsg });
  for (const aid of ADMIN_IDS) {
    try { await bot.api.sendMessage(aid, `🚨 <b>Cron ошибка: ${name}</b>\n\n${errMsg}`, { parse_mode: "HTML" }); }
    catch (_e) { /* ignore */ }
  }
}

// ─── RETRY ────────────────────────────────────────────────────────────────────
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelay = 1000): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
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
  if (_rateMap.size > 2000) for (const [k, v] of _rateMap) if (now - v > 60000) _rateMap.delete(k);
  return false;
}

// ─── STATS CACHE ──────────────────────────────────────────────────────────────
let statsCache: { text: string; ts: number } | null = null;


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
  .text("⏰ Таймбанк").text("📈 Мой прогресс").row()
  .text("↩️ Меню").resized();

const leaderKb = new Keyboard()
  .text("📝 Журнал встречи").text("🗓 Подготовка к встрече").row()
  .text("👥 Моя группа").text("🔬 Разбор запроса").row()
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
• Нетворкинг · Таймбанкинг · ЦДИСН

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

Telegram: @bcpru · Телефон: +7 960 000-91-91
Email: info@bspru.ru · Сайт: bcpru.ru`;

const ENH_TEXT = `🤝 <b>Есть — Нужно — Хочу</b>

На каждой встрече каждый участник говорит:

<b>✅ ЕСТЬ</b> — чем могу помочь прямо сейчас
<b>🎯 НУЖНО</b> — что мне важно решить
<b>💡 ХОЧУ</b> — с кем хочу познакомиться`;

const PRIVACY_TEXT = `🔒 <b>Политика конфиденциальности БСП</b>

Мы обрабатываем ваши данные в соответствии с <b>ФЗ-152 «О персональных данных»</b>.

<b>Ваши права:</b>
• /delete_me — удалить все данные
• /export_my_data — получить копию данных

Оператор: info@bspru.ru`;

const WELCOME_STEPS = [
  "🎉 <b>Добро пожаловать в БСП!</b>\n\nТы вступил в сообщество равных. Пройдём быстрый онбординг — 4 шага, 2 минуты.",
  "📋 <b>Шаг 1 — ЦДИСН</b>\n\nТвоя визитная карточка в группе. Заполни — группа сразу узнает, чем ты ценен.\n\nНажми «Мой ЦДИСН» в меню.",
  "📅 <b>Шаг 2 — Расписание</b>\n\nВыбери удобный слот. Куратор назначит тебя в группу по функции и уровню.",
  "🤝 <b>Шаг 3 — Есть/Нужно/Хочу</b>\n\nНа каждой встрече 3 минуты на тебя. Подготовь: что есть, что нужно, с кем хочешь познакомиться.",
  "🎁 <b>Шаг 4 — Рефералы</b>\n\nПригласи коллегу → получи <b>1 000 ₽</b>. 3 реферала = бесплатный месяц БСП+!\n\n✅ <b>Готово! Встречаемся на первой встрече.</b>",
];
const WELCOME_DELAYS = [0, 3600*1000, 24*3600*1000, 48*3600*1000, 5*24*3600*1000];

const FOLLOWUP_MESSAGES = [
  { delay: 48*3600*1000, step: 1, text: "🟡 <b>Привет!</b>\n\nВидим, что ты оставил заявку в БСП. Это нормально — важные решения не принимаются в спешке.\n\nЕсть вопросы? Просто ответь или напиши @bcpru" },
  { delay: 5*24*3600*1000, step: 2, text: "💡 <b>БСП — 5 дней без ответа</b>\n\nЗнаем, что ты занят. Один вопрос:\n\n<i>Что мешает сделать шаг?</i>\n\nОтвет поможет нам подобрать правильную группу именно для тебя." },
  { delay: 10*24*3600*1000, step: 3, text: "🔔 <b>Последнее сообщение от БСП</b>\n\nНе хотим надоедать. Если передумаешь — мы здесь. @bcpru\n\nСпасибо за интерес к сообществу!" },
];

const STATUS_LABELS: Record<string, string> = {
  lead: "🔵 Лид", candidate: "🟡 Кандидат",
  trial: "🟠 Пробный", member: "🟢 Участник",
  vip: "👑 VIP", rejected: "⛔ Архив", paused: "⏸ Пауза",
};

const SEVEN_LAYERS = [
  "1. Действия — что делает, как часто, с какой результативностью",
  "2. Инструменты — CRM, KPI-системы, методики планирования",
  "3. Бизнес-модель / роль — стратегия или реализация целей отдела",
  "4. Рынок и ниша — клиенты, конкуренты, тенденции",
  "5. Партнёрства и влияние — внутренние и внешние связи",
  "6. Отношения и команда — лидерство, делегирование, конфликты",
  "7. Личность и установки — страхи, амбиции, эмоциональный интеллект",
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function notifyAdmins(bot: Bot, text: string, kb?: InlineKeyboard): Promise<void> {
  for (const aid of ADMIN_IDS) {
    try { await bot.api.sendMessage(aid, text, { parse_mode: "HTML", reply_markup: kb }); }
    catch (e) { log("WARN", "notify_admin_fail", { aid, error: String(e) }); }
  }
}

// FIX: правильная подпись Robokassa
async function md5Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await stdCrypto.subtle.digest("MD5", buf);
  return encodeHex(new Uint8Array(hash));
}

async function makePayUrl(tgId: number, key: string, invId: number): Promise<string|null> {
  if (!ROBOKASSA_LOGIN || !ROBOKASSA_PASS1) return null;
  const [amount, desc] = TARIFFS[key];
  const outSum = `${amount}.00`;
  const shpStr = `Shp_tariff=${key}:Shp_tgId=${tgId}`;
  // FIX: генерируем корректную MD5-подпись
  const sig = await md5Hex(`${ROBOKASSA_LOGIN}:${outSum}:${invId}:${ROBOKASSA_PASS1}:${shpStr}`);
  const params = new URLSearchParams({
    MrchLogin: ROBOKASSA_LOGIN, OutSum: outSum, InvId: String(invId),
    Desc: desc, SignatureValue: sig,
    Shp_tgId: String(tgId), Shp_tariff: key,
  });
  return `https://auth.robokassa.ru/Merchant/Index.aspx?${params}`;
}

async function verifyRobokassaSig(outSum: string, invId: string, sig: string, tgIdParam: string, tariff: string): Promise<boolean> {
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

async function sendNPS(tgId: number) {
  const kb = new InlineKeyboard();
  for (let i = 1; i <= 5; i++) kb.text(String(i), `nps_${i}`);
  kb.row();
  for (let i = 6; i <= 10; i++) kb.text(String(i), `nps_${i}`);
  try {
    await bot.api.sendMessage(tgId, "⭐ <b>Насколько ценной была встреча?</b>\n\n1 — совсем не ценной · 10 — очень ценной",
      { parse_mode: "HTML", reply_markup: kb });
  } catch (e) { log("WARN", "send_nps_fail", { tgId, error: String(e) }); }
}

// ─── SESSION ──────────────────────────────────────────────────────────────────
interface SessionData { step: string; }

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

// ─── BOT INIT ─────────────────────────────────────────────────────────────────
type MyContext = ConversationFlavor<Context>;
type MyConversation = Conversation<MyContext>;

const bot = new Bot<MyContext>(BOT_TOKEN);
bot.use(session({ initial: (): SessionData => ({ step: "" }), storage: kvStorage(kv) }));
bot.use(conversations());
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
    notifyKb);
  await ctx.reply("✅ <b>Заявка принята!</b>\n\nКуратор свяжется в течение дня.\n@bcpru · +7 960 000-91-91",
    { parse_mode: "HTML", reply_markup: mainKb });
}
bot.use(createConversation(anketa));

async function question(conversation: MyConversation, ctx: MyContext) {
  await ctx.reply("❓ Напиши свой вопрос — куратор ответит:", { reply_markup: cancelKb });
  const text = await waitText(conversation, ctx);
  if (text === "❌ Отмена") { await ctx.reply("Отменено.", { reply_markup: mainKb }); return; }
  const u = ctx.from!;
  await notifyAdmins(bot, `❓ <b>Вопрос</b> от @${u.username ?? u.id}\n\n${text}`,
    new InlineKeyboard().url("💬 Ответить", `tg://user?id=${u.id}`));
  await ctx.reply("✅ Вопрос отправлен куратору!", { reply_markup: mainKb });
}
bot.use(createConversation(question));

async function tsdisn(conversation: MyConversation, ctx: MyContext) {
  await ctx.reply("📋 <b>ЦДИСН — твоя визитка в группе</b>\n\n<b>Ц — Цели:</b> Чего хочешь достичь за год?",
    { parse_mode: "HTML", reply_markup: cancelKb });
  const tsC = await waitText(conversation, ctx);
  if (tsC === "❌ Отмена") { await ctx.reply("Отменено.", { reply_markup: memberKb }); return; }

  await ctx.reply("<b>Д — Достижения:</b> Чем гордишься за 2–3 года?", { parse_mode: "HTML" });
  const tsD = await waitText(conversation, ctx);
  if (tsD === "❌ Отмена") { await ctx.reply("Отменено.", { reply_markup: memberKb }); return; }

  await ctx.reply("<b>И — Интересы:</b> Какие темы близки в работе и жизни?", { parse_mode: "HTML" });
  const tsI = await waitText(conversation, ctx);
  if (tsI === "❌ Отмена") { await ctx.reply("Отменено.", { reply_markup: memberKb }); return; }

  await ctx.reply("<b>С — Связи:</b> Кого знаешь, кем можешь поделиться?", { parse_mode: "HTML" });
  const tsS = await waitText(conversation, ctx);
  if (tsS === "❌ Отмена") { await ctx.reply("Отменено.", { reply_markup: memberKb }); return; }

  await ctx.reply("<b>Н — Навыки:</b> В чём эксперт? Чем можешь помочь? (перечисли через запятую)", { parse_mode: "HTML" });
  const tsN = await waitText(conversation, ctx);
  if (tsN === "❌ Отмена") { await ctx.reply("Отменено.", { reply_markup: memberKb }); return; }

  const summary = `🎯 <b>Цели:</b> ${tsC}\n🏆 <b>Достижения:</b> ${tsD}\n💡 <b>Интересы:</b> ${tsI}\n🤝 <b>Связи:</b> ${tsS}\n⚡ <b>Навыки:</b> ${tsN}`;
  const u = ctx.from!;
  const notesText = `ЦДИСН:\n${summary.replace(/<[^>]+>/g, "")}`;
  await upsertUser(u.id, u.username ?? "", { notes: notesText });
  // Обновляем skill-индекс на основе навыков
  await saveSkillIndex(u.id, `${tsN} ${tsI} ${tsD}`);
  await ctx.reply(`📋 <b>ЦДИСН сохранён!</b>\n\n${summary}\n\n💡 Теперь тебя найдут через /match_me по навыкам`, { parse_mode: "HTML", reply_markup: memberKb });
  await notifyAdmins(bot, `📋 <b>Новый ЦДИСН</b> @${u.username ?? u.id}\n\n${summary}`);
  // Начисляем тайм-кредит за заполнение ЦДИСН
  await addTimebankCredits(u.id, 1, "Заполнение ЦДИСН");
}
bot.use(createConversation(tsdisn));

async function supportConv(conversation: MyConversation, ctx: MyContext) {
  await ctx.reply("🆘 <b>Поддержка БСП</b>\n\nОпиши свой вопрос:", { parse_mode: "HTML", reply_markup: cancelKb });
  const text = await waitText(conversation, ctx);
  if (text === "❌ Отмена") { await ctx.reply("Отменено.", { reply_markup: mainKb }); return; }
  const u = ctx.from!;
  const ticketId = `TKT-${Date.now()}`;
  await kv.set(["support", ticketId], { tgId: u.id, text, ts: new Date().toISOString(), status: "open" });
  await logEvent(u.id, "support_ticket", ticketId);
  await notifyAdmins(bot, `🎫 <b>Тикет #${ticketId}</b>\n\n👤 @${u.username ?? u.id}\n\n${text}`,
    new InlineKeyboard().url("💬 Ответить", `tg://user?id=${u.id}`));
  await ctx.reply(`✅ <b>Тикет #${ticketId} создан!</b>\n\nОтветим в течение дня.`, { parse_mode: "HTML", reply_markup: mainKb });
}
bot.use(createConversation(supportConv));

async function pollConv(conversation: MyConversation, ctx: MyContext) {
  if (!hasRole(ctx.from!.id, "admin")) { await ctx.reply("Нет доступа."); return; }
  await ctx.reply("📊 <b>Создание опроса</b>\n\nВведи вопрос:", { parse_mode: "HTML", reply_markup: cancelKb });
  const pollQuestion = await waitText(conversation, ctx);
  if (pollQuestion === "❌ Отмена") { await ctx.reply("Отменено."); return; }
  await ctx.reply("Введи варианты ответов через запятую (до 5):");
  const optionsRaw = await waitText(conversation, ctx);
  if (optionsRaw === "❌ Отмена") { await ctx.reply("Отменено."); return; }
  const options = optionsRaw.split(",").map(o => o.trim()).slice(0, 5);
  const pollId = `poll_${Date.now()}`;
  const poll: Poll = { question: pollQuestion, options, votes: {}, voters: [], createdAt: new Date().toISOString(), createdBy: ctx.from!.id };
  await kv.set(["polls", pollId], poll);
  const kb = new InlineKeyboard();
  options.forEach((opt, i) => kb.text(opt, `poll_vote_${pollId}_${i}`).row());
  let sent = 0;
  for await (const entry of kv.list({ prefix: ["users"] })) {
    const u = entry.value as User;
    if (!["member", "vip", "trial"].includes(u.status)) continue;
    try { await bot.api.sendMessage(u.tgId, `📊 <b>Опрос БСП</b>\n\n${pollQuestion}`, { parse_mode: "HTML", reply_markup: kb }); sent++; }
    catch (_e) { /* ignore */ }
    await new Promise(r => setTimeout(r, 100));
  }
  await ctx.reply(`✅ Опрос отправлен ${sent} участникам.`);
}
bot.use(createConversation(pollConv));

// ЕНХ — цифровой формат
async function enhConv(conversation: MyConversation, ctx: MyContext) {
  const u = await getUser(ctx.from!.id);
  if (!u || !["member","vip","trial"].includes(u.status)) {
    await ctx.reply("Раздел доступен участникам БСП."); return;
  }
  await ctx.reply("🤝 <b>Есть / Нужно / Хочу</b>\n\n<b>✅ ЕСТЬ</b> — чем можешь помочь прямо сейчас?",
    { parse_mode: "HTML", reply_markup: cancelKb });
  const есть = await waitText(conversation, ctx);
  if (есть === "❌ Отмена") { await ctx.reply("Отменено.", { reply_markup: memberKb }); return; }

  await ctx.reply("<b>🎯 НУЖНО</b> — какой запрос актуален прямо сейчас?", { parse_mode: "HTML" });
  const нужно = await waitText(conversation, ctx);
  if (нужно === "❌ Отмена") { await ctx.reply("Отменено.", { reply_markup: memberKb }); return; }

  await ctx.reply("<b>💡 ХОЧУ</b> — с кем хочешь познакомиться или к кому хочешь обратиться?", { parse_mode: "HTML" });
  const хочу = await waitText(conversation, ctx);
  if (хочу === "❌ Отмена") { await ctx.reply("Отменено.", { reply_markup: memberKb }); return; }

  const summary = `🤝 <b>ЕНХ от @${ctx.from!.username ?? u.name}</b>\n\n✅ <b>ЕСТЬ:</b> ${есть}\n🎯 <b>НУЖНО:</b> ${нужно}\n💡 <b>ХОЧУ:</b> ${хочу}`;
  const ts = new Date().toISOString();
  await kv.set(["enh", ctx.from!.id, Date.now()], { tgId: ctx.from!.id, есть, нужно, хочу, ts, city: u.city });
  await logEvent(ctx.from!.id, "enh_submitted");
  await ctx.reply(`${summary}\n\n✅ Сохранено! Куратор группы получит уведомление.`, { parse_mode: "HTML", reply_markup: memberKb });
  await notifyAdmins(bot, summary);
}
bot.use(createConversation(enhConv));

// Журнал встречи (для лидеров)
async function meetingLogConv(conversation: MyConversation, ctx: MyContext) {
  if (!hasRole(ctx.from!.id, "leader") && !hasRole(ctx.from!.id, "admin")) {
    await ctx.reply("Доступно только лидерам ячеек."); return;
  }
  const u = await getUser(ctx.from!.id);
  await ctx.reply("📝 <b>Журнал встречи</b>\n\nГород группы:", { parse_mode: "HTML", reply_markup: cancelKb });
  const city = await waitText(conversation, ctx);
  if (city === "❌ Отмена") { await ctx.reply("Отменено."); return; }

  const fmtKb = new Keyboard().text("Десятка (онлайн)").text("Двадцатка (офлайн)").row().text("Малая группа").text("❌ Отмена").resized();
  await ctx.reply("Формат встречи:", { reply_markup: fmtKb });
  const format = await waitText(conversation, ctx);
  if (format === "❌ Отмена") { await ctx.reply("Отменено."); return; }

  await ctx.reply("Количество участников (число):");
  const attendeesRaw = await waitText(conversation, ctx);
  const attendees = parseInt(attendeesRaw) || 0;

  await ctx.reply("Ключевые запросы, которые разбирали (кратко):");
  const requests = await waitText(conversation, ctx);
  if (requests === "❌ Отмена") { await ctx.reply("Отменено."); return; }

  await ctx.reply("Договорённости и следующие шаги:");
  const nextSteps = await waitText(conversation, ctx);
  if (nextSteps === "❌ Отмена") { await ctx.reply("Отменено."); return; }

  const log: MeetingLog = { city, format, attendees, requests, nextSteps, leaderId: ctx.from!.id, ts: new Date().toISOString() };
  await kv.set(["meeting_logs", city, Date.now()], log);
  await logEvent(ctx.from!.id, "meeting_log", `${city} ${format} ${attendees}чел`);
  // Начисляем тайм-кредит лидеру за проведение встречи
  await addTimebankCredits(ctx.from!.id, 2, `Проведение встречи ${format} в ${city}`);
  await ctx.reply(
    `✅ <b>Встреча записана!</b>\n\n📍 ${city} · ${format}\n👥 ${attendees} участников\n🗒 ${requests}\n→ ${nextSteps}\n\n⏰ +2 тайм-кредита начислено!`,
    { parse_mode: "HTML", reply_markup: leaderKb }
  );
  await notifyAdmins(bot, `📝 <b>Встреча ${city}</b> | ${format} | ${attendees}чел\n\nЗапросы: ${requests}\nДоговор: ${nextSteps}`);
}
bot.use(createConversation(meetingLogConv));


// ─── КОМАНДЫ ──────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  const u = ctx.from!;
  const consentKey = ["pd_consent", u.id];
  const hasConsent = (await kv.get<boolean>(consentKey)).value;
  if (!hasConsent) {
    const kb = new InlineKeyboard().text("✅ Согласен на обработку персональных данных", "pd_consent_yes");
    await ctx.reply("Для использования бота необходимо согласие на обработку персональных данных (ФЗ-152).\n\nНажмите кнопку:", { reply_markup: kb });
    return;
  }
  const args = ctx.match;
  let refBy: number|undefined;

  // Deep-link оплата с сайта: /start pay_bsp | pay_bsp_plus | pay_vip
  if (args?.startsWith("pay_")) {
    const tariffKey = args.replace("pay_", "");
    if (tariffKey in TARIFFS) {
      await logEvent(u.id, "deeplink_pay", tariffKey);
      await upsertUser(u.id, u.username ?? "", {
        name: (await getUser(u.id))?.name || u.first_name,
        lastActive: new Date().toISOString(),
        visitCount: ((await getUser(u.id))?.visitCount ?? 0) + 1,
      });
      const [, desc, label] = TARIFFS[tariffKey];
      const invId = await makeInvId(u.id, tariffKey);
      const payUrl = await makePayUrl(u.id, tariffKey, invId);
      if (payUrl) {
        await ctx.reply(
          `💳 <b>${desc}</b>\n<b>${label}</b>\n\nНажми кнопку ниже для оплаты — после получения средств тебе сразу придёт подтверждение.`,
          { parse_mode: "HTML", reply_markup: new InlineKeyboard().url(`💳 Оплатить ${label}`, payUrl) }
        );
      } else {
        await ctx.reply(
          `💳 ${desc} — ${label}\n\nДля оформления напиши куратору: @bcpru`,
          { parse_mode: "HTML" }
        );
      }
      return;
    }
  }

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
  if (visits === 3 && !["member","vip","trial","candidate"].includes(user?.status ?? "")) {
    await ctx.reply(
      `👋 <b>${u.first_name}</b>, ты уже в третий раз заглядываешь!\n\nПредлагаем <b>первый месяц бесплатно</b> — прямо сейчас.\n\nНапиши куратору: @bcpru или нажми «Вступить» 👇`,
      { parse_mode: "HTML", reply_markup: mainKb }
    );
    return;
  }
  const refLink = `https://t.me/${ctx.me.username}?start=ref${u.id}`;
  await ctx.reply(
    `Привет, <b>${u.first_name}</b>! 👋\n\nЭто бот <b>БСП — Бизнес Сообщество Профессионалов</b>.\nПервое в России сообщество для ключевых сотрудников компаний.\n\n🔗 Твоя реф-ссылка: <code>${refLink}</code>\n\nВыбери раздел 👇`,
    { parse_mode: "HTML", reply_markup: mainKb }
  );
});

bot.command("myid", (ctx) => ctx.reply(`Твой Telegram ID: <code>${ctx.from?.id}</code>`, { parse_mode: "HTML" }));

bot.command("profile", async (ctx) => {
  const u = await getUser(ctx.from!.id);
  if (!u) { await ctx.reply("Профиль не найден. Нажми /start"); return; }
  const refs = await countReferrals(u.tgId);
  const tb = await getTimebankBalance(u.tgId);
  await ctx.reply(
    `👤 <b>Мой профиль</b>\n\n` +
    `👤 ${u.name || "—"} | @${u.username || "—"}\n` +
    `🏙 ${u.city || "—"} | 💼 ${u.job || "—"}\n` +
    `📊 ${STATUS_LABELS[u.status] ?? u.status} · 💳 ${u.tariff || "—"}\n` +
    `📅 В БСП с: ${new Date(u.createdAt).toLocaleDateString("ru-RU")}\n` +
    `🎁 Рефералов: ${refs} · ⏰ Таймбанк: ${tb}ч · 📋 ЦДИСН: ${u.notes?.includes("ЦДИСН:") ? "✅" : "❌"}`,
    { parse_mode: "HTML", reply_markup: memberKb }
  );
});

bot.command("find", async (ctx) => {
  const u = await getUser(ctx.from!.id);
  if (!u || !["member","vip","trial"].includes(u.status)) {
    await ctx.reply("Поиск доступен только участникам БСП."); return;
  }
  const query = ctx.match?.toLowerCase().trim();
  if (!query) { await ctx.reply("Использование: /find маркетолог"); return; }
  const found: User[] = [];
  for await (const entry of kv.list({ prefix: ["users"] })) {
    const usr = entry.value as User;
    if (!["member","vip","trial"].includes(usr.status)) continue;
    if (usr.notes?.toLowerCase().includes(query)) found.push(usr);
    if (found.length >= 5) break;
  }
  if (!found.length) { await ctx.reply(`🔍 По запросу «${query}» участников не найдено.`); return; }
  let text = `🔍 <b>По «${query}» нашёл ${found.length} участников:</b>\n\n`;
  for (const usr of found) {
    text += `👤 ${usr.name} | ${usr.job || "—"}, ${usr.city || "—"}`;
    if (usr.username) text += ` | @${usr.username}`;
    text += "\n";
  }
  await ctx.reply(text, { parse_mode: "HTML" });
});

// NEW: Матчинг по навыкам
bot.command("match_me", async (ctx) => {
  const u = await getUser(ctx.from!.id);
  if (!u || !["member","vip","trial"].includes(u.status)) {
    await ctx.reply("Матчинг доступен участникам БСП."); return;
  }
  if (!u.skills?.length) {
    await ctx.reply("Сначала заполни ЦДИСН — навыки нужны для матчинга.\n\nНажми «Мой ЦДИСН» в меню."); return;
  }
  const matches = new Map<number, number>(); // tgId → кол-во совпадений
  for (const skill of u.skills) {
    for await (const entry of kv.list({ prefix: ["by_skill", skill] })) {
      const matchId = entry.key[2] as number;
      if (matchId === u.tgId) continue;
      matches.set(matchId, (matches.get(matchId) ?? 0) + 1);
    }
  }
  const sorted = [...matches.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!sorted.length) { await ctx.reply("Похожих участников пока не нашлось. Расширь ЦДИСН!"); return; }
  let text = `🤝 <b>Похожие участники по навыкам:</b>\n\n`;
  for (const [matchId, count] of sorted) {
    const mu = await getUser(matchId);
    if (!mu) continue;
    text += `👤 ${mu.name} | ${mu.job || "—"}, ${mu.city || "—"}`;
    if (mu.username) text += ` | @${mu.username}`;
    text += ` | совпадений: ${count}\n`;
  }
  await ctx.reply(text, { parse_mode: "HTML" });
  await logEvent(u.tgId, "match_me");
});

bot.command("stats", async (ctx) => {
  if (!hasRole(ctx.from!.id, "stats")) return;
  if (statsCache && Date.now() - statsCache.ts < 60000) {
    await ctx.reply(statsCache.text, { parse_mode: "HTML" }); return;
  }
  const [lead, candidate, trial, member, vip, rejected] = await Promise.all([
    countByStatus("lead"), countByStatus("candidate"), countByStatus("trial"),
    countByStatus("member"), countByStatus("vip"), countByStatus("rejected"),
  ]);
  const total = lead + candidate + trial + member + vip + rejected;
  let newWeek = 0, inactive14 = 0, revenue = 0;
  const weekAgo = Date.now() - 7*24*3600*1000;
  const day14Ago = Date.now() - 14*24*3600*1000;
  for await (const entry of kv.list({ prefix: ["users"] })) {
    const usr = entry.value as User;
    if (new Date(usr.createdAt).getTime() > weekAgo) newWeek++;
    if (["member","vip","trial"].includes(usr.status) && new Date(usr.lastActive).getTime() < day14Ago) inactive14++;
    if (usr.status === "member") revenue += 5000;
    else if (usr.status === "vip") revenue += 40000;
    else if (usr.status === "trial" && usr.tariff === "bsp_plus") revenue += 11000;
  }
  const text =
    `📊 <b>Статистика БСП v4.4.0</b>\n\n` +
    `👥 Всего: <b>${total}</b>\n` +
    `🔵 Лиды: ${lead} · 🟡 Кандидаты: ${candidate}\n` +
    `🟠 Пробные: ${trial} · 🟢 Участники: ${member} · 👑 VIP: ${vip}\n\n` +
    `🆕 Новых за 7 дней: <b>${newWeek}</b>\n` +
    `⚠️ Неактивных 14+ дней: <b>${inactive14}</b>\n` +
    `💰 MRR: <b>~${(revenue/1000).toFixed(0)}k ₽</b>`;
  statsCache = { text, ts: Date.now() };
  await ctx.reply(text, { parse_mode: "HTML" });
});

// NEW: Воронка конверсии
bot.command("funnel", async (ctx) => {
  if (!hasRole(ctx.from!.id, "stats")) return;
  const statuses = ["lead","candidate","trial","member","vip"];
  const counts: Record<string, number> = {};
  for (const s of statuses) counts[s] = await countByStatus(s);
  const total = Object.values(counts).reduce((a,b) => a+b, 0) || 1;
  let text = `📊 <b>Воронка конверсии БСП</b>\n\n`;
  const labels: Record<string, string> = { lead:"🔵 Лиды", candidate:"🟡 Кандидаты", trial:"🟠 Пробные", member:"🟢 Участники", vip:"👑 VIP" };
  let prev = total;
  for (const s of statuses) {
    const n = counts[s];
    const pct = prev > 0 ? Math.round(n/prev*100) : 0;
    text += `${labels[s]}: <b>${n}</b> (${pct}% от предыдущего)\n`;
    prev = n;
  }
  const mrr = counts.member * 5000 + counts.vip * 40000;
  text += `\n💰 MRR: <b>${(mrr/1000).toFixed(0)}k ₽</b>`;
  await ctx.reply(text, { parse_mode: "HTML" });
});

bot.command("cancel", async (ctx) => {
  await ctx.conversation.exit();
  await ctx.reply("Действие отменено.", { reply_markup: mainKb });
});

// FIX: logEvent перед удалением
bot.command("delete_me", async (ctx) => {
  const tgId = ctx.from!.id;
  const u = await getUser(tgId);
  if (!u) { await ctx.reply("Ваши данные не найдены в системе."); return; }
  // FIX: логируем ДО удаления
  await logEvent(tgId, "delete_me", "Full GDPR deletion requested");
  await kv.delete(["users", tgId]);
  await kv.delete(["by_status", u.status, tgId]);
  await kv.delete(["pd_consent", tgId]);
  await kv.delete(["invid", tgId, u.tariff ?? ""]);
  await kv.delete(["unsubscribed", tgId]);
  await kv.delete(["welcome_queue", tgId]);
  await kv.delete(["timebank", tgId]);
  await kv.delete(["checkin_enabled", tgId]);
  if (u.city) await kv.delete(["by_city", u.city, tgId]);
  for (const sk of u.skills ?? []) await kv.delete(["by_skill", sk, tgId]);
  // Удаляем тикеты поддержки
  for await (const entry of kv.list({ prefix: ["support"] })) {
    if ((entry.value as { tgId: number }).tgId === tgId) await kv.delete(entry.key);
  }
  // Удаляем все события
  for await (const entry of kv.list({ prefix: ["events"] })) {
    if ((entry.value as { tgId: number }).tgId === tgId) await kv.delete(entry.key);
  }
  await ctx.reply("✅ Все ваши данные удалены из системы БСП (ФЗ-152 / GDPR).\n\nЕсли захотите вернуться — /start",
    { reply_markup: { remove_keyboard: true } });
});

bot.command("privacy", async (ctx) => { await ctx.reply(PRIVACY_TEXT, { parse_mode: "HTML" }); });

bot.command("rejoin", async (ctx) => {
  const u = ctx.from!;
  const existing = await getUser(u.id);
  if (existing && !["rejected"].includes(existing.status)) {
    await ctx.reply(`У тебя уже есть аккаунт: ${STATUS_LABELS[existing.status] ?? existing.status}.`); return;
  }
  if (!existing) { await ctx.reply("Аккаунт не найден. Пройди /start"); return; }
  await upsertUser(u.id, u.username ?? "", { status: "lead", rejoinAt: new Date().toISOString() });
  await logEvent(u.id, "rejoin");
  await notifyAdmins(bot,
    `🔄 <b>Запрос на восстановление</b>\n\n@${u.username ?? "—"} (${u.id})`,
    new InlineKeyboard().url("💬 Написать", `tg://user?id=${u.id}`));
  await ctx.reply("✅ <b>Запрос принят!</b>\n\nКуратор свяжется в течение дня.", { parse_mode: "HTML", reply_markup: mainKb });
});

bot.command("feedback", async (ctx) => {
  const kb = new InlineKeyboard()
    .text("⭐", "feedback_1").text("⭐⭐", "feedback_2").text("⭐⭐⭐", "feedback_3")
    .text("⭐⭐⭐⭐", "feedback_4").text("⭐⭐⭐⭐⭐", "feedback_5");
  await ctx.reply("⭐ <b>Оцени последнюю встречу</b>\n\n1 — слабо · 5 — отлично",
    { parse_mode: "HTML", reply_markup: kb });
});

bot.command("support", async (ctx) => { await ctx.conversation.enter("supportConv"); });
bot.command("enh", async (ctx) => { await ctx.conversation.enter("enhConv"); });

bot.command("invite_friend", async (ctx) => {
  const u = ctx.from!;
  const count = await countReferrals(u.id);
  const link = `https://t.me/${ctx.me.username}?start=ref${u.id}`;
  const promoActive = new Date() < new Date(PROMO_END_DATE);
  await ctx.reply(
    `🎁 <b>Пригласи коллегу в БСП</b>\n\nТвоя ссылка:\n<code>${link}</code>\n\n💰 <b>+1 000 ₽</b> за каждого вступившего\n🎁 <b>3 реферала</b> = бесплатный месяц БСП+\n\nПриглашено: <b>${count} чел.</b>` +
    (promoActive ? "\n\n🔥 <b>Акция:</b> реферал получает первый месяц в подарок!" : ""),
    { parse_mode: "HTML" }
  );
});

// NEW: Таймбанк
bot.command("give_time", async (ctx) => {
  const u = await getUser(ctx.from!.id);
  if (!u || !["member","vip","trial"].includes(u.status)) {
    await ctx.reply("Таймбанк доступен участникам БСП."); return;
  }
  const parts = (ctx.match ?? "").trim().split(" ");
  if (parts.length < 3) {
    await ctx.reply("Использование: /give_time @username 1 причина\n\nПример: /give_time @ivan_ivanov 1 Провели 1:1 встречу"); return;
  }
  const [usernameRaw, amountRaw, ...reasonParts] = parts;
  const targetUsername = usernameRaw.replace("@", "");
  const amount = parseInt(amountRaw);
  if (isNaN(amount) || amount < 1 || amount > 5) {
    await ctx.reply("Сумма от 1 до 5 тайм-кредитов за раз."); return;
  }
  const reason = reasonParts.join(" ");
  // Ищем получателя
  let target: User|null = null;
  for await (const entry of kv.list({ prefix: ["users"] })) {
    const usr = entry.value as User;
    if (usr.username === targetUsername) { target = usr; break; }
  }
  if (!target) { await ctx.reply(`Участник @${targetUsername} не найден.`); return; }
  // Лимит 3 транзакции в день между одной парой
  const today = new Date().toISOString().slice(0, 10);
  const txCountKey = ["timebank_daily", ctx.from!.id, target.tgId, today];
  const txCount = (await kv.get<number>(txCountKey)).value ?? 0;
  if (txCount >= 3) { await ctx.reply("Максимум 3 транзакции в день с одним участником."); return; }
  await kv.set(txCountKey, txCount + 1, { expireIn: 86400000 });
  try {
    await transferTimebank(ctx.from!.id, target.tgId, amount, reason);
    const newBal = await getTimebankBalance(ctx.from!.id);
    await ctx.reply(`✅ <b>Передано ${amount}ч тайм-кредитов</b> @${targetUsername}\nПричина: ${reason}\n\nТвой баланс: <b>${newBal}ч</b>`, { parse_mode: "HTML" });
    try {
      await bot.api.sendMessage(target.tgId,
        `⏰ <b>Тайм-кредит получен!</b>\n\n@${ctx.from!.username ?? u.name} передал тебе <b>${amount}ч</b>\nПричина: ${reason}\n\nТвой баланс: ${await getTimebankBalance(target.tgId)}ч`,
        { parse_mode: "HTML" });
    } catch (_e) { /* ignore */ }
  } catch (e) {
    await ctx.reply(`❌ ${e instanceof Error ? e.message : "Ошибка транзакции"}`);
  }
});

bot.command("my_balance", async (ctx) => {
  const bal = await getTimebankBalance(ctx.from!.id);
  await ctx.reply(`⏰ <b>Твой баланс таймбанка: ${bal}ч</b>\n\nТайм-кредиты начисляются за:\n• Заполнение ЦДИСН (+1)\n• Проведение встречи (+2)\n• Менторинг участника (+1)\n• Организационный вклад (+1)\n\nПередать кредиты: /give_time @username 1 причина`, { parse_mode: "HTML" });
});

bot.command("timebank_top", async (ctx) => {
  const top: { tgId: number; bal: number; name: string }[] = [];
  for await (const entry of kv.list({ prefix: ["timebank"] })) {
    const tgId = entry.key[1] as number;
    const bal = entry.value as number;
    if (bal <= 0) continue;
    const usr = await getUser(tgId);
    if (!usr || !["member","vip","trial"].includes(usr.status)) continue;
    top.push({ tgId, bal, name: usr.name });
  }
  top.sort((a, b) => b.bal - a.bal);
  if (!top.length) { await ctx.reply("Таймбанк пока пуст — стань первым!"); return; }
  let text = "⏰ <b>Топ таймбанка БСП</b>\n\n";
  const medals = ["🥇","🥈","🥉"];
  for (let i = 0; i < Math.min(10, top.length); i++) {
    text += `${medals[i] || `${i+1}.`} ${top[i].name} — <b>${top[i].bal}ч</b>\n`;
  }
  await ctx.reply(text, { parse_mode: "HTML" });
});

// NEW: Check-in
bot.command("checkin_on", async (ctx) => {
  await kv.set(["checkin_enabled", ctx.from!.id], true);
  await upsertUser(ctx.from!.id, "", { checkinEnabled: true });
  await ctx.reply("✅ <b>Daily check-in включён!</b>\n\nКаждый рабочий день в 9:00 я буду спрашивать твою главную задачу.\n\nОтключить: /checkin_off", { parse_mode: "HTML" });
});

bot.command("checkin_off", async (ctx) => {
  await kv.delete(["checkin_enabled", ctx.from!.id]);
  await upsertUser(ctx.from!.id, "", { checkinEnabled: false });
  await ctx.reply("⏸ Ежедневный check-in отключён.\n\nВключить снова: /checkin_on");
});

// NEW: Прогресс-бар участника
bot.command("my_progress", async (ctx) => {
  const u = await getUser(ctx.from!.id);
  if (!u) { await ctx.reply("Профиль не найден. /start"); return; }
  const refs = await countReferrals(u.tgId);
  const tb = await getTimebankBalance(u.tgId);
  const hasCdisn = u.notes?.includes("ЦДИСН:") ?? false;
  let score = 0;
  if (hasCdisn) score += 30;
  if (refs >= 1) score += 20;
  if (refs >= 3) score += 10;
  if (tb >= 3) score += 20;
  if (u.visitCount >= 5) score += 20;
  let level = "🌱 Новичок";
  if (score >= 80) level = "🏆 Амбассадор";
  else if (score >= 50) level = "⭐ Активный участник";
  else if (score >= 25) level = "✅ Участник";
  const bar = "█".repeat(Math.floor(score/10)) + "░".repeat(10 - Math.floor(score/10));
  await ctx.reply(
    `📈 <b>Мой прогресс в БСП</b>\n\n` +
    `${bar} ${score}/100\n` +
    `Уровень: <b>${level}</b>\n\n` +
    `📋 ЦДИСН: ${hasCdisn ? "✅ заполнен (+30)" : "❌ нет (заполни!)"}\n` +
    `🎁 Рефералов: ${refs} (+${Math.min(30, refs >= 3 ? 30 : refs * 20)})\n` +
    `⏰ Таймбанк: ${tb}ч (+${Math.min(20, tb >= 3 ? 20 : 0)})\n` +
    `👆 Визиты: ${u.visitCount} (+${u.visitCount >= 5 ? 20 : 0})\n\n` +
    (score < 50 ? "💡 Следующий шаг: " + (!hasCdisn ? "заполни ЦДИСН" : refs < 1 ? "пригласи коллегу" : "накопи 3ч таймбанка") : "🎉 Ты активный участник сообщества!"),
    { parse_mode: "HTML" }
  );
});

// NEW: Подготовка к встрече (для лидеров)
bot.command("prep_meeting", async (ctx) => {
  if (!hasRole(ctx.from!.id, "leader") && !hasRole(ctx.from!.id, "admin")) {
    await ctx.reply("Команда доступна лидерам ячеек."); return;
  }
  const fmtKb = new InlineKeyboard()
    .text("📱 Десятка (60 мин)", "prep_desyatka")
    .text("🏢 Двадцатка (90 мин)", "prep_dvadtsatka").row()
    .text("👥 Малая группа (60 мин)", "prep_small");
  await ctx.reply("🗓 <b>Подготовка к встрече</b>\n\nВыбери формат:", { parse_mode: "HTML", reply_markup: fmtKb });
});

// NEW: Разбор запроса по 7 слоям
bot.command("analyze_request", async (ctx) => {
  if (!hasRole(ctx.from!.id, "leader") && !hasRole(ctx.from!.id, "admin")) {
    await ctx.reply("Команда доступна лидерам ячеек."); return;
  }
  const kb = new InlineKeyboard();
  SEVEN_LAYERS.forEach((_, i) => kb.text(String(i+1), `layer_${i+1}`).row());
  await ctx.reply(
    "🔬 <b>Разбор запроса — 7 слоёв</b>\n\nВыбери слой, на котором находится запрос участника:\n\n" +
    SEVEN_LAYERS.join("\n"),
    { parse_mode: "HTML", reply_markup: kb }
  );
});

// NEW: Журнал встречи
bot.command("meeting_log", async (ctx) => {
  await ctx.conversation.enter("meetingLogConv");
});

// NEW: Группа лидера
bot.command("group_members", async (ctx) => {
  if (!hasRole(ctx.from!.id, "leader") && !hasRole(ctx.from!.id, "admin")) {
    await ctx.reply("Команда доступна лидерам ячеек."); return;
  }
  const city = ctx.match?.trim();
  if (!city) { await ctx.reply("Использование: /group_members Москва"); return; }
  const members: User[] = [];
  for await (const entry of kv.list({ prefix: ["by_city", city] })) {
    const tgId = entry.key[2] as number;
    const u = await getUser(tgId);
    if (u && ["member","vip","trial"].includes(u.status)) members.push(u);
  }
  if (!members.length) { await ctx.reply(`Участников в городе "${city}" не найдено.`); return; }
  let text = `👥 <b>Группа ${city} (${members.length} чел.)</b>\n\n`;
  for (const m of members) {
    const days = Math.floor((Date.now() - new Date(m.lastActive).getTime()) / 86400000);
    const hasCdisn = m.notes?.includes("ЦДИСН:") ? "📋" : "❌";
    text += `${hasCdisn} ${m.name} | ${m.job || "—"} | ${days}д назад`;
    if (m.username) text += ` | @${m.username}`;
    text += "\n";
  }
  await ctx.reply(text, { parse_mode: "HTML" });
});

// NEW: Установить расписание встречи
bot.command("set_meeting", async (ctx) => {
  if (!hasRole(ctx.from!.id, "leader") && !hasRole(ctx.from!.id, "admin")) {
    await ctx.reply("Команда доступна лидерам."); return;
  }
  const parts = (ctx.match ?? "").trim().split(" ");
  if (parts.length < 4) {
    await ctx.reply("Использование: /set_meeting <город> <формат> <день_недели> <время>\n\nПример: /set_meeting Москва Десятка Понедельник 18:00"); return;
  }
  const [city, format, weekday, time, ...rest] = parts;
  const zoomLink = rest.join(" ") || undefined;
  const schedule: GroupSchedule = { city, format, weekday, time, zoomLink, leaderId: ctx.from!.id };
  await kv.set(["group_schedule", city], schedule);
  await ctx.reply(`✅ Расписание сохранено!\n\n📍 ${city} · ${format}\n📅 ${weekday} ${time}${zoomLink ? `\n🔗 ${zoomLink}` : ""}`, { parse_mode: "HTML" });
});

bot.command("cron_status", async (ctx) => {
  if (!hasRole(ctx.from!.id, "admin")) return;
  const cronNames = ["member-welcome","inactive-alert","sla-candidates","candidate-followup","leader-alerts","daily-checkin","meeting-reminders"];
  let text = "⚙️ <b>Статус кронов</b>\n\n";
  for (const name of cronNames) {
    const s = (await kv.get<CronStatus>(["cron_status", name])).value;
    if (!s) { text += `• ${name}: <i>нет данных</i>\n`; continue; }
    const icon = s.status === "ok" ? "✅" : s.status === "running" ? "🔄" : "❌";
    const last = s.lastFinished ? new Date(s.lastFinished).toLocaleTimeString("ru-RU") : "—";
    text += `${icon} <b>${name}</b>\n  Последний: ${last} · Обработано: ${s.processed}\n`;
    if (s.lastError) text += `  Ошибка: <i>${s.lastError.slice(0, 60)}</i>\n`;
    text += "\n";
  }
  await ctx.reply(text, { parse_mode: "HTML" });
});

bot.command("weekly_report", async (ctx) => {
  if (!hasRole(ctx.from!.id, "admin") && !hasRole(ctx.from!.id, "stats")) return;
  const weekAgo = Date.now() - 7*24*3600*1000;
  let csv = "tgId,username,name,city,job,status,tariff,visitCount,lastActive,createdAt,refs,timebank\n";
  let active = 0, newThisWeek = 0, inactive = 0;
  for await (const entry of kv.list({ prefix: ["users"] })) {
    const u = entry.value as User;
    const refs = await countReferrals(u.tgId);
    const tb = await getTimebankBalance(u.tgId);
    csv += [u.tgId,u.username,u.name,u.city,u.job,u.status,u.tariff,u.visitCount,u.lastActive,u.createdAt,refs,tb]
      .map(v => `"${v ?? ""}"`).join(",") + "\n";
    if (["member","vip","trial"].includes(u.status)) {
      active++;
      if (new Date(u.lastActive).getTime() <= weekAgo) inactive++;
    }
    if (new Date(u.createdAt).getTime() > weekAgo) newThisWeek++;
  }
  await ctx.reply(`📊 Отчёт: активных ${active}, новых ${newThisWeek}, неактивных ${inactive}`);
  await ctx.replyWithDocument(new Blob([csv], { type: "text/csv" }), { filename: `bsp_weekly_${new Date().toISOString().slice(0,10)}.csv` });
});

bot.command("export_my_data", async (ctx) => {
  const tgId = ctx.from!.id;
  const u = await getUser(tgId);
  if (!u) { await ctx.reply("Данные не найдены."); return; }
  const events: unknown[] = [];
  for await (const entry of kv.list({ prefix: ["events"] })) {
    if ((entry.value as { tgId: number }).tgId === tgId) events.push(entry.value);
  }
  const tb = await getTimebankBalance(tgId);
  const data = { user: u, events, timebankBalance: tb, exportedAt: new Date().toISOString() };
  await ctx.replyWithDocument(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    { filename: `bsp_mydata_${tgId}.json`, caption: "📦 Все ваши данные в системе БСП (GDPR)" });
});

bot.command("poll", async (ctx) => {
  if (!hasRole(ctx.from!.id, "admin")) return;
  await ctx.conversation.enter("pollConv");
});

bot.command("sendnps", async (ctx) => {
  if (!hasRole(ctx.from!.id, "admin")) return;
  const tgId = parseInt(ctx.match ?? "");
  if (isNaN(tgId)) { await ctx.reply("Использование: /sendnps <tg_id>"); return; }
  await sendNPS(tgId);
  await ctx.reply(`✅ NPS отправлен ${tgId}`);
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
    .text("🤝 Пробная встреча", "trial_register");
  await ctx.reply(TARIFFS_TEXT, { parse_mode: "HTML", reply_markup: kb });
});

bot.hears("📞 Контакты", (ctx) => ctx.reply(CONTACTS_TEXT, { parse_mode: "HTML" }));
bot.hears("↩️ Меню", (ctx) => ctx.reply("Главное меню:", { reply_markup: mainKb }));
bot.hears("✍️ Вступить", (ctx) => ctx.conversation.enter("anketa"));
bot.hears("❓ Вопрос куратору", (ctx) => ctx.conversation.enter("question"));

bot.hears("👥 Я участник", async (ctx) => {
  const u = await getUser(ctx.from!.id);
  await upsertUser(ctx.from!.id, u?.username ?? "", { lastActive: new Date().toISOString() });
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

// NEW: ЕНХ через flow
bot.hears("🤝 Есть/Нужно/Хочу", async (ctx) => {
  const u = await getUser(ctx.from!.id);
  if (u && ["member","vip","trial"].includes(u.status)) {
    const kb = new InlineKeyboard()
      .text("📝 Заполнить ЕНХ", "enh_flow")
      .text("📖 Что такое ЕНХ?", "enh_info");
    await ctx.reply("🤝 <b>Есть / Нужно / Хочу</b>", { parse_mode: "HTML", reply_markup: kb });
  } else {
    await ctx.reply(ENH_TEXT, { parse_mode: "HTML" });
  }
});

bot.hears("🎁 Мои рефералы", async (ctx) => {
  const u = ctx.from!;
  const count = await countReferrals(u.id);
  const link = `https://t.me/${ctx.me.username}?start=ref${u.id}`;
  await ctx.reply(
    `🎁 <b>Реферальная программа</b>\n\nТвоя ссылка:\n<code>${link}</code>\n\n💰 <b>+1 000 ₽</b> за каждого вступившего\n🎁 3 реферала = месяц БСП+\n\nПриглашено: <b>${count} чел.</b>`,
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
  await ctx.reply("🔍 <b>Поиск по ЦДИСН</b>\n\n/find маркетолог\n/find финансы\n/match_me — найти похожих автоматически",
    { parse_mode: "HTML" });
});

bot.hears("👤 Мой профиль", async (ctx) => {
  const u = await getUser(ctx.from!.id);
  if (!u) { await ctx.reply("Профиль не найден. /start"); return; }
  const refs = await countReferrals(u.tgId);
  const tb = await getTimebankBalance(u.tgId);
  await ctx.reply(
    `👤 <b>Мой профиль</b>\n\n${u.name || "—"} | @${u.username || "—"}\n🏙 ${u.city || "—"} | 💼 ${u.job || "—"}\n📊 ${STATUS_LABELS[u.status] ?? u.status} · 💳 ${u.tariff || "—"}\n📅 С: ${new Date(u.createdAt).toLocaleDateString("ru-RU")}\n🎁 Рефералов: ${refs} · ⏰ Таймбанк: ${tb}ч`,
    { parse_mode: "HTML", reply_markup: memberKb }
  );
});

// NEW: Кнопки таймбанка и прогресса
bot.hears("⏰ Таймбанк", async (ctx) => {
  const tgId = ctx.from!.id;
  const bal = await getTimebankBalance(tgId);
  const kb = new InlineKeyboard()
    .text("🏆 Топ таймбанка", "tb_top")
    .text("📜 Как заработать?", "tb_help");
  await ctx.reply(
    `⏰ <b>Таймбанк БСП</b>\n\nТвой баланс: <b>${bal}ч</b>\n\nПередать: /give_time @username 1 причина`,
    { parse_mode: "HTML", reply_markup: kb }
  );
});

bot.hears("📈 Мой прогресс", async (ctx) => {
  await ctx.conversation.exit();
  const u = await getUser(ctx.from!.id);
  if (!u) { await ctx.reply("Профиль не найден. /start"); return; }
  const refs = await countReferrals(u.tgId);
  const tb = await getTimebankBalance(u.tgId);
  const hasCdisn = u.notes?.includes("ЦДИСН:") ?? false;
  let score = 0;
  if (hasCdisn) score += 30;
  if (refs >= 1) score += 20;
  if (refs >= 3) score += 10;
  if (tb >= 3) score += 20;
  if (u.visitCount >= 5) score += 20;
  let level = "🌱 Новичок";
  if (score >= 80) level = "🏆 Амбассадор";
  else if (score >= 50) level = "⭐ Активный участник";
  else if (score >= 25) level = "✅ Участник";
  const bar = "█".repeat(Math.floor(score/10)) + "░".repeat(10 - Math.floor(score/10));
  await ctx.reply(
    `📈 <b>Мой прогресс</b>\n\n${bar} ${score}/100\n${level}\n\n📋 ЦДИСН: ${hasCdisn ? "✅" : "❌"} · 🎁 Рефералов: ${refs} · ⏰ ${tb}ч`,
    { parse_mode: "HTML", reply_markup: memberKb }
  );
});

// Кнопки лидера
bot.hears("📝 Журнал встречи", async (ctx) => { await ctx.conversation.enter("meetingLogConv"); });
bot.hears("🗓 Подготовка к встрече", async (ctx) => {
  if (!hasRole(ctx.from!.id, "leader") && !hasRole(ctx.from!.id, "admin")) return;
  const kb = new InlineKeyboard()
    .text("📱 Десятка", "prep_desyatka")
    .text("🏢 Двадцатка", "prep_dvadtsatka").row()
    .text("👥 Малая группа", "prep_small");
  await ctx.reply("🗓 Выбери формат встречи:", { reply_markup: kb });
});
bot.hears("👥 Моя группа", async (ctx) => {
  if (!hasRole(ctx.from!.id, "leader") && !hasRole(ctx.from!.id, "admin")) return;
  await ctx.reply("Использование: /group_members <город>\n\nПример: /group_members Москва");
});
bot.hears("🔬 Разбор запроса", async (ctx) => {
  if (!hasRole(ctx.from!.id, "leader") && !hasRole(ctx.from!.id, "admin")) return;
  await ctx.conversation.exit();
  const kb = new InlineKeyboard();
  SEVEN_LAYERS.forEach((_, i) => kb.text(String(i+1), `layer_${i+1}`).row());
  await ctx.reply("🔬 <b>7 слоёв разбора</b>\n\n" + SEVEN_LAYERS.join("\n"), { parse_mode: "HTML", reply_markup: kb });
});

// ─── CALLBACKS ────────────────────────────────────────────────────────────────

bot.callbackQuery("pd_consent_yes", async (ctx) => {
  await kv.set(["pd_consent", ctx.from!.id], true);
  await ctx.answerCallbackQuery("✅ Согласие принято");
  await ctx.editMessageText("✅ Согласие принято. Добро пожаловать!");
  await ctx.reply("Привет! 👋\n\nЭто бот БСП. Выбери раздел 👇", { reply_markup: mainKb });
});

bot.callbackQuery("ank_start", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.conversation.enter("anketa"); });
bot.callbackQuery("tsdisn_update", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.conversation.enter("tsdisn"); });
bot.callbackQuery("enh_flow", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.conversation.enter("enhConv"); });
bot.callbackQuery("enh_info", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply(ENH_TEXT, { parse_mode: "HTML" }); });

bot.callbackQuery("tb_top", async (ctx) => {
  await ctx.answerCallbackQuery();
  const top: { tgId: number; bal: number; name: string }[] = [];
  for await (const entry of kv.list({ prefix: ["timebank"] })) {
    const tgId = entry.key[1] as number;
    const bal = entry.value as number;
    if (bal <= 0) continue;
    const usr = await getUser(tgId);
    if (!usr || !["member","vip","trial"].includes(usr.status)) continue;
    top.push({ tgId, bal, name: usr.name });
  }
  top.sort((a,b) => b.bal - a.bal);
  let text = "⏰ <b>Топ таймбанка</b>\n\n";
  ["🥇","🥈","🥉"].forEach((m,i) => { if (top[i]) text += `${m} ${top[i].name} — ${top[i].bal}ч\n`; });
  for (let i = 3; i < Math.min(10, top.length); i++) text += `${i+1}. ${top[i].name} — ${top[i].bal}ч\n`;
  if (!top.length) text += "Пока пусто — стань первым!";
  await ctx.reply(text, { parse_mode: "HTML" });
});

bot.callbackQuery("tb_help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("⏰ <b>Как заработать тайм-кредиты?</b>\n\n+1ч — Заполнить ЦДИСН\n+2ч — Провести встречу (лидер)\n+1ч — Получить тайм-кредит от другого участника\n+1ч — Организовать мероприятие\n\nПередать кредит: /give_time @username 1 причина", { parse_mode: "HTML" });
});

bot.callbackQuery("trial_register", async (ctx) => {
  const u = ctx.from;
  const existing = await getUser(u.id);
  if (existing && ["member","vip"].includes(existing.status)) {
    await ctx.answerCallbackQuery("✅ Ты уже участник!");
    await ctx.reply("✅ <b>Ты уже участник БСП!</b>", { parse_mode: "HTML", reply_markup: memberKb }); return;
  }
  await ctx.answerCallbackQuery("✅ Записываю!");
  if (!existing || existing.status === "lead") await upsertUser(u.id, u.username ?? "", { status: "trial" });
  await ctx.reply("✅ <b>Записан на пробную Десятку!</b>\n\nКуратор свяжется в течение дня. @bcpru", { parse_mode: "HTML", reply_markup: mainKb });
  await notifyAdmins(bot, `🔔 <b>Запись на пробную!</b>\n@${u.username ?? "—"} (${u.id})`,
    new InlineKeyboard().url("💬 Написать", `tg://user?id=${u.id}`));
});

bot.callbackQuery(/^nps_(\d+)$/, async (ctx) => {
  const score = parseInt(ctx.match[1]);
  await ctx.answerCallbackQuery("Спасибо! 🙏");
  await kv.set(["nps", Date.now(), ctx.from.id], { tgId: ctx.from.id, score, ts: new Date().toISOString() });
  await logEvent(ctx.from.id, "nps", String(score));
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  const comment = score >= 9 ? "Рады, что встреча была ценной! 💙" : score >= 7 ? "Спасибо! Есть идеи — пиши @bcpru" : "Жаль. Напиши куратору @bcpru";
  await ctx.reply(`Оценка <b>${score}/10</b>. ${comment}`, { parse_mode: "HTML" });
  await notifyAdmins(bot, `⭐ NPS от @${ctx.from.username ?? ctx.from.id}: <b>${score}/10</b>`);
});

bot.callbackQuery(/^feedback_(\d)$/, async (ctx) => {
  const stars = parseInt(ctx.match[1]);
  await ctx.answerCallbackQuery(`${stars} ⭐ принято!`);
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  await kv.set(["feedback", Date.now(), ctx.from.id], { tgId: ctx.from.id, stars, ts: new Date().toISOString() });
  await logEvent(ctx.from.id, "feedback", String(stars));
  await ctx.reply(`${"⭐".repeat(stars)} Спасибо за оценку!`);
  if (stars <= 2) await notifyAdmins(bot, `⚠️ <b>Низкая оценка!</b> @${ctx.from.username ?? ctx.from.id}: ${stars}/5`);
  // Начисляем кредит за обратную связь
  await addTimebankCredits(ctx.from.id, 1, "Оценка встречи");
});

bot.callbackQuery(/^poll_vote_(.+)_(\d+)$/, async (ctx) => {
  const pollId = ctx.match[1]; const optIdx = parseInt(ctx.match[2]); const tgId = ctx.from.id;
  const poll = (await kv.get<Poll>(["polls", pollId])).value;
  if (!poll) { await ctx.answerCallbackQuery("Опрос не найден."); return; }
  if (poll.voters.includes(tgId)) { await ctx.answerCallbackQuery("Уже проголосовали!"); return; }
  poll.voters.push(tgId); poll.votes[optIdx] = (poll.votes[optIdx] ?? 0) + 1;
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
  const url = await makePayUrl(ctx.from.id, key, invId);
  if (url) {
    await ctx.reply(`💳 <b>${desc}</b>\n<b>${label}</b>\n\nНажми для оплаты:`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().url(`💳 Оплатить ${label}`, url) });
  } else {
    await ctx.reply(`💳 ${desc} — ${label}\n\nДля оплаты: @bcpru`, { parse_mode: "HTML" });
  }
});

bot.callbackQuery(/^admin_accept_(\d+)$/, async (ctx) => {
  if (!hasRole(ctx.from.id, "admin")) return ctx.answerCallbackQuery("Нет доступа");
  await ctx.answerCallbackQuery("✅ Принято");
  const tgId = parseInt(ctx.match[1]);
  await changeStatus(tgId, "candidate");
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  try { await bot.api.sendMessage(tgId, "✅ <b>Заявка одобрена!</b>\n\nКуратор свяжется в течение дня. @bcpru", { parse_mode: "HTML" }); }
  catch (_e) { /* ignore */ }
});

bot.callbackQuery(/^adm_list_(.+)$/, async (ctx) => {
  if (!hasRole(ctx.from.id, "admin")) return ctx.answerCallbackQuery("Нет доступа");
  await ctx.answerCallbackQuery();
  const rows = await listByStatus(ctx.match[1]);
  if (!rows.length) { await ctx.reply(`Нет пользователей со статусом «${ctx.match[1]}»`); return; }
  let text = `<b>${ctx.match[1]} (${rows.length} чел.)</b>\n\n`;
  for (const r of rows) {
    const days = Math.floor((Date.now() - new Date(r.lastActive).getTime()) / 86400000);
    text += `• ${r.name || "—"} | ${r.city || "—"} | @${r.username || r.tgId} | ${days}д\n`;
  }
  await ctx.reply(text, { parse_mode: "HTML" });
});

bot.callbackQuery("adm_export", async (ctx) => {
  if (!hasRole(ctx.from.id, "admin")) return ctx.answerCallbackQuery("Нет доступа");
  await ctx.answerCallbackQuery("Формирую...");
  let csv = "tgId,username,name,city,job,status,tariff,visitCount,lastActive,createdAt\n";
  for await (const entry of kv.list({ prefix: ["users"] })) {
    const u = entry.value as User;
    csv += [u.tgId,u.username,u.name,u.city,u.job,u.status,u.tariff,u.visitCount,u.lastActive,u.createdAt]
      .map(v => `"${v ?? ""}"`).join(",") + "\n";
  }
  await ctx.replyWithDocument(new Blob([csv], { type: "text/csv" }), { filename: `bsp_${Date.now()}.csv` });
});

bot.callbackQuery("unsubscribe", async (ctx) => {
  await kv.set(["unsubscribed", ctx.from!.id], true);
  await ctx.answerCallbackQuery("✅ Отписались");
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
});

// Подготовка к встрече callbacks
bot.callbackQuery(/^prep_(desyatka|dvadtsatka|small)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const type = ctx.match[1];
  const templates: Record<string, string> = {
    desyatka: `📱 <b>Сценарий Десятки (60 мин)</b>\n\n0:00–0:10 Открытие · Правила конфиденциальности\n0:10–0:20 Знакомство по кругу (60 сек каждый)\n0:20–0:35 Обучение (ротация спикера)\n0:35–0:55 Разбор кейса по 7 слоям\n0:55–1:05 ЕНХ — Есть/Нужно/Хочу\n1:05–1:10 Закрытие + признание`,
    dvadtsatka: `🏢 <b>Сценарий Двадцатки (90 мин)</b>\n\n0:00–0:15 Нетворкинг при входе\n0:15–0:25 Открытие · Правила\n0:25–0:45 Круговые представления (90 сек)\n0:45–1:10 Тематический разбор · Разбивка по мини-группам\n1:10–1:25 Обмен инсайтами\n1:25–1:30 Закрытие + договорённости`,
    small: `👥 <b>Сценарий малой группы (60 мин)</b>\n\n0:00–0:05 Открытие\n0:05–0:20 ЕНХ каждого участника\n0:20–0:50 Глубокий разбор 1–2 запросов\n0:50–1:00 Договорённости и следующие шаги`,
  };
  const icebreakers = [
    "❓ Ледокол: «Какой навык ты хочешь прокачать в этом году?»",
    "❓ Ледокол: «Чем ты занимался профессионально 5 лет назад?»",
    "❓ Ледокол: «Назови книгу, которая изменила твой подход к работе»",
  ];
  const ice = icebreakers[Math.floor(Math.random() * icebreakers.length)];
  await ctx.reply(`${templates[type]}\n\n${ice}\n\n💡 Использовать /analyze_request для разбора по 7 слоям\n📝 После встречи — /meeting_log`, { parse_mode: "HTML" });
});

// Разбор по 7 слоям
bot.callbackQuery(/^layer_(\d)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const idx = parseInt(ctx.match[1]) - 1;
  const layer = SEVEN_LAYERS[idx];
  const questions: Record<number, string[]> = {
    0: ["Что именно делаешь каждый день?","Как измеряешь результат своих действий?","Что из того, что делаешь, можно не делать?"],
    1: ["Какие инструменты используешь и как давно?","Есть ли инструменты, которые хотел бы внедрить?","Что мешает автоматизировать рутину?"],
    2: ["Ты управляешь или исполняешь стратегию?","Кто принимает финальное решение по твоим инициативам?","Как твоя роль связана с целями компании?"],
    3: ["Кто твой ключевой клиент внутри или снаружи?","Как ты отслеживаешь изменения в своей нише?","Есть ли незакрытая потребность рынка, которую ты видишь?"],
    4: ["Кто твои ключевые союзники внутри компании?","Какое партнёрство тебе нужно для роста?","Чьё мнение влияет на решения без официальных полномочий?"],
    5: ["Кто в команде тебя удивляет в хорошем смысле?","Где ты видишь конфликт, который не решается?","Как ты делегируешь — через задачи или через доверие?"],
    6: ["Что тебя останавливает от следующего шага?","Какое решение ты откладываешь и почему?","Какой страх или убеждение мешает расти?"],
  };
  const qs = questions[idx] ?? [];
  await ctx.reply(
    `🔬 <b>Слой ${idx+1}: ${layer}</b>\n\nВопросы для разбора:\n\n• ${qs.join("\n• ")}\n\n💡 Правило: задай 1–2 вопроса, дай участнику говорить.`,
    { parse_mode: "HTML" }
  );
});

// ─── ADMIN КОМАНДЫ ────────────────────────────────────────────────────────────
bot.command("admin", async (ctx) => {
  if (!hasRole(ctx.from!.id, "admin")) return;
  const statuses = ["lead","candidate","trial","member","vip"];
  const counts: Record<string, number> = {};
  for (const s of statuses) counts[s] = await countByStatus(s);
  const total = Object.values(counts).reduce((a,b) => a+b, 0);
  const kb = new InlineKeyboard()
    .text("📋 Лиды", "adm_list_lead").text("🟡 Кандидаты", "adm_list_candidate").row()
    .text("🟢 Участники", "adm_list_member").text("👑 VIP", "adm_list_vip").row()
    .text("📊 Экспорт CSV", "adm_export");
  await ctx.reply(
    `🛠 <b>Админ-панель БСП v4.4.0</b>\n\nВсего: <b>${total}</b>\n🔵 Лиды: ${counts.lead} · 🟡 Кандидаты: ${counts.candidate}\n🟠 Пробные: ${counts.trial} · 🟢 Участники: ${counts.member} · 👑 VIP: ${counts.vip}\n\nКоманды: /stats · /funnel · /weekly_report · /poll\n/setmember · /setstatus · /cron_status\n/group_members <город> · /set_meeting`,
    { parse_mode: "HTML", reply_markup: kb }
  );
});

bot.command("setmember", async (ctx) => {
  if (!hasRole(ctx.from!.id, "admin")) return;
  const parts = ctx.match?.split(" ") ?? [];
  if (parts.length < 2) { await ctx.reply("Использование: /setmember <tg_id> <bsp|bsp_plus|vip>"); return; }
  const tgId = parseInt(parts[0]); const tariff = parts[1];
  await upsertUser(tgId, "", { status: "member", tariff });
  await changeStatus(tgId, "member");
  statsCache = null;
  await ctx.reply(`✅ ${tgId} → участник (${tariff})`);
  await kv.set(["welcome_queue", tgId], { step: 0, nextAt: Date.now() + 5000 });
  try { await bot.api.sendMessage(tgId, "👇 Меню участника:", { reply_markup: memberKb }); } catch (_e) { /* */ }
});

bot.command("setstatus", async (ctx) => {
  if (!hasRole(ctx.from!.id, "admin")) return;
  const parts = ctx.match?.split(" ") ?? [];
  if (parts.length < 2) { await ctx.reply("Использование: /setstatus <tg_id> <status>\nДопустимые: " + VALID_STATUSES.join(", ")); return; }
  const tgId = parseInt(parts[0]); const newStatus = parts[1];
  if (!VALID_STATUSES.includes(newStatus)) { await ctx.reply(`Недопустимый статус. Допустимые: ${VALID_STATUSES.join(", ")}`); return; }
  // Подтверждение через inline
  const kb = new InlineKeyboard()
    .text("✅ Подтвердить", `confirm_status_${tgId}_${newStatus}`)
    .text("❌ Отмена", "cancel_status");
  await ctx.reply(`Изменить статус пользователя <code>${tgId}</code> на <b>${newStatus}</b>?`, { parse_mode: "HTML", reply_markup: kb });
});

bot.callbackQuery(/^confirm_status_(\d+)_(.+)$/, async (ctx) => {
  if (!hasRole(ctx.from.id, "admin")) return ctx.answerCallbackQuery("Нет доступа");
  const tgId = parseInt(ctx.match[1]); const newStatus = ctx.match[2];
  await changeStatus(tgId, newStatus); statsCache = null;
  await ctx.answerCallbackQuery("✅ Статус обновлён");
  await ctx.editMessageText(`✅ Статус <code>${tgId}</code> → <b>${newStatus}</b>`, { parse_mode: "HTML" });
});
bot.callbackQuery("cancel_status", async (ctx) => {
  await ctx.answerCallbackQuery("Отменено");
  await ctx.editMessageText("Отменено.");
});


// ─── CRON JOBS ────────────────────────────────────────────────────────────────

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
        await kv.delete(["welcome_queue", tgId]); continue;
      }
      try {
        await bot.api.sendMessage(tgId, WELCOME_STEPS[step],
          { parse_mode: "HTML", reply_markup: step === WELCOME_STEPS.length-1 ? memberKb : undefined });
        const nextStep = step + 1;
        if (nextStep < WELCOME_STEPS.length) {
          await kv.set(["welcome_queue", tgId], { step: nextStep, nextAt: now + WELCOME_DELAYS[nextStep] });
        } else {
          await kv.delete(["welcome_queue", tgId]);
        }
        processed++;
      } catch (e) {
        errors++; log("WARN", "welcome_send_fail", { tgId, error: String(e) });
        await kv.delete(["welcome_queue", tgId]);
      }
    }
  } catch (e) { await cronError("member-welcome", e); return; }
  await cronEnd("member-welcome", processed, errors);
});

// Алерт о неактивных участниках
Deno.cron("inactive-alert", "0 9 * * *", async () => {
  await cronStart("inactive-alert");
  try {
    const day14Ago = Date.now() - 14*24*3600*1000;
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
      if (inactive.length > 10) text += `...и ещё ${inactive.length - 10} чел.`;
      await notifyAdmins(bot, text);
    }
    await cronEnd("inactive-alert", inactive.length, 0);
  } catch (e) { await cronError("inactive-alert", e); }
});

// SLA: кандидат без ответа >4 ч
Deno.cron("sla-candidates", "*/30 * * * *", async () => {
  await cronStart("sla-candidates");
  try {
    const h4ago = Date.now() - 4*3600*1000;
    const stale: User[] = [];
    for await (const entry of kv.list({ prefix: ["by_status", "candidate"] })) {
      const tgId = entry.key[2] as number;
      const u = await getUser(tgId);
      if (!u) continue;
      if (new Date(u.updatedAt).getTime() < h4ago) stale.push(u);
    }
    if (stale.length) {
      let text = `⏰ <b>SLA-алерт: ${stale.length} кандидатов без ответа >4ч!</b>\n\n`;
      for (const u of stale.slice(0, 10)) {
        const hrs = Math.floor((Date.now() - new Date(u.updatedAt).getTime()) / 3600000);
        text += `• ${u.name || "—"} | @${u.username || u.tgId} | ${hrs}ч\n`;
      }
      await notifyAdmins(bot, text);
    }
    await cronEnd("sla-candidates", stale.length, 0);
  } catch (e) { await cronError("sla-candidates", e); }
});

// А-4: Followup для кандидатов (48ч / 5д / 10д) — РЕАЛИЗОВАНО
Deno.cron("candidate-followup", "0 10 * * *", async () => {
  await cronStart("candidate-followup");
  let processed = 0, errors = 0;
  try {
    const now = Date.now();
    for await (const entry of kv.list({ prefix: ["by_status", "candidate"] })) {
      const tgId = entry.key[2] as number;
      const u = await getUser(tgId);
      if (!u) continue;
      const step = u.followUpStep ?? 0;
      if (step >= FOLLOWUP_MESSAGES.length) continue;
      const msg = FOLLOWUP_MESSAGES[step];
      const createdMs = new Date(u.createdAt).getTime();
      if (now < createdMs + msg.delay) continue;
      try {
        const isUnsubscribed = (await kv.get<boolean>(["unsubscribed", tgId])).value;
        if (isUnsubscribed) continue;
        await bot.api.sendMessage(tgId, msg.text, { parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("🔕 Не беспокоить", "unsubscribe") });
        await upsertUser(tgId, u.username, { followUpStep: step + 1 });
        await logEvent(tgId, "followup_sent", String(step + 1));
        processed++;
      } catch (e) {
        errors++; log("WARN", "followup_fail", { tgId, error: String(e) });
      }
    }
  } catch (e) { await cronError("candidate-followup", e); return; }
  await cronEnd("candidate-followup", processed, errors);
});

// Л-5: Алерты лидера
Deno.cron("leader-alerts", "30 9 * * *", async () => {
  await cronStart("leader-alerts");
  let processed = 0;
  try {
    const day7Ago = Date.now() - 7*24*3600*1000;
    // Для каждого лидера — проверяем участников его города
    for (const leaderId of [...ADMIN_IDS, ...LEADER_IDS]) {
      const leaderUser = await getUser(leaderId);
      if (!leaderUser?.groupCity) continue;
      const city = leaderUser.groupCity;
      const inactive: User[] = [];
      for await (const entry of kv.list({ prefix: ["by_city", city] })) {
        const tgId = entry.key[2] as number;
        const u = await getUser(tgId);
        if (!u || !["member","vip","trial"].includes(u.status)) continue;
        if (new Date(u.lastActive).getTime() < day7Ago) inactive.push(u);
      }
      if (inactive.length) {
        let text = `👀 <b>Алерт лидера — ${city}</b>\n\nНеактивных 7+ дней: <b>${inactive.length} чел.</b>\n\n`;
        for (const u of inactive.slice(0, 5)) {
          const days = Math.floor((Date.now() - new Date(u.lastActive).getTime()) / 86400000);
          text += `• ${u.name} | @${u.username || u.tgId} | ${days}д\n`;
        }
        text += "\n💡 Напиши им лично — это поднимет посещаемость!";
        try { await bot.api.sendMessage(leaderId, text, { parse_mode: "HTML" }); processed++; }
        catch (_e) { /* ignore */ }
      }
      // Проверяем была ли встреча за 14 дней
      const day14Ago = Date.now() - 14*24*3600*1000;
      let lastMeetingTs = 0;
      for await (const entry of kv.list({ prefix: ["meeting_logs", city] })) {
        const ml = entry.value as MeetingLog;
        const ts = new Date(ml.ts).getTime();
        if (ts > lastMeetingTs) lastMeetingTs = ts;
      }
      if (lastMeetingTs < day14Ago) {
        try {
          await bot.api.sendMessage(leaderId, `📅 <b>В ${city} не было встречи 14+ дней!</b>\n\nВремя собираться 💪\nИспользуй /set_meeting для планирования.`,
            { parse_mode: "HTML" });
        } catch (_e) { /* ignore */ }
      }
    }
    await cronEnd("leader-alerts", processed, 0);
  } catch (e) { await cronError("leader-alerts", e); }
});

// В-2: Daily check-in (только opt-in, пн–пт 09:00)
Deno.cron("daily-checkin", "0 9 * * 1-5", async () => {
  await cronStart("daily-checkin");
  let processed = 0, errors = 0;
  try {
    const kb = new InlineKeyboard()
      .text("✅ Главное сделано!", "checkin_done")
      .text("⚠️ Затрудняюсь", "checkin_hard");
    for await (const entry of kv.list({ prefix: ["checkin_enabled"] })) {
      const tgId = entry.key[1] as number;
      const enabled = entry.value as boolean;
      if (!enabled) continue;
      const u = await getUser(tgId);
      if (!u || !["member","vip","trial"].includes(u.status)) continue;
      try {
        const dayName = ["","Понедельник","Вторник","Среда","Четверг","Пятница"][new Date().getDay()];
        await bot.api.sendMessage(tgId,
          `☀️ <b>Доброе утро, ${u.name?.split(" ")[0] || "коллега"}!</b>\n\n${dayName}. Один вопрос:\n\n<b>Что твоя главная задача на сегодня?</b>\n\nОтветь текстом или нажми кнопку:`,
          { parse_mode: "HTML", reply_markup: kb });
        processed++;
      } catch (e) { errors++; log("WARN", "checkin_fail", { tgId, error: String(e) }); }
      await new Promise(r => setTimeout(r, 200));
    }
    await cronEnd("daily-checkin", processed, errors);
  } catch (e) { await cronError("daily-checkin", e); }
});

// В-5: Напоминания о встречах
Deno.cron("meeting-reminders", "0 * * * *", async () => {
  await cronStart("meeting-reminders");
  let processed = 0;
  try {
    const now = new Date();
    const weekdayNames = ["Воскресенье","Понедельник","Вторник","Среда","Четверг","Пятница","Суббота"];
    const todayName = weekdayNames[now.getDay()];
    const tomorrowName = weekdayNames[(now.getDay() + 1) % 7];
    const currentHour = now.getHours();

    for await (const entry of kv.list({ prefix: ["group_schedule"] })) {
      const sched = entry.value as GroupSchedule;
      const [schedHour] = sched.time.split(":").map(Number);
      // Напоминание за 24ч (если сегодня = завтра встречи)
      if (sched.weekday === tomorrowName && currentHour === schedHour) {
        for await (const uEntry of kv.list({ prefix: ["by_city", sched.city] })) {
          const tgId = uEntry.key[2] as number;
          const u = await getUser(tgId);
          if (!u || !["member","vip","trial"].includes(u.status)) continue;
          try {
            await bot.api.sendMessage(tgId,
              `📅 <b>Завтра встреча!</b>\n\n${sched.format} · ${sched.city}\n⏰ ${sched.weekday} ${sched.time}${sched.zoomLink ? `\n🔗 ${sched.zoomLink}` : ""}\n\n💡 Подготовь запрос в формате Есть/Нужно/Хочу: /enh`,
              { parse_mode: "HTML" });
            processed++;
          } catch (_e) { /* ignore */ }
          await new Promise(r => setTimeout(r, 100));
        }
      }
      // Напоминание за 1ч (день встречи, час до начала)
      if (sched.weekday === todayName && currentHour === schedHour - 1) {
        for await (const uEntry of kv.list({ prefix: ["by_city", sched.city] })) {
          const tgId = uEntry.key[2] as number;
          const u = await getUser(tgId);
          if (!u || !["member","vip","trial"].includes(u.status)) continue;
          try {
            await bot.api.sendMessage(tgId,
              `⏰ <b>Встреча через час!</b>\n\n${sched.format} · ${sched.city} · ${sched.time}${sched.zoomLink ? `\n🔗 <a href="${sched.zoomLink}">Открыть ссылку</a>` : ""}`,
              { parse_mode: "HTML" });
            processed++;
          } catch (_e) { /* ignore */ }
          await new Promise(r => setTimeout(r, 100));
        }
      }
    }
    await cronEnd("meeting-reminders", processed, 0);
  } catch (e) { await cronError("meeting-reminders", e); }
});

// Check-in callbacks
bot.callbackQuery("checkin_done", async (ctx) => {
  await ctx.answerCallbackQuery("💪 Отлично!");
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  await kv.set(["checkin_log", ctx.from.id, Date.now()], { status: "done", ts: new Date().toISOString() });
  await ctx.reply("✅ Отлично! Удачного дня!\n\nВечером проверь — сделано ли главное? 💪");
});

bot.callbackQuery("checkin_hard", async (ctx) => {
  await ctx.answerCallbackQuery("Разберёмся!");
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  await kv.set(["checkin_log", ctx.from.id, Date.now()], { status: "hard", ts: new Date().toISOString() });
  await ctx.reply("Понял. Если нужна помощь — используй /enh чтобы сформулировать запрос для группы.\n\nИли напиши куратору: @bcpru");
});

// ─── WEBHOOK + HTTP ───────────────────────────────────────────────────────────
const handleUpdate = webhookCallback(bot, "std/http");

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname === "/health") {
    const cronNames = ["member-welcome","inactive-alert","sla-candidates","candidate-followup","leader-alerts","daily-checkin","meeting-reminders"];
    const cronStatuses: Record<string, string> = {};
    for (const name of cronNames) {
      const s = (await kv.get<CronStatus>(["cron_status", name])).value;
      cronStatuses[name] = s?.status ?? "unknown";
    }
    return new Response(JSON.stringify({ status: "ok", version: "4.4.0", ts: new Date().toISOString(), crons: cronStatuses }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  }

  if (url.pathname === "/") return new Response("БСП Bot v4.4.0 ✅", { status: 200 });

  if (url.pathname === `/${WEBHOOK_SECRET}`) {
    if (TG_SECRET_TOKEN) {
      const header = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (header !== TG_SECRET_TOKEN) return new Response("Forbidden", { status: 403 });
    }
    return handleUpdate(req);
  }

  if (url.pathname === "/robokassa/result") {
    try {
      const p = url.searchParams;
      const outSum  = p.get("OutSum") ?? "";
      const invId   = p.get("InvId") ?? "";
      const tgIdParam = p.get("Shp_tgId") ?? "";
      const tariff  = p.get("Shp_tariff") ?? "";
      const sig     = p.get("SignatureValue") ?? "";
      const tgId    = parseInt(tgIdParam);
      const isWebPayment = tgIdParam === "0" || !tgIdParam;
      if ((!tgId && !isWebPayment) || !(tariff in TARIFFS)) {
        log("WARN", "robokassa_bad_params", { outSum, invId, tariff });
        return new Response("Bad params", { status: 400 });
      }
      if (ROBOKASSA_PASS2 && !(await withRetry(() => verifyRobokassaSig(outSum, invId, sig, isWebPayment ? "0" : tgIdParam, tariff)))) {
        if (!isWebPayment) await logEvent(tgId, "payment_sig_fail", `inv=${invId}`);
        return new Response("Bad signature", { status: 403 });
      }
      if (!isWebPayment) {
        await changeStatus(tgId, "member");
        await upsertUser(tgId, "", { tariff, status: "member" });
        await logEvent(tgId, "payment", `${tariff} ${outSum}₽ inv=${invId}`);
        statsCache = null;
        await kv.set(["welcome_queue", tgId], { step: 0, nextAt: Date.now() });
        await kv.delete(["invid", tgId, tariff]);
        await kv.delete(["invid_reverse", parseInt(invId)]);
        // Начисляем тайм-кредит за вступление
        await addTimebankCredits(tgId, 1, "Вступление в БСП");
        try {
          await bot.api.sendMessage(tgId,
            `✅ <b>Оплата получена!</b>\nДобро пожаловать! Тариф: ${TARIFFS[tariff]?.[2] ?? tariff}\n\n⏰ Тебе начислен 1 тайм-кредит за вступление!`,
            { parse_mode: "HTML", reply_markup: memberKb });
        } catch (_e) { /* ignore */ }
      }
      await notifyAdmins(bot, `💰 Оплата${isWebPayment ? " (сайт)" : ` tg:${tgId}`}: ${tariff} | ${outSum} ₽ | inv=${invId}`);
      return new Response(`OK${invId}`, { status: 200 });
    } catch (e) {
      log("ERROR", "robokassa_handler_error", { error: String(e) });
      return new Response("Error", { status: 400 });
    }
  }

  // ─── /pay — прямая оплата с сайта без Telegram ────────────────────────────
  if (url.pathname === "/pay") {
    const plan = url.searchParams.get("plan") ?? "";
    if (!(plan in TARIFFS)) {
      return new Response("Неверный тариф", { status: 400 });
    }
    if (!ROBOKASSA_LOGIN || !ROBOKASSA_PASS1) {
      return new Response("Оплата временно недоступна. Попробуйте позже.", { status: 503 });
    }
    const [amount, desc] = TARIFFS[plan];
    const outSum = `${amount}.00`;
    // Генерируем случайный InvId (200000–899999)
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    const invId = 200000 + (arr[0] % 700000);
    // Подпись: MrchLogin:OutSum:InvId:Pass1:Shp_tariff=X:Shp_tgId=0
    const shpStr = `Shp_tariff=${plan}:Shp_tgId=0`;
    const sig = await md5Hex(`${ROBOKASSA_LOGIN}:${outSum}:${invId}:${ROBOKASSA_PASS1}:${shpStr}`);
    const params = new URLSearchParams({
      MrchLogin: ROBOKASSA_LOGIN, OutSum: outSum, InvId: String(invId),
      Desc: desc, SignatureValue: sig,
      Shp_tgId: "0", Shp_tariff: plan,
    });
    log("INFO", "web_pay_redirect", { plan, invId });
    return new Response(null, {
      status: 302,
      headers: { "Location": `https://auth.robokassa.ru/Merchant/Index.aspx?${params}` },
    });
  }

  return new Response("Not Found", { status: 404 });
});

log("INFO", "bot_started", { version: "4.6.0" });
