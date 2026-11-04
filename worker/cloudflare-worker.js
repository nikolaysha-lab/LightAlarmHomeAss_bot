// Оповещения о свете: SmartESS (DessMonitor) -> Telegram. Cloudflare Worker.
// Каждую минуту: проверка сети + проверка связи с инвертором. Кнопки: Состояние, Батарея, Связь, Приложение JK.
// Секреты: SMARTESS_USER, SMARTESS_PASS, TG_TOKEN, TG_CHAT_ID (несколько id через запятую).
// Переменная WORKER_URL — адрес этого воркера (для приёма нажатий кнопок). KV: STATE.
// Необязательная переменная HC_URL — адрес пинга Healthchecks.io (сторож: тревога, если бот перестал работать).
// Батарея: плата ESP32 рядом с JK BMS раз в минуту шлёт POST /bms с заголовком X-Key.
// Ключ платы выводится из TG_TOKEN (команда /bmskey в боте), отдельный секрет не нужен.
// Прошивка платы обновляется по Wi‑Fi: GitHub Actions -> POST /fw/upload, команда /update в боте.
// Команды: /status /battery /link /health /update /app /bmskey

const BASE = "https://api.dessmonitor.com/public/";
const COMPANY_KEY = "bnrl_frRFjEz8Mkn";
const MIN_VOLTAGE = 170;
const STALE_MIN = 20; // столько минут без новых данных от SmartESS = потеря связи (облако само обновляется раз в 5–15 мин)
const LINK_SAVE_SEC = 600; // отметку «данные SmartESS свежие» пишем в KV не чаще раза в 10 мин

const BTN_STATUS = "📊 Состояние";
const BTN_BATTERY = "🔋 Батарея";
const BTN_LINK = "📡 Связь";
const BTN_APP = "📱 Приложение JK";
const KEYBOARD = {
  keyboard: [[{ text: BTN_STATUS }, { text: BTN_BATTERY }], [{ text: BTN_LINK }, { text: BTN_APP }]],
  resize_keyboard: true, is_persistent: true,
};

// Оповещения по заряду: от 60% каждые 10%, от 20% каждые 5%
const SOC_LEVELS = [60, 50, 40, 30, 20, 15, 10, 5];
const SOC_REARM = 3;          // порог снова «взводится», когда заряд поднялся выше него на 3%
const BMS_STALE_MIN = 10;     // нет данных от платы дольше — сообщаем
const BMS_SAVE_SEC = 240;     // данные батареи пишем в KV раз в 4 мин (+ сразу при важных событиях)
// Бюджет записей KV в сутки (лимит 1000): батарея ~360, SmartESS ~144, события/статистика ~50 → ~550
const ESP_PRIMARY_MIN = 8;    // плата — главный источник света, пока её данные свежее 8 минут
const APP_PAUSE_MIN = 15;     // на сколько минут плата отпускает Bluetooth для приложения JK
const GRID_OFF_A = 1.5;       // «света нет» по плате — только если батарея реально разряжается сильнее 1,5 А
                              // (при 100% инвертор/балансировка тянут ~0,5–1 А и при свете — это не отключение)

// ---------- SmartESS ----------
async function sha1(s) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function quotePlus(v) { // как urllib.parse.quote_plus в Python — подпись должна совпадать
  return encodeURIComponent(String(v))
    .replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, "+");
}
async function call(env, auth, action, params = {}) {
  const act = `&action=${action}` + Object.entries(params).map(([k, v]) => `&${k}=${quotePlus(v)}`).join("");
  const salt = String(Date.now());
  let url;
  if (!auth) {
    const sign = await sha1(salt + (await sha1(env.SMARTESS_PASS)) + act);
    url = `${BASE}?sign=${sign}&salt=${salt}${act}`;
  } else {
    const sign = await sha1(salt + auth.secret + auth.token + act);
    url = `${BASE}?sign=${sign}&salt=${salt}&token=${auth.token}${act}`;
  }
  const resp = await (await fetch(url, { headers: { "User-Agent": "power-watch" } })).json();
  if (resp.err && resp.err !== 0) throw new Error(`${action}: ${resp.err} ${resp.desc}`);
  return resp.dat;
}
async function getAuth(env, force = false) {
  let auth = await env.STATE.get("auth", "json");
  if (!force && auth && Date.now() / 1000 < auth.expire - 600) return auth;
  const dat = await call(env, null, "authSource", {
    usr: env.SMARTESS_USER, "company-key": COMPANY_KEY, source: "1",
    _app_client_: "web", _app_id_: "power-watch", _app_version_: "1.0",
  });
  auth = { token: dat.token, secret: dat.secret, expire: Date.now() / 1000 + Number(dat.expire) };
  await env.STATE.put("auth", JSON.stringify(auth));
  return auth;
}
async function getDevice(env, auth) {
  let dev = await env.STATE.get("dev", "json");
  if (dev) return dev;
  const plants = (await call(env, auth, "queryPlants", { pagesize: 50 }))?.plant || [];
  for (const p of plants) {
    const cols = (await call(env, auth, "webQueryCollectorsEs", { pid: p.pid, page: 0, pagesize: 50 }))?.collector || [];
    for (const c of cols) {
      const devs = (await call(env, auth, "queryCollectorDevices", { pn: c.pn }))?.dev || [];
      if (devs.length) {
        const d = devs[0];
        dev = { pn: c.pn, devcode: d.devcode, devaddr: d.devaddr, sn: d.sn };
        await env.STATE.put("dev", JSON.stringify(dev));
        return dev;
      }
    }
  }
  throw new Error("Инверторы в аккаунте не найдены");
}
async function readInverter(env) {
  try {
    const auth = await getAuth(env);
    return await call(env, auth, "queryDeviceLastData", { ...(await getDevice(env, auth)), i18n: "en" }) || [];
  } catch (e) { // токен мог протухнуть — входим заново
    const auth = await getAuth(env, true);
    await env.STATE.delete("dev");
    return await call(env, auth, "queryDeviceLastData", { ...(await getDevice(env, auth)), i18n: "en" }) || [];
  }
}
function val(points, title) {
  const p = points.find(x => String(x.title).toLowerCase() === title.toLowerCase());
  return p ? p.val : undefined;
}
function num(points, title) {
  const v = parseFloat(val(points, title));
  return isNaN(v) ? null : v;
}
function findGridVoltage(points) {
  const words = ["grid", "ac input", "mains", "utility", "line", "input voltage"];
  for (const p of points) {
    const t = String(p.title || "").toLowerCase();
    if (t.includes("volt") && words.some(w => t.includes(w)) && !t.includes("pv") &&
        !t.includes("battery") && !t.includes("output")) {
      const v = parseFloat(p.val);
      return isNaN(v) ? 0 : v;
    }
  }
  return null;
}

// ---------- батарея (данные от ESP32) ----------
async function getBms(env) {
  const b = await env.STATE.get("bms", "json");
  if (!b || !b.at) return null;
  b.age = nowSec() - b.at;
  b.fresh = b.age < BMS_STALE_MIN * 60 && b.online !== false && b.soc != null;
  return b;
}
function bar(soc) {
  const n = Math.max(0, Math.min(10, Math.round(soc / 10)));
  return "▰".repeat(n) + "▱".repeat(10 - n);
}
function f1(x) { return (Math.round(x * 10) / 10).toString().replace(".", ","); }
function f2(x) { return x.toFixed(2).replace(".", ","); }
function f3(x) { return x.toFixed(3).replace(".", ","); }
function socIcon(soc) { return soc <= 20 ? "🪫" : "🔋"; }
function hours(sec) { // ~11 д 20 ч / ~5 ч 30 мин / ~45 мин (минуты округляем до 10)
  if (sec < 3600) return `~${Math.max(1, Math.round(sec / 60))} мин`;
  if (sec >= 86400) { const t = Math.round(sec / 3600), d = Math.floor(t / 24), h = t % 24; return h ? `~${d} д ${h} ч` : `~${d} д`; }
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 600) * 10;
  return m === 60 ? `~${h + 1} ч` : m ? `~${h} ч ${m} мин` : `~${h} ч`;
}
function timeCell(b) { // ⏱ хватит ~16 ч  /  ⏱ полная ~1,5 ч
  if (b.current == null || b.remain_ah == null) return null;
  const a = Math.abs(b.current);
  if (b.current < -GRID_OFF_A) {
    if (b.avgW > 30 && b.voltage) return `⏱ хватит ${hours(b.remain_ah * b.voltage / b.avgW * 3600)} <i>(по средней ${Math.round(b.avgW)} Вт)</i>`;
    return `⏱ хватит ${hours(b.remain_ah / a * 3600)}`;
  }
  if (b.current > 0.5 && b.capacity_ah && b.soc < 99) return `⏱ полная ${hours(Math.max(0, b.capacity_ah - b.remain_ah) / a * 3600)}`;
  return null;
}
// ----- оформление «вариант B»: шапка + карточки -----
const quote = rows => rows.length ? `<blockquote>${rows.join("\n")}</blockquote>` : "";
// сообщение: шапка строками подряд, дальше карточки через пустую строку — чтобы текст не шёл сплошняком
const msg = (head, ...cards) => [head.filter(Boolean).join("\n"), ...cards.filter(Boolean)].filter(Boolean).join("\n\n");
const more = rows => rows.length ? `<blockquote expandable>${rows.join("\n")}</blockquote>` : "";
const CHG = "🔺", DIS = "🔻";            // значки заряда / разряда
const ICON_INV = "🎛️", ICON_BOARD = "📟";   // инвертор / плата у батареи
function row(icon, label, value) { return `${icon}  ${value}`; }               // таблица: значок + цифры (подпись не выводим)
function lrow(icon, label, value) { return `${icon}  ${label}  ${value}`; }    // с подписью (Связь, Подробнее)
function lightHead(on, dur, verb) {
  if (on === null || on === undefined) return "⚪ <b>Свет: неизвестно</b>";
  const t = verb ? (on ? "Свет появился" : "Свет пропал") : (on ? "Свет есть" : "Света нет");
  return `${on ? "🟢" : "🔴"} <b>${t}</b>` + (dur ? ` · ${esc(dur)}` : "");
}
function battHead(b) { return `${socIcon(b.soc)} <b>${Math.round(b.soc)}%</b>  ${bar(b.soc)}`; }
function battFlowRow(b) {
  if (b.current == null) return null;
  const w = b.power != null ? Math.abs(b.power) : Math.abs(b.current) * (b.voltage || 0);
  if (b.current > 0.5) return row(CHG, "Заряд", `+${f1(b.current)} А · ${Math.round(w)} Вт`);
  if (b.current < -0.5) return row(DIS, "Разряд", `−${f1(-b.current)} А · ${Math.round(w)} Вт`);
  return row("⏸", "Ток", "0 А");
}
function battTech(b) {
  const R = [];
  const errs = errList(b.err || 0);
  if (errs.length) R.push(`⚠️  <b>${esc(errs.join(", "))}</b>`);
  if (b.dis === false) R.push("⛔  <b>разряд отключён BMS</b>");
  if (b.chg === false && b.soc < 98) R.push("⛔  <b>заряд отключён BMS</b>");
  if (b.voltage != null) R.push(row("🔋", "Напряжение", `${f2(b.voltage)} В`));
  const fl = battFlowRow(b); if (fl) R.push(fl);
  if (b.remain_ah != null) R.push(row("📦", "Ёмкость", `${Math.round(b.remain_ah)} / ${Math.round(b.capacity_ah ?? 0)} А·ч`));
  if (b.cell_min != null && b.cell_max != null) {
    const d = b.cell_max - b.cell_min;
    R.push(row("🧩", "Банки", `Δ ${f3(d)} В ${d >= 0.05 ? "⚠️" : "✅"}`));
  }
  const t = [b.t1, b.t2].filter(x => x != null).map(x => `${f1(x)}°`).join(" / ");
  if (t) R.push(row("🌡️", "Темп.", t));
  if (b.mos_t != null) R.push(row("🌡️", "", `BMS ${f1(b.mos_t)}°`));
  if (b.balancing) R.push(row("⚖️", "", "балансировка"));
  return R;
}
// ----- ошибки BMS (биты JK02), служебные биты не показываем -----
const BMS_ERRORS = {
  0: "сопротивление проводов", 1: "перегрев MOSFET", 2: "число банок не совпадает с настройками",
  5: "перенапряжение батареи", 6: "превышен ток заряда", 7: "КЗ при заряде", 8: "перегрев при заряде",
  9: "слишком холодно для заряда", 10: "ошибка сопроцессора BMS", 11: "банка разряжена ниже минимума",
  12: "батарея разряжена ниже минимума", 13: "превышен ток разряда", 14: "КЗ при разряде",
  15: "перегрев при разряде", 16: "неисправен MOSFET заряда", 17: "неисправен MOSFET разряда",
  20: "не удалось включить разряд", 21: "перегрев батареи", 22: "неисправен датчик температуры",
  23: "ошибка модуля PL", 24: "не снялась защита от КЗ", 25: "превышен ток разряда (ур. 2)",
  26: "превышен ток разряда (ур. 3)", 27: "слишком холодно для разряда",
};
const ERR_MASK = Object.keys(BMS_ERRORS).reduce((m, k) => m | (1 << Number(k)), 0) >>> 0;
function errList(mask) { return Object.keys(BMS_ERRORS).filter(k => (mask >>> 0) & (1 << Number(k))).map(k => BMS_ERRORS[k]); }
function cellsRows(b) { // 8 банок по 2 в строку, слабая ⬇️, сильная ⬆️
  const c = (b.cells || []).filter(v => v > 0);
  if (c.length < 2) return [];
  const mn = Math.min(...c), mx = Math.max(...c), R = [];
  const iMn = mx > mn ? c.indexOf(mn) : -1, iMx = mx > mn ? c.indexOf(mx) : -1; // по одной банке; если все равны — без пометок
  const cell = i => `${i + 1}: ${f3(c[i])}${i === iMn ? "⬇️" : i === iMx ? "⬆️" : ""}`;
  for (let i = 0; i < c.length; i += 2) R.push(`🧩  ${cell(i)}` + (i + 1 < c.length ? `   ${cell(i + 1)}` : ""));
  return R;
}
const kwh = wh => `${f1(wh / 1000)} кВт·ч`;
function kyivDay(ts = Date.now()) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date(ts)); }
async function enrich(env, b, st) { // средняя нагрузка за текущее отключение
  st = st || (await env.STATE.get("state", "json")) || {};
  if (b && st.grid_on === false && st.out && b.st && st.out.wh != null) {
    const h = (nowSec() - st.out.at) / 3600;
    if (h > 1 / 6) b.avgW = Math.max(0, b.st.tot_out - st.out.wh) / h;
  }
  return st;
}
function statsRows(b, st) {
  const R = [];
  const now = nowSec(), today = kyivDay();
  const d = b.st && b.st.day === today ? b.st : null;
  let off = st.off_day === today ? (st.off_sec || 0) : 0;
  if (st.grid_on === false && st.since) off += now - st.since;
  if (d || off) R.push(lrow("📅", "Сегодня", [d ? `🔺 ${kwh(d.in)}` : null, d ? `🔻 ${kwh(d.out)}` : null, off ? `без света ${fmtDuration(off)}` : null].filter(Boolean).join(" · ")));
  const L = st.last;
  if (L) R.push(lrow("🔌", "Прошлое отключение", `${fmtDuration(L.end - L.start)}` +
    (L.soc0 != null && L.soc1 != null ? ` · ${Math.round(L.soc0)}% → ${Math.round(L.soc1)}%` : "") + (L.wh != null ? ` · ${kwh(L.wh)}` : "")));
  return R;
}
// ---------- здоровье батареи: отчёт раз в месяц / каждые 10 циклов / по команде /health ----------
async function healthAdd(env, wk) {
  const h = (await env.STATE.get("health", "json")) || {};
  h.samples = [...(h.samples || []), wk].slice(-60);
  await env.STATE.put("health", JSON.stringify(h));
}
async function healthText(env) {
  const b = await getBms(env);
  const h = (await env.STATE.get("health", "json")) || {};
  if (!b || b.soc == null) return msg(["🩺 <b>Здоровье батареи</b>"], quote(["Нет данных от платы у батареи"]));
  const now = nowSec(), DAY = 86400;
  const all = [...(h.samples || []), ...(b.wk ? [b.wk] : [])];
  const recent = all.filter(x => now - x.t < 30 * DAY), older = all.filter(x => now - x.t >= 30 * DAY && now - x.t < 60 * DAY);
  const avg = a => a.reduce((s, x) => s + x.d, 0) / a.length;
  let warn = false;
  const A = [];
  if (b.soh != null) A.push(row("💚", "", `SOH ${Math.round(b.soh)}% <i>(по данным BMS)</i>`));
  if (b.cycles != null) A.push(row("🔁", "", `циклов: ${b.cycles}` + (h.rep && h.rep.cycles != null ? ` · +${b.cycles - h.rep.cycles} с прошлого отчёта` : "")));
  if (b.capacity_ah) A.push(row("📦", "", `${Math.round(b.capacity_ah)} А·ч <i>(ёмкость из настроек BMS)</i>`));
  const C = ["🧩 <b>Банки под нагрузкой</b>"];
  if (!recent.length) C.push("Пока мало данных — нужен хотя бы один разряд от батареи (ток больше 3 А)");
  else {
    const cnt = {}; recent.forEach(x => cnt[x.idx] = (cnt[x.idx] || 0) + 1);
    const [k, c] = Object.entries(cnt).sort((x, y) => y[1] - x[1])[0];
    C.push(row("⬇️", "", `слабее всех банка №${k} — в ${c} из ${recent.length} разрядов`));
    const a = avg(recent), mark = a >= 0.1 ? "‼️" : a >= 0.05 ? "⚠️" : "✅";
    if (a >= 0.05) warn = true;
    let trend = "";
    if (older.length) { const o = avg(older); trend = a > o * 1.3 && a - o > 0.01 ? ` · растёт (было ${f3(o)})` : " · стабильно"; if (trend.includes("растёт")) warn = true; }
    C.push(row("📏", "", `разброс ~${f3(a)} В ${mark}${trend}`));
  }
  const cs = (b.cells || []).filter(v => v > 0);
  if (cs.length >= 2) C.push(row("😴", "", `сейчас Δ ${f3(Math.max(...cs) - Math.min(...cs))} В`));
  const W = [];
  const rs = (b.res || []).map((v, i) => [v, i + 1]).filter(x => x[0] > 0);
  if (rs.length) {
    const [mx, i] = rs.sort((x, y) => y[0] - x[0])[0];
    if (mx > 0.2) warn = true;
    W.push(row("🔌", "", `провода балансировки до ${f3(mx)} Ом ` + (mx > 0.2 ? `⚠️ проверьте контакт банки №${i}` : "✅")));
  }
  return msg(["🩺 <b>Здоровье батареи</b>", warn ? "⚠️ Есть на что посмотреть" : "✅ Всё в норме"], quote(A), quote(C), quote(W));
}
async function healthDaily(env) { // раз в день в 10:xx: итог разряда + плановый отчёт
  const today = kyivDay();
  if ((await env.STATE.get("health_day")) === today) return;
  await env.STATE.put("health_day", today);
  const b = await env.STATE.get("bms", "json");
  if (!b || !b.at) return;
  if (b.wk && nowSec() - b.wk.t > 6 * 3600) { await healthAdd(env, b.wk); b.wk = null; await env.STATE.put("bms", JSON.stringify(b)); }
  const h = (await env.STATE.get("health", "json")) || {};
  const month = kyivDay().slice(0, 7), day1 = kyivDay().endsWith("-01");
  if (!h.rep) { h.rep = { t: nowSec(), cycles: b.cycles ?? null, month }; await env.STATE.put("health", JSON.stringify(h)); return; }
  const byCycles = b.cycles != null && h.rep.cycles != null && b.cycles - h.rep.cycles >= 10;
  if ((day1 && h.rep.month !== month) || byCycles) {
    await tgSendAll(env, await healthText(env), NIGHT_SILENT);
    h.rep = { t: nowSec(), cycles: b.cycles ?? null, month };
    await env.STATE.put("health", JSON.stringify(h));
  }
}
async function batteryText(env) {
  const now = nowSec();
  const st = (await env.STATE.get("state", "json")) || {};
  const head = lightHead(st.grid_on, st.since ? fmtDuration(now - st.since) : "");
  const b = await getBms(env);
  if (!b) return msg([head], quote(["🔋  Плата у батареи ещё не подключена"]));
  if (b.online === false && b.age < BMS_STALE_MIN * 60)
    return msg([head], quote([b.paused ? "⏸  <b>BMS у приложения JK</b>" : "❌  <b>Плата не видит BMS</b>",
      b.paused ? "Плата подключится сама через несколько минут" : "Подробности — в 📡 Связь"]));
  if (!b.fresh) return msg([head], quote([`⚠️  <b>Нет данных от платы ${fmtDuration(b.age)}</b>`, "Подробности — в 📡 Связь"]));
  await enrich(env, b, st);
  const tc = timeCell(b);
  const sw = b.chg != null || b.dis != null ? lrow("🔓", "BMS", `заряд ${b.chg === false ? "❌" : "✅"} · разряд ${b.dis === false ? "❌" : "✅"}`) : null;
  return msg([head, battHead(b), tc], quote(battTech(b)), quote(statsRows(b, st)),
    more([`⚙️ <b>Подробнее</b>`, ...cellsRows(b), sw,
          lrow("🕒", "Данные", `${fmtDuration(b.age)} назад`),
          b.cycles != null ? lrow("🔁", "Циклов", String(b.cycles)) : null].filter(Boolean)));
}

// Приём данных от ESP32 + умные оповещения по заряду
async function bmsKey(env) { return (await sha1("bms-" + env.TG_TOKEN)).slice(0, 24); }
async function handleBms(request, env) {
  if (request.headers.get("X-Key") !== await bmsKey(env)) return new Response("forbidden", { status: 403 });
  const d = await request.json();
  const now = nowSec();
  const prev = (await env.STATE.get("bms", "json")) || {};
  const pauseUntil = Number(await env.STATE.get("app_pause_until")) || 0;
  const pause = pauseUntil > now ? Math.ceil((pauseUntil - now) / 60) : 0;
  const b = {
    at: now, online: d.online !== false, paused: pause > 0, rssi: d.rssi != null ? Math.round(d.rssi) : null,
    soc: d.soc, remain_ah: d.remain_ah,
    capacity_ah: d.capacity_ah || (d.remain_ah != null && d.soc > 1 ? Math.round(d.remain_ah / d.soc * 1000) / 10 : null), voltage: d.voltage, current: d.current,
    power: d.power, cell_min: d.cell_min, cell_max: d.cell_max, t1: d.t1, t2: d.t2, mos_t: d.mos_t,
    cycles: d.cycles, balancing: !!d.balancing,
    grid: typeof d.grid === "boolean" ? d.grid : null,
    chg: typeof d.chg === "boolean" ? d.chg : null, dis: typeof d.dis === "boolean" ? d.dis : null,
    err: d.err != null ? (Number(d.err) & ERR_MASK) >>> 0 : 0,
    cells: Array.isArray(d.cells) ? d.cells.slice(0, 32) : null,
    e_in: d.e_in, e_out: d.e_out,
    soh: d.soh, res: Array.isArray(d.res) ? d.res.slice(0, 32) : null,
    fw: d.fw != null ? String(d.fw) : (prev.fw ?? null),
    wk: prev.wk || null, // худший разброс банок под нагрузкой за текущий разряд (для отчёта о здоровье)
  };
  // статистика энергии: плата шлёт Вт·ч с момента включения, бот копит по дням
  const today = kyivDay();
  const ps = prev.st || {};
  const st = ps.day === today ? { ...ps } : { day: today, in: 0, out: 0, tot_out: ps.tot_out || 0 };
  const din = d.e_in == null ? 0 : (prev.e_in != null && d.e_in >= prev.e_in ? d.e_in - prev.e_in : d.e_in);
  const dout = d.e_out == null ? 0 : (prev.e_out != null && d.e_out >= prev.e_out ? d.e_out - prev.e_out : d.e_out);
  b.st = st;
  if (!b.online) b.grid = null;
  // свет по току батареи считаем сами (с запасом), плата лишь будит бота при смене:
  // разряд сильнее 1,5 А — света нет; ток выше −0,5 А — свет есть; между — как было
  if (b.online && b.current != null) b.grid = b.current < -GRID_OFF_A ? false : b.current > -0.5 ? true : (prev.grid ?? true);
  if (b.online && b.soc == null) b.online = false;
  if (!b.online) { b.chg = prev.chg ?? null; b.dis = prev.dis ?? null; b.err = prev.err || 0; }
  // здоровье: запоминаем самый большой разброс банок под нагрузкой (разряд > 3 А)
  const cv = (b.cells || []).filter(v => v > 0);
  if (b.online && b.current < -3 && cv.length >= 2) {
    const mn = Math.min(...cv), dd = Math.max(...cv) - mn;
    if (!b.wk || dd >= b.wk.d) b.wk = { d: Math.round(dd * 1000) / 1000, idx: cv.indexOf(mn) + 1, soc: b.soc, t: now };
  }
  if (prev.grid === false && b.grid === true && b.wk) { await healthAdd(env, b.wk); b.wk = null; }

  // --- срочные оповещения BMS: ошибки, отключение заряда/разряда ---
  if (b.online && prev.at) {
    const newErr = (b.err & ~(prev.err || 0)) >>> 0, goneErr = ((prev.err || 0) & ~b.err) >>> 0;
    const bad = [], good = [];
    if (b.dis === false && prev.dis !== false) bad.push("‼️ <b>BMS отключила разряд</b> — инвертор не может брать энергию из батареи");
    if (b.chg === false && prev.chg !== false && b.soc < 98) bad.push(`⚠️ <b>BMS отключила заряд</b> при ${Math.round(b.soc)}%`);
    if (newErr) bad.push(`⚠️ <b>BMS: ${esc(errList(newErr).join(", "))}</b>`);
    if (b.dis === true && prev.dis === false) good.push("✅ <b>BMS снова разрешила разряд</b>");
    if (b.chg === true && prev.chg === false && (prev.soc ?? 100) < 98) good.push("✅ <b>BMS снова разрешила заряд</b>");
    if (goneErr && !b.err) good.push(`✅ <b>Ошибка BMS снята</b> — ${esc(errList(goneErr).join(", "))}`);
    if (bad.length) await tgSendAll(env, msg([...bad, battHead(b)], quote(battTech(b))));
    else if (good.length) await tgSendAll(env, msg([...good, battHead(b)]), SILENT);
  }

  // быстрое определение света по току батареи (до оповещений по заряду — чтобы в них было актуальное «свет есть/нет»)
  if (b.grid != null) await setGrid(env, b.grid, null, "battery", { ...b, age: 0, fresh: true });

  // --- оповещения по заряду ---
  let alerts = null;
  if (b.online) {
    alerts = (await env.STATE.get("soc_alerts", "json")) || { low: null, full: true };
    const soc = b.soc;
    let changed = false;
    // взводим обратно пороги, если батарея подзарядилась
    if (alerts.low != null && soc >= alerts.low + SOC_REARM) {
      const above = SOC_LEVELS.filter(l => l > soc - SOC_REARM);
      alerts.low = above.length ? Math.min(...above) : null; changed = true;
    }
    // самый низкий пересечённый порог, о котором ещё не сообщали
    const crossed = SOC_LEVELS.filter(l => soc <= l && (alerts.low == null || l < alerts.low));
    if (crossed.length) {
      const lvl = Math.min(...crossed);
      alerts.low = lvl; changed = true;
      const title = lvl <= 10 ? "🪫‼️ <b>Батарея почти пуста</b>"
                  : lvl <= 20 ? "🪫 <b>Батарея садится</b> — пора экономить" : `🔋 <b>Заряд батареи ${lvl}%</b>`;
      const st = await enrich(env, b);
      const lh = st.grid_on !== undefined ? lightHead(st.grid_on, st.since ? fmtDuration(now - st.since) : "") : null;
      const fl = battFlowRow(b);
      await tgSendAll(env, msg([title], [lh, battHead(b), timeCell(b)].filter(Boolean).join("\n"), fl ? quote([fl]) : null), lvl > 20 ? NIGHT_SILENT : undefined);
    }
    // полный заряд
    if (soc < 90 && alerts.full) { alerts.full = false; changed = true; }
    if (soc >= 100 && !alerts.full) {
      alerts.full = true; changed = true;
      await tgSendAll(env, msg(["✅ <b>Батарея заряжена</b>", `🔋 <b>100%</b>  ${bar(100)}`],
        quote([row("📦", "Ёмкость", `${Math.round(b.remain_ah ?? 0)} А·ч`), row("🔋", "Напряжение", `${f2(b.voltage ?? 0)} В`)])), SILENT);
    }
    if (changed) await env.STATE.put("soc_alerts", JSON.stringify(alerts));
  }

  // сохраняем не чаще раза в 5 минут (или сразу, если что-то важное изменилось)
  const important = !prev.at || prev.online !== b.online || prev.paused !== b.paused || prev.grid !== b.grid ||
    prev.lost ||
    prev.err !== b.err || prev.chg !== b.chg || prev.dis !== b.dis || (prev.wk && !b.wk) || prev.fw !== b.fw;
  const saving = important || now - prev.at >= BMS_SAVE_SEC;
  if (saving) { st.in = (st.in || 0) + din; st.out = (st.out || 0) + dout; st.tot_out = (st.tot_out || 0) + dout; }
  else { b.e_in = prev.e_in; b.e_out = prev.e_out; st.tot_out = (st.tot_out || 0) + dout; } // не сохраняем — дельту учтём при сохранении
  if (saving) {
    if (prev.lost) await tgSendAll(env, msg([`${ICON_BOARD} <b>Плата у батареи снова на связи</b>`], quote([row("⏳", "", `не было данных ${fmtDuration(now - prev.at)}`)])), SILENT);
    await env.STATE.put("bms", JSON.stringify(b));
  }
  const update = await fwCheck(env, b.fw);
  return new Response(JSON.stringify({ ok: true, pause, update }), { headers: { "content-type": "application/json" } });
}

// ---------- обновление прошивки платы по Wi‑Fi ----------
// GitHub Actions после сборки шлёт файл сюда (POST /fw/upload, ключ платы), бот хранит его в KV.
// По команде /update бот в ответе на данные платы говорит update:true — плата сама скачивает /fw/bin и перезагружается.
async function fwUpload(request, env) {
  if (request.headers.get("X-Key") !== await bmsKey(env)) return new Response("forbidden", { status: 403 });
  const ver = String(request.headers.get("X-Ver") || ""), md5 = String(request.headers.get("X-Md5") || "");
  if (!/^\d+$/.test(ver) || !/^[0-9a-f]{32}$/.test(md5)) return new Response("bad meta", { status: 400 });
  const bin = await request.arrayBuffer();
  if (bin.byteLength < 100000) return new Response("too small", { status: 400 });
  await env.STATE.put("fw_bin", bin);
  await env.STATE.put("fw_meta", JSON.stringify({ ver, md5, size: bin.byteLength, at: nowSec() }));
  const b = await getBms(env);
  if (!b || b.fw !== ver)
    await tgSendAll(env, msg([`🆕 <b>Готова прошивка платы №${ver}</b>`], quote([`${ICON_BOARD}  сейчас на плате: ${b && b.fw ? "№" + esc(b.fw) : "неизвестно"}`, "⬆️  Обновить по Wi‑Fi: /update"])), SILENT);
  return new Response("ok");
}
async function fwServe(request, env, what) {
  const url = new URL(request.url);
  if (url.searchParams.get("k") !== await bmsKey(env)) return new Response("forbidden", { status: 403 });
  if (what === "md5") { const m = await env.STATE.get("fw_meta", "json"); return new Response(m ? m.md5 : "", { status: m ? 200 : 404 }); }
  const bin = await env.STATE.get("fw_bin", "arrayBuffer");
  if (!bin) return new Response("no firmware", { status: 404 });
  return new Response(bin, { headers: { "content-type": "application/octet-stream", "content-length": String(bin.byteLength) } });
}
async function fwCheck(env, cur) { // вызывается при каждом приёме данных платы
  const req = await env.STATE.get("fw_req", "json");
  if (!req) return false;
  if (cur === req.ver) { // плата уже на новой версии
    await env.STATE.delete("fw_req");
    await tgSendAll(env, msg([`✅ <b>Плата обновлена до прошивки №${esc(cur)}</b>`]), SILENT);
    return false;
  }
  if (nowSec() - req.at > 15 * 60) {
    await env.STATE.delete("fw_req");
    await tgSendAll(env, msg(["⚠️ <b>Плата не обновилась за 15 мин</b>"], quote([`${ICON_BOARD}  осталась прошивка №${esc(cur ?? "?")}`, "Попробуйте ещё раз: /update"])));
    return false;
  }
  return true;
}
async function fwText(env) {
  const m = await env.STATE.get("fw_meta", "json"), b = await getBms(env), req = await env.STATE.get("fw_req", "json");
  const cur = b && b.fw ? `№${esc(b.fw)}` : "неизвестно (прошивка без обновления по Wi‑Fi)";
  const rows = [`${ICON_BOARD}  на плате: ${cur}`, `🆕  последняя сборка: ${m ? `№${m.ver} · ${Math.round(m.size / 1024)} КБ` : "нет"}`];
  if (req) rows.push(`⏳  обновление запрошено ${fmtDuration(nowSec() - req.at)} назад`);
  const can = m && b && b.fw && b.fw !== m.ver && !req;
  return { text: msg(["⬆️ <b>Прошивка платы</b>"], quote(rows), can ? null : `<i>${!m ? "Сборок пока нет" : !b || !b.fw ? "Первый раз прошейте плату по USB, дальше — по Wi‑Fi" : req ? "Ждём, пока плата скачает прошивку (~1–2 мин)" : "Обновлять нечего — на плате последняя версия"}</i>`),
           kb: can ? { inline_keyboard: [[{ text: `⬆️ Обновить до №${m.ver}`, callback_data: "fw:go" }]] } : undefined };
}

// Плата перестала присылать данные (проверяется раз в минуту)
async function checkBmsLink(env) {
  const prev = await env.STATE.get("bms", "json");
  if (!prev || !prev.at || prev.lost) return;
  const age = nowSec() - prev.at;
  if (age > BMS_STALE_MIN * 60) {
    prev.lost = true;
    await env.STATE.put("bms", JSON.stringify(prev));
    const link = (await env.STATE.get("link", "json")) || {};
    await tgSendAll(env, msg([`⚠️ <b>Нет данных от платы у батареи</b> · ${fmtDuration(age)}`],
      quote(link.lost ? ["☁️  SmartESS тоже молчит — скорее всего, дома нет интернета"]
                      : ["📟  Проверьте, что плата включена и ловит Wi‑Fi", "💡  Свет пока определяется по SmartESS · до 15 мин"])), NIGHT_SILENT);
  }
}

// ---------- форматирование ----------
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d} д`);
  if (h) parts.push(`${h} ч`);
  if (m || !parts.length) parts.push(`${m} мин`);
  return parts.join(" ");
}
function kyivTime(ts = Date.now()) {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" }).format(new Date(ts));
}
const nowSec = () => Date.now() / 1000;

// ---------- Telegram ----------
function chatIds(env) { return String(env.TG_CHAT_ID).split(",").map(s => s.trim()).filter(Boolean); }
async function tg(env, method, body) {
  return fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
// тихо: мелкие новости всегда, «средние» — ночью (23:00–07:00). Свет, садящаяся батарея и ошибки BMS — всегда со звуком
const SILENT = "silent", NIGHT_SILENT = "night";
function isNight() { const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", hour: "2-digit", hour12: false }).format(new Date())); return h >= 23 || h < 7; }
async function tgSendAll(env, text, mode, kb) {
  let ok = 0;
  const quiet = mode === SILENT || (mode === NIGHT_SILENT && isNight());
  for (const id of chatIds(env)) {
    const r = await tg(env, "sendMessage", { chat_id: id, text, parse_mode: "HTML", reply_markup: kb || KEYBOARD, disable_notification: quiet });
    if (r.ok) ok++; else console.log(`Telegram не принял сообщение для ${id}: ${await r.text()}`);
  }
  if (!ok) throw new Error("Telegram не принял сообщение — проверьте TG_TOKEN и TG_CHAT_ID");
}
async function webhookSecret(env) { return (await sha1("pw-" + env.TG_TOKEN)).slice(0, 32); }
async function ensureWebhook(env) {
  if (!env.WORKER_URL) return;
  const want = env.WORKER_URL + "/tg";
  const ver = want + "|v2";
  if ((await env.STATE.get("webhook")) === ver) return;
  const r = await tg(env, "setWebhook", { url: want, secret_token: await webhookSecret(env), allowed_updates: ["message", "callback_query"] });
  if (r.ok) await env.STATE.put("webhook", ver); else console.log("setWebhook: " + await r.text());
}

// ---------- единая смена состояния света (от платы или из облака) ----------
async function setGrid(env, gridOn, volts, source, bmsData) {
  const now = nowSec();
  const state = (await env.STATE.get("state", "json")) || {};
  if (state.grid_on === undefined) {
    await env.STATE.put("state", JSON.stringify({ grid_on: gridOn, since: now, src: source }));
    return;
  }
  if (state.grid_on === gridOn) return;
  const dur = fmtDuration(now - (state.since || now));
  const b = bmsData || await getBms(env);
  const next = { ...state, grid_on: gridOn, since: now, src: source };
  let last = null;
  if (!gridOn) { // свет пропал: запоминаем, с чего начали
    next.out = { at: now, soc: b && b.fresh ? b.soc : null, wh: b && b.st ? b.st.tot_out : null };
  } else {       // свет появился: итог отключения + время без света за сегодня
    const o = state.out || {};
    const start = state.since || now;
    last = { start, end: now, soc0: o.soc ?? null, soc1: b && b.fresh ? b.soc : null,
             wh: o.wh != null && b && b.st ? Math.max(0, b.st.tot_out - o.wh) : null };
    next.last = last; delete next.out;
    const today = kyivDay();
    next.off_sec = (state.off_day === today ? state.off_sec || 0 : 0) + (now - start);
    next.off_day = today;
  }
  await env.STATE.put("state", JSON.stringify(next)); // сначала состояние — кнопка «Что сейчас» сразу увидит новое событие
  await tgSendAll(env, gridMsg(gridOn, kyivTime(), dur, b, volts, last), undefined, gridKb(gridOn, now));
}
function gridMsg(gridOn, time, dur, b, volts, last) {
  const fresh = b && b.fresh;
  const R = [row("⏳", "", (gridOn ? "не было " : "был ") + dur)];
  if (gridOn && volts) R.push(row("⚡", "Сеть", `${Math.round(volts)} В`));
  if (fresh) { const fl = battFlowRow(b); if (fl) R.push(fl); }
  if (last && last.soc0 != null && last.soc1 != null) R.push(row("🔋", "", `${Math.round(last.soc0)}% → ${Math.round(last.soc1)}%` + (last.wh != null ? ` · ушло ${kwh(last.wh)}` : "")));
  return msg([lightHead(gridOn, time, true), fresh ? battHead(b) : null, fresh ? timeCell(b) : null], quote(R));
}
async function espIsPrimary(env, b) { // b можно передать, чтобы не читать KV повторно
  if (b === undefined) b = await getBms(env);
  return !!(b && b.online !== false && b.grid != null && b.age < ESP_PRIMARY_MIN * 60);
}

// ---------- проверка раз в минуту ----------
async function check(env) {
  const now = nowSec();
  const link = (await env.STATE.get("link", "json")) || { ts: null, seen: now, saved: 0, lost: false };
  let points;
  try {
    points = await readInverter(env);
  } catch (e) {
    console.log("Ошибка облака: " + e.message);
    points = null;
  }

  // --- связь: данные от инвертора должны обновляться каждые ~5 минут ---
  const ts = points ? val(points, "Timestamp") : null;
  let linkChanged = false;
  if (ts && ts !== link.ts && (link.lost || now - (link.saved || 0) >= LINK_SAVE_SEC)) {
    if (link.lost) {
      await tgSendAll(env, msg([`✅ <b>SmartESS снова на связи</b> · ${kyivTime()}`], quote([row("⏳", "", `не было данных ${fmtDuration(now - link.seen)}`)])), SILENT);
    }
    link.ts = ts; link.seen = now; link.saved = now; link.lost = false; linkChanged = true;
  } else if (!link.lost && (!ts || ts === link.ts) && now - link.seen > STALE_MIN * 60) {
    const viaBoard = await espIsPrimary(env);
    await tgSendAll(env, msg([`⚠️ <b>Нет данных от инвертора (SmartESS)</b> · ${fmtDuration(now - link.seen)}`],
      quote(viaBoard ? ["💡  Свет определяется по плате · ~30 сек"]
                     : ["📟  Плата тоже молчит — скорее всего, дома нет интернета", "Пока связи нет, о свете бот сообщить не сможет"])), viaBoard ? NIGHT_SILENT : undefined);
    link.lost = true; linkChanged = true;
  }
  if (linkChanged) await env.STATE.put("link", JSON.stringify(link));
  if (!points || link.lost) return;

  // --- свет ---
  const volts = findGridVoltage(points);
  if (volts === null) { console.log("Не нашёл напряжение сети"); return; }
  const gridOn = volts >= MIN_VOLTAGE;
  if (await espIsPrimary(env)) {
    // плата быстрее; облако только сверяем
    const st = (await env.STATE.get("state", "json")) || {};
    if (st.grid_on !== undefined && st.grid_on !== gridOn) console.log(`Облако и плата расходятся: облако=${gridOn}, бот=${st.grid_on}`);
  } else {
    await setGrid(env, gridOn, volts, "cloud");
  }
  console.log(`Grid voltage=${volts} V -> ${gridOn ? "есть" : "нет"} (данные от ${ts})`);
}

// ---------- ответы на кнопки ----------
function modeText(points) {
  const m = String(val(points, "Model") || val(points, "Working mode") || "").toLowerCase();
  if (m.includes("line") || m.includes("grid") || m.includes("bypass")) return "от сети";
  if (m.includes("battery")) return "от батареи";
  if (m.includes("standby")) return "ожидание";
  if (m.includes("fault")) return "⚠️ ошибка";
  return m ? m : null;
}
async function statusText(env) {
  const now = nowSec();
  const state = (await env.STATE.get("state", "json")) || {};
  let points = null, err = null;
  try { points = await readInverter(env); } catch (e) { err = e.message; }
  const b = await getBms(env);
  const on = state.grid_on !== undefined ? state.grid_on
           : (points ? (findGridVoltage(points) ?? 0) >= MIN_VOLTAGE : null);
  const head = [lightHead(on, state.since ? fmtDuration(now - state.since) : "")], out = [];
  const fresh = b && b.fresh;
  if (fresh) {
    await enrich(env, b, state);
    head.push(battHead(b), timeCell(b));
  } else if (points) {
    const bv = num(points, "Battery voltage");
    const chg = num(points, "Battery charging current"), dis = num(points, "Battery discharge current");
    const flow = dis ? `${DIS} −${f1(dis)} А` : (chg ? `${CHG} +${f1(chg)} А` : "⏸ 0 А");
    if (bv !== null) head.push(`🔋 <b>${f1(bv)} В</b> · ${flow}`);
  }
  if (points) {
    const volts = findGridVoltage(points);
    const load = num(points, "AC output active power"), pct = num(points, "Output load percent");
    const outV = num(points, "AC output voltage"), outF = num(points, "AC output frequency");
    const g = [];
    g.push(row("⚡", "Сеть", volts !== null && volts >= MIN_VOLTAGE ? Math.round(volts) + " В" : "нет"));
    if (load !== null) g.push(row("🏠", "Нагрузка", `${Math.round(load)} Вт` + (pct !== null ? ` · ${Math.round(pct)}%` : "")));
    if (outV !== null) g.push(row("🔌", "Выход", `${Math.round(outV)} В` + (outF ? ` · ${Math.round(outF)} Гц` : "")));
    const pv = num(points, "PV Charging power"); if (pv) g.push(row("☀️", "Солнце", `${Math.round(pv)} Вт`));
    out.push(quote(g));
  } else if (err) out.push(quote([lrow("⚠️", "SmartESS", esc(err))]));
  const m = ["⚙️ <b>Подробнее</b>"];
  if (points) {
    const md = modeText(points);
    if (md) m.push(lrow(md === "от сети" ? "🗼" : md === "от батареи" ? "🔋" : "🔄", "Режим", esc(md)));
  }
  m.push(lrow("💡", "Свет", lightSrc(await espIsPrimary(env, b))));
  const dd = [points ? `инвертор ${esc(hhmm(val(points, "Timestamp")))}` : null, b && b.at ? `плата ${fmtDuration(b.age)} назад` : null].filter(Boolean);
  if (dd.length) m.push(lrow("🕒", "Данные", dd.join(" · ")));
  if (fresh && b.cycles != null) m.push(lrow("🔁", "Циклов", String(b.cycles)));
  out.push(more(m));
  return msg(head, ...out);
}

function rssiText(r) { return r == null ? "?" : r >= -67 ? "отличный" : r >= -75 ? "хороший" : r >= -85 ? "слабый" : "очень слабый"; }
function lightSrc(esp) { return esp ? "определяется по плате · ~30 сек" : "определяется по SmartESS · до 15 мин"; }
function hhmm(ts) { const m = String(ts || "").match(/(\d{1,2}:\d{2})(:\d{2})?\s*$/); return m ? m[1] : "?"; }
async function linkText(env) {
  const now = nowSec();
  const link = (await env.STATE.get("link", "json")) || {};
  let pts = null;
  try { pts = await readInverter(env); } catch (e) {}
  const rows = [lrow("☁️", "Облако SmartESS", pts ? "✅ отвечает" : "❌ не отвечает")];
  if (link.lost) rows.push(lrow(ICON_INV, "Инвертор → облако", `❌ молчит ${fmtDuration(now - link.seen)}`));
  else if (pts) rows.push(lrow(ICON_INV, "Инвертор → облако", `✅ данные ${esc(hhmm(val(pts, "Timestamp")))}`));
  const b = await getBms(env);
  const boardAlive = b && b.age < BMS_STALE_MIN * 60;
  rows.push(lrow(ICON_BOARD, "Плата → Wi‑Fi", !b ? "⚪ не подключена"
    : boardAlive ? `✅ ${b.rssi ?? "?"} dBm · ${rssiText(b.rssi)}` : `❌ молчит ${fmtDuration(b.age)}`));
  if (b) rows.push(lrow("🔷", "Плата → BMS", !boardAlive ? "❔ неизвестно"
    : b.online !== false ? "✅ Bluetooth на связи" : b.paused ? "⏸ отпущена для приложения JK" : "❌ не видит BMS"));
  rows.push(lrow("🤖", "Бот", "✅ проверка раз в минуту"));
  return msg([`📡 <b>Связь</b>`], quote(rows), quote([lrow("💡", "Свет", lightSrc(await espIsPrimary(env, b)))]));
}

// кнопка «🔄 Обновить» под Состоянием / Батареей / Связью — обновляет то же сообщение
const VIEWS = { status: statusText, battery: batteryText, link: linkText };
const refreshKb = v => ({ inline_keyboard: [[{ text: "🔄 Обновить", callback_data: "r:" + v }],
  ...(v === "battery" ? [[{ text: "🩺 Здоровье батареи", callback_data: "health" }]] : [])] });
const nowHMS = () => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
// 🔄 под сообщением «Свет пропал/появился»: заголовок события не трогаем, обновляем только «что сейчас»
const gridKb = (on, at) => ({ inline_keyboard: [[{ text: "🔄 Что сейчас", callback_data: `g:${on ? 1 : 0}:${Math.round(at)}` }]] });
async function gridLive(env, on, at) {
  const now = nowSec(), st = (await env.STATE.get("state", "json")) || {};
  const b = await getBms(env);
  const fresh = b && b.fresh;
  if (fresh) await enrich(env, b, st);
  const same = st.grid_on === on && Math.abs((st.since || 0) - at) < 5;
  const R = [same ? row("⏳", "", `${on ? "свет есть" : "без света"} уже ${fmtDuration(now - at)}`)
                  : row(st.grid_on ? "🟢" : "🔴", "", `${st.grid_on ? "свет вернулся" : "свет снова пропал"} в ${kyivTime((st.since || now) * 1000)}`)];
  if (fresh) { const fl = battFlowRow(b); if (fl) R.push(fl); }
  return msg([lightHead(on, kyivTime(at * 1000), true), fresh ? battHead(b) : null, fresh ? timeCell(b) : null], quote(R)) + `\n\n<i>🔄 обновлено ${nowHMS()}</i>`;
}
async function handleCallback(env, cq) {
  const chat = String(cq.message?.chat?.id || "");
  if (!chatIds(env).includes(chat)) return;
  if (cq.data === "fw:go") {
    const m = await env.STATE.get("fw_meta", "json");
    if (m) await env.STATE.put("fw_req", JSON.stringify({ ver: m.ver, at: nowSec() }));
    const f = await fwText(env);
    await tg(env, "editMessageText", { chat_id: chat, message_id: cq.message.message_id, parse_mode: "HTML", text: f.text, reply_markup: f.kb });
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Плата обновится в течение 1–2 минут" });
    return;
  }
  if (cq.data === "health") {
    await tg(env, "sendMessage", { chat_id: chat, text: await healthText(env), parse_mode: "HTML" });
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    return;
  }
  const g = String(cq.data || "").match(/^g:([01]):(\d+)$/);
  if (g) {
    const on = g[1] === "1", at = Number(g[2]);
    await tg(env, "editMessageText", { chat_id: chat, message_id: cq.message.message_id, parse_mode: "HTML",
      text: await gridLive(env, on, at), reply_markup: gridKb(on, at) });
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Обновлено" });
    return;
  }
  const v = String(cq.data || "").startsWith("r:") ? cq.data.slice(2) : null;
  if (!VIEWS[v]) { await tg(env, "answerCallbackQuery", { callback_query_id: cq.id }); return; } // старые кнопки
  await tg(env, "editMessageText", { chat_id: chat, message_id: cq.message.message_id, parse_mode: "HTML",
    text: (await VIEWS[v](env)) + `\n\n<i>🔄 обновлено ${nowHMS()}</i>`, reply_markup: refreshKb(v) });
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Обновлено" });
}

async function handleTelegram(request, env) {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== await webhookSecret(env)) {
    return new Response("forbidden", { status: 403 });
  }
  const upd = await request.json();
  if (upd.callback_query) { await handleCallback(env, upd.callback_query); return new Response("ok"); }
  const um = upd.message;
  if (!um || !um.chat) return new Response("ok");
  const chat = String(um.chat.id);
  if (!chatIds(env).includes(chat)) return new Response("ok"); // чужим не отвечаем
  const text = (um.text || "").trim();
  let reply, view = null;
  if (text === BTN_STATUS || text === "/status") view = "status";
  else if (text === BTN_LINK || text === "/link") view = "link";
  else if (text === BTN_BATTERY || text === "/battery") view = "battery";
  if (view) {
    await tg(env, "sendMessage", { chat_id: chat, text: await VIEWS[view](env), parse_mode: "HTML", reply_markup: refreshKb(view) });
    return new Response("ok");
  }
  if (text === "/update") {
    const f = await fwText(env);
    await tg(env, "sendMessage", { chat_id: chat, text: f.text, parse_mode: "HTML", reply_markup: f.kb || KEYBOARD });
    return new Response("ok");
  }
  if (text === "/health") reply = await healthText(env);
  else if (text === "/bmskey") reply = msg(["🔑 <b>Ключ платы</b> (секрет BMS_KEY на GitHub)"], `<code>${await bmsKey(env)}</code>`);
  else if (text === BTN_APP || text === "/app") {
    await env.STATE.put("app_pause_until", String(nowSec() + APP_PAUSE_MIN * 60));
    reply = msg([`📱 <b>Bluetooth BMS свободен на ${APP_PAUSE_MIN} мин</b>`],
      quote(["1️⃣  Подождите ~1 мин, пока плата отключится", "2️⃣  Откройте приложение JK и подключайтесь", "3️⃣  Потом плата подключится сама"]));
  }
  else reply = "Выберите кнопку внизу 👇";
  await tg(env, "sendMessage", { chat_id: chat, text: reply, parse_mode: "HTML", reply_markup: KEYBOARD });
  return new Response("ok");
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try { await ensureWebhook(env); } catch (e) { console.log("webhook: " + e.message); }
      try { await check(env); } catch (e) { console.log("Ошибка: " + e.message); }
      try { await checkBmsLink(env); } catch (e) { console.log("bms link: " + e.message); }
      try { if (kyivTime().startsWith("10:")) await healthDaily(env); } catch (e) { console.log("health: " + e.message); }
      // сторожевой пинг (Healthchecks.io): если бот перестанет работать, сервис сам пришлёт тревогу в Telegram
      if (env.HC_URL) try { await fetch(env.HC_URL); } catch (e) { console.log("hc: " + e.message); }
    })());
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/tg") return handleTelegram(request, env);
    if (request.method === "POST" && url.pathname === "/bms") return handleBms(request, env);
    if (request.method === "POST" && url.pathname === "/fw/upload") return fwUpload(request, env);
    if (request.method === "GET" && url.pathname === "/fw/bin") return fwServe(request, env, "bin");
    if (request.method === "GET" && url.pathname === "/fw/md5") return fwServe(request, env, "md5");
    return new Response("power-watch worker работает", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
