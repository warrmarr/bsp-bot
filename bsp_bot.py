"""
БСП — Telegram Bot v2.0
Полнофункциональный бот для Бизнес Сообщества Профессионалов
"""

import os
import sqlite3
import logging
import hashlib
import urllib.parse
from datetime import datetime, timedelta
from telegram import (
    Update, InlineKeyboardButton, InlineKeyboardMarkup,
    ReplyKeyboardMarkup, KeyboardButton
)
from telegram.ext import (
    Application, CommandHandler, MessageHandler,
    CallbackQueryHandler, ConversationHandler,
    filters, ContextTypes
)

# ─────────────────────────────────────────
#  НАСТРОЙКИ
# ─────────────────────────────────────────
BOT_TOKEN = os.getenv("BOT_TOKEN", "8612916375:AAFROLGqU5eHcj3AI_WOt5q_baRD1BMp3jc")
ADMIN_IDS  = [int(x) for x in os.getenv("ADMIN_IDS", "182991647").split(",") if x]

ROBOKASSA_LOGIN = os.getenv("ROBOKASSA_LOGIN", "")
ROBOKASSA_PASS1 = os.getenv("ROBOKASSA_PASS1", "")

TARIFF_PRICES = {
    "bsp":      (5000,  "Членский взнос БСП",      "5 000 ₽/мес"),
    "bsp_plus": (11000, "Членский взнос БСП+",     "11 000 ₽/мес"),
    "vip":      (40000, "Членский взнос VIP",       "40 000 ₽/мес"),
}

logging.basicConfig(format="%(asctime)s [%(levelname)s] %(message)s", level=logging.INFO)
log = logging.getLogger(__name__)

# ─────────────────────────────────────────
#  БАЗА ДАННЫХ
# ─────────────────────────────────────────
def init_db():
    db = sqlite3.connect("bsp_crm.db")
    db.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            tg_id       INTEGER UNIQUE,
            username    TEXT,
            name        TEXT,
            city        TEXT,
            job         TEXT,
            company     TEXT,
            source      TEXT,
            phone       TEXT,
            status      TEXT DEFAULT 'lead',
            tariff      TEXT,
            curator     TEXT,
            ref_code    TEXT,
            ref_by      INTEGER,
            ref_bonus   INTEGER DEFAULT 0,
            notes       TEXT,
            created_at  TEXT,
            updated_at  TEXT
        )""")
    db.execute("""
        CREATE TABLE IF NOT EXISTS events (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER,
            event      TEXT,
            data       TEXT,
            created_at TEXT
        )""")
    db.execute("""
        CREATE TABLE IF NOT EXISTS meetings (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            title       TEXT,
            slot        TEXT,
            meet_url    TEXT,
            created_at  TEXT
        )""")
    db.commit()
    db.close()

def get_db():
    db = sqlite3.connect("bsp_crm.db")
    db.row_factory = sqlite3.Row
    return db

def get_user(tg_id):
    db = get_db()
    u = db.execute("SELECT * FROM users WHERE tg_id=?", (tg_id,)).fetchone()
    db.close()
    return u

def upsert_user(tg_id, username, **kwargs):
    db = get_db()
    u = db.execute("SELECT id FROM users WHERE tg_id=?", (tg_id,)).fetchone()
    now = datetime.now().isoformat()
    if u:
        sets = ", ".join(f"{k}=?" for k in kwargs)
        vals = list(kwargs.values()) + [now, tg_id]
        db.execute(f"UPDATE users SET {sets}, updated_at=? WHERE tg_id=?", vals)
    else:
        kwargs.update({"tg_id": tg_id, "username": username,
                       "created_at": now, "updated_at": now,
                       "ref_code": f"BSP{tg_id}"})
        cols = ", ".join(kwargs.keys())
        qs   = ", ".join("?" * len(kwargs))
        db.execute(f"INSERT INTO users ({cols}) VALUES ({qs})", list(kwargs.values()))
    db.commit()
    db.close()

def log_event(tg_id, event, data=""):
    db = get_db()
    db.execute("INSERT INTO events (user_id, event, data, created_at) VALUES (?,?,?,?)",
               (tg_id, event, data, datetime.now().isoformat()))
    db.commit()
    db.close()

def change_status(tg_id, new_status):
    db = get_db()
    u = db.execute("SELECT status FROM users WHERE tg_id=?", (tg_id,)).fetchone()
    old = u["status"] if u else "—"
    db.execute("UPDATE users SET status=?, updated_at=? WHERE tg_id=?",
               (new_status, datetime.now().isoformat(), tg_id))
    db.commit()
    db.close()
    log_event(tg_id, "status_change", f"{old}→{new_status}")

# ─────────────────────────────────────────
#  СОСТОЯНИЯ КОНВЕРСАЦИЙ
# ─────────────────────────────────────────
(ANK_NAME, ANK_CITY, ANK_JOB, ANK_COMPANY, ANK_SOURCE) = range(5)
(Q_TEXT,)  = range(10, 11)
(TS_C, TS_D, TS_I, TS_S, TS_N) = range(20, 25)
(ADMIN_CMD,) = range(30, 31)

# ─────────────────────────────────────────
#  КЛАВИАТУРЫ
# ─────────────────────────────────────────
def main_kb():
    return ReplyKeyboardMarkup([
        ["🏢 О БСП",        "💳 Тарифы"],
        ["✍️ Вступить",     "❓ Вопрос куратору"],
        ["👥 Я участник",   "📞 Контакты"],
    ], resize_keyboard=True)

def member_kb():
    return ReplyKeyboardMarkup([
        ["📋 Мой ЦДИСН",     "📅 Расписание"],
        ["🤝 Есть/Нужно/Хочу", "🎁 Мои рефералы"],
        ["↩️ Меню"],
    ], resize_keyboard=True)

def cancel_kb():
    return ReplyKeyboardMarkup([["❌ Отмена"]], resize_keyboard=True)

# ─────────────────────────────────────────
#  ТЕКСТЫ
# ─────────────────────────────────────────
ABOUT = """🏢 <b>БСП — Бизнес Сообщество Профессионалов</b>

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

🌐 bcpru.ru"""

TARIFFS = """💳 <b>Тарифы БСП</b>

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
✅ Первый месяц — <b>бесплатно</b>"""

SCHEDULE = """📅 <b>Слоты встреч</b> (мск)

<b>Онлайн «Десятка»</b> — 60–75 мин
ПН 18:00 · ВТ 18:00
СР 10:00 / 12:00 / 14:00
ЧТ 16:00 · СБ 18:00 · ВС 11:00

<b>Офлайн «Двадцатка»</b> — раз в месяц, 90 мин

Куратор подберёт группу по функции и городу."""

CONTACTS = """📞 <b>Контакты БСП</b>

Telegram: @bcpru
Телефон: +7 960 000-91-91
Email: E@E1111.RU
Сайт: bcpru.ru

Куратор ответит в течение дня."""

ENH_TEXT = """🤝 <b>Есть — Нужно — Хочу</b>

На каждой встрече каждый участник коротко говорит:

<b>✅ ЕСТЬ</b> — чем могу помочь прямо сейчас
<b>🎯 НУЖНО</b> — что мне важно решить
<b>💡 ХОЧУ</b> — с кем хочу познакомиться

Это ядро обмена ресурсами в группе."""

# ─────────────────────────────────────────
#  ОНБОРДИНГ — 5 сообщений новому участнику
# ─────────────────────────────────────────
ONBOARDING = [
    "🎉 <b>Добро пожаловать в БСП!</b>\n\nТы вступил в сообщество равных. Сейчас пройдём быстрый онбординг — 5 шагов, 2 минуты.",
    "📋 <b>Шаг 1 из 5 — ЦДИСН</b>\n\nТвоя визитная карточка в группе. Заполни анкету — группа сразу узнает, чем ты ценен и как можешь помочь.\n\nНажми «Мой ЦДИСН» в меню участника.",
    "📅 <b>Шаг 2 из 5 — Расписание</b>\n\nВыбери удобный слот встреч. Куратор назначит тебя в группу по функции и уровню.",
    "🤝 <b>Шаг 3 из 5 — Формат «Есть/Нужно/Хочу»</b>\n\nНа каждой встрече 3 минуты на тебя. Подготовь заранее: что есть, что нужно, с кем хочешь познакомиться.",
    "🎁 <b>Шаг 4 из 5 — Рефералы</b>\n\nПригласи коллегу → получи <b>1 000 ₽</b> на счёт. Количество не ограничено. Твоя ссылка — в разделе «Мои рефералы».\n\n✅ <b>Готово! Встречаемся на первой встрече.</b>",
]

# ─────────────────────────────────────────
#  НАПОМИНАНИЯ
# ─────────────────────────────────────────
REMINDER_24H = """⏰ <b>Встреча завтра!</b>

{title}
🕐 {slot}
🔗 {url}

Подготовь «Есть — Нужно — Хочу» заранее.
Проверь камеру и микрофон."""

REMINDER_1H = """🔔 <b>Встреча через час!</b>

{title}
🕐 {slot}
🔗 <a href="{url}">Войти в встречу</a>

Удачной встречи! 💪"""

# ─────────────────────────────────────────
#  ВСПОМОГАТЕЛЬНЫЕ
# ─────────────────────────────────────────
async def notify_admins(bot, text, kb=None):
    for aid in ADMIN_IDS:
        try:
            await bot.send_message(aid, text, parse_mode="HTML", reply_markup=kb)
        except Exception as e:
            log.warning(f"Admin {aid}: {e}")

def make_pay_url(tg_id, tariff_key):
    if not ROBOKASSA_LOGIN or not ROBOKASSA_PASS1:
        return None
    amount, desc, _ = TARIFF_PRICES[tariff_key]
    inv_id = (tg_id * 10 + list(TARIFF_PRICES).index(tariff_key)) % 999999
    sig = hashlib.md5(f"{ROBOKASSA_LOGIN}:{amount}.00:{inv_id}:{ROBOKASSA_PASS1}".encode()).hexdigest()
    p = {"MrchLogin": ROBOKASSA_LOGIN, "OutSum": f"{amount}.00",
         "InvId": inv_id, "Desc": desc, "SignatureValue": sig}
    return "https://auth.robokassa.ru/Merchant/Index.aspx?" + urllib.parse.urlencode(p)

# ─────────────────────────────────────────
#  /start
# ─────────────────────────────────────────
async def start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    u = update.effective_user

    # Реферальная ссылка
    args = ctx.args
    ref_by = None
    if args:
        try:
            ref_by = int(args[0].replace("ref", ""))
        except Exception:
            pass

    upsert_user(u.id, u.username or "", name=u.first_name,
                status="lead", ref_by=ref_by)
    log_event(u.id, "start", f"ref={ref_by}")

    await update.message.reply_text(
        f"Привет, <b>{u.first_name}</b>! 👋\n\n"
        "Это бот <b>БСП — Бизнес Сообщество Профессионалов</b>.\n"
        "Первое в России сообщество для ключевых сотрудников компаний.\n\n"
        "Выбери раздел 👇",
        parse_mode="HTML", reply_markup=main_kb()
    )

async def myid(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        f"Твой Telegram ID: <code>{update.effective_user.id}</code>",
        parse_mode="HTML"
    )

# ─────────────────────────────────────────
#  СТАТИЧНЫЕ РАЗДЕЛЫ
# ─────────────────────────────────────────
async def about(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    kb = InlineKeyboardMarkup([[
        InlineKeyboardButton("✍️ Вступить", callback_data="ank_start"),
        InlineKeyboardButton("🌐 Сайт", url="https://bcpru.ru"),
    ]])
    await update.message.reply_text(ABOUT, parse_mode="HTML", reply_markup=kb)

async def tariffs(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton("💙 Выбрать БСП — 5 000 ₽",  callback_data="pay_bsp")],
        [InlineKeyboardButton("⭐ Выбрать БСП+ — 11 000 ₽", callback_data="pay_bsp_plus")],
        [InlineKeyboardButton("👑 Выбрать VIP — 40 000 ₽",  callback_data="pay_vip")],
    ])
    await update.message.reply_text(TARIFFS, parse_mode="HTML", reply_markup=kb)

async def contacts(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(CONTACTS, parse_mode="HTML")

async def back_menu(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Главное меню:", reply_markup=main_kb())
    return ConversationHandler.END

# ─────────────────────────────────────────
#  РАЗДЕЛ УЧАСТНИКА
# ─────────────────────────────────────────
async def member_section(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    u_data = get_user(update.effective_user.id)
    tariff = u_data["tariff"] if u_data and u_data["tariff"] else "—"
    status = u_data["status"] if u_data else "lead"
    status_map = {"lead": "🔵 Лид", "candidate": "🟡 Кандидат",
                  "trial": "🟠 Пробный", "member": "🟢 Участник",
                  "vip": "👑 VIP", "rejected": "⛔ Архив"}
    await update.message.reply_text(
        f"👥 <b>Личный кабинет</b>\n\n"
        f"Статус: {status_map.get(status, status)}\n"
        f"Тариф: {tariff}\n\n"
        "Выбери действие:",
        parse_mode="HTML", reply_markup=member_kb()
    )

async def show_schedule(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(SCHEDULE, parse_mode="HTML")

async def show_enh(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(ENH_TEXT, parse_mode="HTML")

async def show_referrals(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    u = update.effective_user
    ref_code = f"ref{u.id}"
    link = f"https://t.me/{ctx.bot.username}?start={ref_code}"
    db = get_db()
    count = db.execute("SELECT COUNT(*) FROM users WHERE ref_by=?", (u.id,)).fetchone()[0]
    bonus = count * 1000
    db.close()
    await update.message.reply_text(
        f"🎁 <b>Реферальная программа</b>\n\n"
        f"Твоя ссылка:\n<code>{link}</code>\n\n"
        f"За каждого вступившего: <b>+1 000 ₽</b> на счёт\n\n"
        f"Приглашено: <b>{count} чел.</b>\n"
        f"Накоплено бонусов: <b>{bonus} ₽</b>",
        parse_mode="HTML"
    )

# ─────────────────────────────────────────
#  АНКЕТА ВСТУПЛЕНИЯ
# ─────────────────────────────────────────
async def ank_start_msg(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "✍️ <b>Анкета вступления</b>\n\nШаг 1/5 — <b>Имя и фамилия:</b>",
        parse_mode="HTML", reply_markup=cancel_kb()
    )
    return ANK_NAME

async def ank_start_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.callback_query.answer()
    await update.callback_query.message.reply_text(
        "✍️ <b>Анкета вступления</b>\n\nШаг 1/5 — <b>Имя и фамилия:</b>",
        parse_mode="HTML", reply_markup=cancel_kb()
    )
    return ANK_NAME

async def ank_name(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if update.message.text == "❌ Отмена":
        await update.message.reply_text("Отменено.", reply_markup=main_kb())
        return ConversationHandler.END
    ctx.user_data["name"] = update.message.text
    await update.message.reply_text("Шаг 2/5 — <b>Город:</b>", parse_mode="HTML")
    return ANK_CITY

async def ank_city(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if update.message.text == "❌ Отмена":
        await update.message.reply_text("Отменено.", reply_markup=main_kb())
        return ConversationHandler.END
    ctx.user_data["city"] = update.message.text
    await update.message.reply_text("Шаг 3/5 — <b>Должность:</b>", parse_mode="HTML")
    return ANK_JOB

async def ank_job(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if update.message.text == "❌ Отмена":
        await update.message.reply_text("Отменено.", reply_markup=main_kb())
        return ConversationHandler.END
    ctx.user_data["job"] = update.message.text
    await update.message.reply_text("Шаг 4/5 — <b>Компания:</b>", parse_mode="HTML")
    return ANK_COMPANY

async def ank_company(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if update.message.text == "❌ Отмена":
        await update.message.reply_text("Отменено.", reply_markup=main_kb())
        return ConversationHandler.END
    ctx.user_data["company"] = update.message.text
    kb = ReplyKeyboardMarkup([
        ["От коллеги / друга", "Telegram / соцсети"],
        ["Сайт bcpru.ru", "Другое"],
        ["❌ Отмена"],
    ], resize_keyboard=True)
    await update.message.reply_text("Шаг 5/5 — <b>Откуда узнал о БСП?</b>",
                                    parse_mode="HTML", reply_markup=kb)
    return ANK_SOURCE

async def ank_source(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if update.message.text == "❌ Отмена":
        await update.message.reply_text("Отменено.", reply_markup=main_kb())
        return ConversationHandler.END
    u = update.effective_user
    d = ctx.user_data
    d["source"] = update.message.text

    upsert_user(u.id, u.username or "",
                name=d.get("name", u.first_name),
                city=d.get("city"), job=d.get("job"),
                company=d.get("company"), source=d.get("source"),
                status="candidate")
    log_event(u.id, "anketa_completed")

    notify_text = (
        "🔔 <b>Новая заявка в БСП!</b>\n\n"
        f"👤 {d.get('name','—')}\n"
        f"🏙 {d.get('city','—')}\n"
        f"💼 {d.get('job','—')}, {d.get('company','—')}\n"
        f"📣 {d.get('source','—')}\n\n"
        f"TG: @{u.username or '—'} | <code>{u.id}</code>"
    )
    kb_admin = InlineKeyboardMarkup([[
        InlineKeyboardButton("💬 Написать", url=f"tg://user?id={u.id}"),
        InlineKeyboardButton("✅ Принять",  callback_data=f"admin_accept_{u.id}"),
    ]])
    await notify_admins(ctx.bot, notify_text, kb_admin)

    await update.message.reply_text(
        "✅ <b>Заявка принята!</b>\n\nКуратор свяжется в течение дня.\n"
        "Если срочно — @bcpru или +7 960 000-91-91",
        parse_mode="HTML", reply_markup=main_kb()
    )
    return ConversationHandler.END

# ─────────────────────────────────────────
#  ВОПРОС КУРАТОРУ
# ─────────────────────────────────────────
async def q_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "❓ Напиши свой вопрос — куратор ответит:",
        reply_markup=cancel_kb()
    )
    return Q_TEXT

async def q_text(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if update.message.text == "❌ Отмена":
        await update.message.reply_text("Отменено.", reply_markup=main_kb())
        return ConversationHandler.END
    u = update.effective_user
    await notify_admins(
        ctx.bot,
        f"❓ <b>Вопрос</b> от @{u.username or u.id}\n\n{update.message.text}",
        InlineKeyboardMarkup([[
            InlineKeyboardButton("💬 Ответить", url=f"tg://user?id={u.id}")
        ]])
    )
    await update.message.reply_text("✅ Вопрос отправлен куратору!", reply_markup=main_kb())
    return ConversationHandler.END

# ─────────────────────────────────────────
#  ЦДИСН
# ─────────────────────────────────────────
async def tsdisn_start_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.callback_query.answer()
    await update.callback_query.message.reply_text(
        "📋 <b>ЦДИСН — твоя визитка в группе</b>\n\n"
        "<b>Ц — Цели:</b> Чего хочешь достичь за год?",
        parse_mode="HTML", reply_markup=cancel_kb()
    )
    return TS_C

async def tsdisn_from_menu(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    u_data = get_user(update.effective_user.id)
    # Показать существующий или начать заполнение
    if u_data and u_data["notes"] and "ЦДИСН:" in str(u_data["notes"]):
        await update.message.reply_text(
            f"📋 <b>Твой ЦДИСН</b>\n\n{u_data['notes']}",
            parse_mode="HTML"
        )
        return ConversationHandler.END
    await update.message.reply_text(
        "📋 <b>ЦДИСН — твоя визитка в группе</b>\n\n"
        "<b>Ц — Цели:</b> Чего хочешь достичь за год?",
        parse_mode="HTML", reply_markup=cancel_kb()
    )
    return TS_C

async def ts_c(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if update.message.text == "❌ Отмена":
        await update.message.reply_text("Отменено.", reply_markup=member_kb())
        return ConversationHandler.END
    ctx.user_data["ts_c"] = update.message.text
    await update.message.reply_text("<b>Д — Достижения:</b> Чем гордишься за 2–3 года?",
                                    parse_mode="HTML")
    return TS_D

async def ts_d(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    ctx.user_data["ts_d"] = update.message.text
    await update.message.reply_text("<b>И — Интересы:</b> Какие темы близки в работе и жизни?",
                                    parse_mode="HTML")
    return TS_I

async def ts_i(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    ctx.user_data["ts_i"] = update.message.text
    await update.message.reply_text("<b>С — Связи:</b> Кого знаешь, кем можешь поделиться?",
                                    parse_mode="HTML")
    return TS_S

async def ts_s(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    ctx.user_data["ts_s"] = update.message.text
    await update.message.reply_text("<b>Н — Навыки:</b> В чём эксперт? Чем можешь помочь?",
                                    parse_mode="HTML")
    return TS_N

async def ts_n(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    ctx.user_data["ts_n"] = update.message.text
    d = ctx.user_data
    u = update.effective_user
    summary = (
        f"🎯 <b>Цели:</b> {d.get('ts_c','—')}\n"
        f"🏆 <b>Достижения:</b> {d.get('ts_d','—')}\n"
        f"💡 <b>Интересы:</b> {d.get('ts_i','—')}\n"
        f"🤝 <b>Связи:</b> {d.get('ts_s','—')}\n"
        f"⚡ <b>Навыки:</b> {d.get('ts_n','—')}"
    )
    notes_val = "ЦДИСН:\n" + summary.replace("<b>", "").replace("</b>", "")
    upsert_user(u.id, u.username or "", notes=notes_val)
    await update.message.reply_text(
        f"📋 <b>ЦДИСН сохранён!</b>\n\n{summary}",
        parse_mode="HTML", reply_markup=member_kb()
    )
    await notify_admins(ctx.bot,
        f"📋 <b>Новый ЦДИСН</b> @{u.username or u.id}\n\n{summary}")
    return ConversationHandler.END

# ─────────────────────────────────────────
#  ОПЛАТА
# ─────────────────────────────────────────
async def pay_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    await q.answer()
    key = q.data.replace("pay_", "")
    if key not in TARIFF_PRICES:
        return
    amount, desc, label = TARIFF_PRICES[key]
    url = make_pay_url(update.effective_user.id, key)
    if url:
        kb = InlineKeyboardMarkup([[InlineKeyboardButton(f"💳 Оплатить {label}", url=url)]])
        await q.message.reply_text(
            f"💳 <b>{desc}</b>\n<b>{label}</b>\n\nНажми для оплаты:",
            parse_mode="HTML", reply_markup=kb
        )
    else:
        await q.message.reply_text(
            f"💳 <b>{desc}</b> — {label}\n\n"
            "Оплата временно настраивается.\n"
            "Для вступления напиши: @bcpru · +7 960 000-91-91",
            parse_mode="HTML"
        )

# ─────────────────────────────────────────
#  ADMIN ПАНЕЛЬ
# ─────────────────────────────────────────
async def admin_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id not in ADMIN_IDS:
        return
    db = get_db()
    stats = {}
    for s in ["lead", "candidate", "trial", "member", "vip"]:
        stats[s] = db.execute("SELECT COUNT(*) FROM users WHERE status=?", (s,)).fetchone()[0]
    total = db.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    db.close()
    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton("📋 Все лиды",      callback_data="adm_list_lead"),
         InlineKeyboardButton("🟡 Кандидаты",     callback_data="adm_list_candidate")],
        [InlineKeyboardButton("🟢 Участники",     callback_data="adm_list_member"),
         InlineKeyboardButton("👑 VIP",            callback_data="adm_list_vip")],
        [InlineKeyboardButton("📊 Экспорт CSV",   callback_data="adm_export")],
    ])
    await update.message.reply_text(
        f"🛠 <b>Админ-панель БСП</b>\n\n"
        f"Всего пользователей: <b>{total}</b>\n"
        f"🔵 Лиды: {stats['lead']} · 🟡 Кандидаты: {stats['candidate']}\n"
        f"🟠 Пробные: {stats['trial']} · 🟢 Участники: {stats['member']} · 👑 VIP: {stats['vip']}",
        parse_mode="HTML", reply_markup=kb
    )

async def admin_list_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id not in ADMIN_IDS:
        return
    q = update.callback_query
    await q.answer()
    status = q.data.replace("adm_list_", "")
    db = get_db()
    rows = db.execute(
        "SELECT name, city, job, tg_id, username FROM users WHERE status=? LIMIT 20",
        (status,)
    ).fetchall()
    db.close()
    if not rows:
        await q.message.reply_text(f"Нет пользователей со статусом «{status}»")
        return
    text = f"<b>Статус: {status} ({len(rows)} чел.)</b>\n\n"
    for r in rows:
        text += f"• {r['name'] or '—'} | {r['city'] or '—'} | {r['job'] or '—'} | @{r['username'] or r['tg_id']}\n"
    await q.message.reply_text(text, parse_mode="HTML")

async def admin_accept_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id not in ADMIN_IDS:
        return
    q = update.callback_query
    await q.answer("Статус обновлён ✅")
    tg_id = int(q.data.replace("admin_accept_", ""))
    change_status(tg_id, "candidate")
    await q.edit_message_reply_markup(None)
    try:
        await ctx.bot.send_message(
            tg_id,
            "✅ <b>Твоя заявка одобрена!</b>\n\n"
            "Куратор свяжется с тобой для звонка в течение дня.\n"
            "Telegram: @bcpru · +7 960 000-91-91",
            parse_mode="HTML"
        )
    except Exception:
        pass

async def set_member_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Команда: /setmember <tg_id> <tariff>"""
    if update.effective_user.id not in ADMIN_IDS:
        return
    args = ctx.args
    if len(args) < 2:
        await update.message.reply_text("Использование: /setmember <tg_id> <bsp|bsp_plus|vip>")
        return
    tg_id, tariff = int(args[0]), args[1]
    upsert_user(tg_id, "", status="member", tariff=tariff)
    change_status(tg_id, "member")
    await update.message.reply_text(f"✅ Пользователь {tg_id} → участник ({tariff})")
    # Запускаем онбординг
    for i, msg in enumerate(ONBOARDING):
        try:
            await ctx.bot.send_message(tg_id, msg, parse_mode="HTML")
        except Exception:
            pass
    try:
        await ctx.bot.send_message(tg_id, "👇 Меню участника:", reply_markup=member_kb())
    except Exception:
        pass

async def broadcast_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Рассылка: /broadcast <текст>"""
    if update.effective_user.id not in ADMIN_IDS:
        return
    text = " ".join(ctx.args)
    if not text:
        await update.message.reply_text("Использование: /broadcast <текст>")
        return
    db = get_db()
    users = db.execute("SELECT tg_id FROM users WHERE status IN ('member','vip','trial')").fetchall()
    db.close()
    sent, fail = 0, 0
    for row in users:
        try:
            await ctx.bot.send_message(row["tg_id"], text, parse_mode="HTML")
            sent += 1
        except Exception:
            fail += 1
    await update.message.reply_text(f"✅ Отправлено: {sent} · ❌ Ошибок: {fail}")

# ─────────────────────────────────────────
#  ЗАПУСК
# ─────────────────────────────────────────
def main():
    init_db()
    app = Application.builder().token(BOT_TOKEN).build()

    # Анкета
    ank_conv = ConversationHandler(
        entry_points=[
            MessageHandler(filters.Regex("^✍️ Вступить$"), ank_start_msg),
            CallbackQueryHandler(ank_start_cb, pattern="^ank_start$"),
        ],
        states={
            ANK_NAME:    [MessageHandler(filters.TEXT & ~filters.COMMAND, ank_name)],
            ANK_CITY:    [MessageHandler(filters.TEXT & ~filters.COMMAND, ank_city)],
            ANK_JOB:     [MessageHandler(filters.TEXT & ~filters.COMMAND, ank_job)],
            ANK_COMPANY: [MessageHandler(filters.TEXT & ~filters.COMMAND, ank_company)],
            ANK_SOURCE:  [MessageHandler(filters.TEXT & ~filters.COMMAND, ank_source)],
        },
        fallbacks=[MessageHandler(filters.Regex("^↩️ Меню$"), back_menu)],
    )

    # Вопрос
    q_conv = ConversationHandler(
        entry_points=[MessageHandler(filters.Regex("^❓ Вопрос куратору$"), q_start)],
        states={Q_TEXT: [MessageHandler(filters.TEXT & ~filters.COMMAND, q_text)]},
        fallbacks=[MessageHandler(filters.Regex("^↩️ Меню$"), back_menu)],
    )

    # ЦДИСН
    ts_conv = ConversationHandler(
        entry_points=[
            MessageHandler(filters.Regex("^📋 Мой ЦДИСН$"), tsdisn_from_menu),
            CallbackQueryHandler(tsdisn_start_cb, pattern="^tsdisn_start$"),
        ],
        states={
            TS_C: [MessageHandler(filters.TEXT & ~filters.COMMAND, ts_c)],
            TS_D: [MessageHandler(filters.TEXT & ~filters.COMMAND, ts_d)],
            TS_I: [MessageHandler(filters.TEXT & ~filters.COMMAND, ts_i)],
            TS_S: [MessageHandler(filters.TEXT & ~filters.COMMAND, ts_s)],
            TS_N: [MessageHandler(filters.TEXT & ~filters.COMMAND, ts_n)],
        },
        fallbacks=[MessageHandler(filters.Regex("^↩️ Меню$"), back_menu)],
    )

    app.add_handler(CommandHandler("start",     start))
    app.add_handler(CommandHandler("myid",      myid))
    app.add_handler(CommandHandler("admin",     admin_cmd))
    app.add_handler(CommandHandler("setmember", set_member_cmd))
    app.add_handler(CommandHandler("broadcast", broadcast_cmd))
    app.add_handler(ank_conv)
    app.add_handler(q_conv)
    app.add_handler(ts_conv)

    app.add_handler(MessageHandler(filters.Regex("^🏢 О БСП$"),             about))
    app.add_handler(MessageHandler(filters.Regex("^💳 Тарифы$"),             tariffs))
    app.add_handler(MessageHandler(filters.Regex("^📞 Контакты$"),           contacts))
    app.add_handler(MessageHandler(filters.Regex("^👥 Я участник$"),         member_section))
    app.add_handler(MessageHandler(filters.Regex("^📅 Расписание$"),         show_schedule))
    app.add_handler(MessageHandler(filters.Regex("^🤝 Есть/Нужно/Хочу$"),   show_enh))
    app.add_handler(MessageHandler(filters.Regex("^🎁 Мои рефералы$"),       show_referrals))
    app.add_handler(MessageHandler(filters.Regex("^↩️ Меню$"),               back_menu))

    app.add_handler(CallbackQueryHandler(pay_cb,          pattern="^pay_"))
    app.add_handler(CallbackQueryHandler(admin_list_cb,   pattern="^adm_list_"))
    app.add_handler(CallbackQueryHandler(admin_accept_cb, pattern="^admin_accept_"))

    log.info("БСП Бот v2.0 запущен ✅")
    app.run_polling(drop_pending_updates=True)

if __name__ == "__main__":
    main()
