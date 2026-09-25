#!/usr/bin/env python3
"""
Оповещения в Telegram о пропадании/появлении городского света
по данным инвертора из облака SmartESS (DessMonitor).

Режимы:
  python power_watch.py --list   показать все параметры инвертора (проверка)
  python power_watch.py --test   отправить тестовое сообщение в Telegram
  python power_watch.py --once   одна проверка (для GitHub Actions / cron)
  python power_watch.py          бесконечный цикл (для сервера)

Настройки берутся из переменных окружения:
  SMARTESS_USER, SMARTESS_PASS     логин/пароль от приложения SmartESS
  TG_TOKEN, TG_CHAT_ID             токен бота и ваш chat id
  необязательные:
  GRID_MIN_VOLTAGE (170)           ниже этого — считаем, что света нет
  POLL_SECONDS (60)                интервал опроса в режиме цикла
  STATE_FILE (state.json)          где хранить последнее состояние
  API_PROFILE (dessmonitor)        или "shinemonitor", если логин не проходит
"""
import hashlib
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

PROFILES = {
    "dessmonitor": ("https://api.dessmonitor.com/public/", "authSource", "1"),
    "shinemonitor": ("https://ios.shinemonitor.com/public/", "auth", "0"),
}
COMPANY_KEY = os.getenv("COMPANY_KEY", "bnrl_frRFjEz8Mkn")
KYIV = timezone(timedelta(hours=3))  # для текста сообщений


def sha1(s: str) -> str:
    return hashlib.sha1(s.encode()).hexdigest()


def http_json(url: str, data: bytes | None = None) -> dict:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "power-watch"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


class SmartESS:
    def __init__(self, user, password, profile="dessmonitor"):
        self.user, self.password = user, password
        self.base, self.auth_action, self.source = PROFILES[profile]
        self.token = self.secret = None
        self.expire = 0

    def _call(self, action, params=None, auth=False):
        if not auth and (not self.token or time.time() > self.expire - 300):
            self.login()
        act = f"&action={action}" + "".join(
            f"&{k}={urllib.parse.quote_plus(str(v))}" for k, v in (params or {}).items()
        )
        salt = str(int(time.time() * 1000))
        if auth:
            sign = sha1(salt + sha1(self.password) + act)
            url = f"{self.base}?sign={sign}&salt={salt}{act}"
        else:
            sign = sha1(salt + self.secret + self.token + act)
            url = f"{self.base}?sign={sign}&salt={salt}&token={self.token}{act}"
        resp = http_json(url)
        if resp.get("err", 0) != 0:
            raise RuntimeError(f"{action}: {resp.get('err')} {resp.get('desc')}")
        return resp.get("dat")

    def login(self):
        dat = self._call(self.auth_action, {
            "usr": self.user, "company-key": COMPANY_KEY, "source": self.source,
            "_app_client_": "web", "_app_id_": "power-watch", "_app_version_": "1.0",
        }, auth=True)
        self.token, self.secret = dat["token"], dat["secret"]
        self.expire = time.time() + int(dat["expire"])

    def devices(self):
        """Все инверторы аккаунта: список (pn, devcode, devaddr, sn, имя)."""
        out = []
        for plant in (self._call("queryPlants", {"pagesize": 50}) or {}).get("plant", []):
            cols = self._call("webQueryCollectorsEs",
                              {"pid": plant["pid"], "page": 0, "pagesize": 50}) or {}
            for c in cols.get("collector", []):
                devs = self._call("queryCollectorDevices", {"pn": c["pn"]}) or {}
                for d in devs.get("dev", []):
                    out.append((c["pn"], d["devcode"], d["devaddr"], d["sn"],
                                c.get("alias") or plant.get("pname") or d["sn"]))
        return out

    def last_data(self, pn, devcode, devaddr, sn):
        return self._call("queryDeviceLastData", {
            "pn": pn, "devcode": devcode, "devaddr": devaddr, "sn": sn, "i18n": "en"}) or []


def find_grid_voltage(points):
    """Ищем напряжение сети среди параметров (названия у разных моделей разные)."""
    grid_words = ("grid", "ac input", "mains", "utility", "line", "input voltage")
    for p in points:
        t = str(p.get("title", "")).lower()
        if "volt" in t and any(w in t for w in grid_words) and "pv" not in t \
                and "battery" not in t and "output" not in t:
            try:
                return float(p.get("val")), p.get("title")
            except (TypeError, ValueError):
                return 0.0, p.get("title")  # при отключении бывает "--" или пусто
    return None, None


def tg_send(text):
    url = f"https://api.telegram.org/bot{os.environ['TG_TOKEN']}/sendMessage"
    data = urllib.parse.urlencode({"chat_id": os.environ["TG_CHAT_ID"], "text": text}).encode()
    try:
        http_json(url, data)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Telegram не принял сообщение: {e.code} "
                           f"{e.read().decode(errors='ignore')} — проверьте TG_TOKEN и TG_CHAT_ID")


def load_state(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return {}


def save_state(path, state):
    with open(path, "w") as f:
        json.dump(state, f)


def fmt_duration(sec):
    sec = int(sec)
    h, m = sec // 3600, (sec % 3600) // 60
    return f"{h} ч {m} мин" if h else f"{m} мин"


def check(api, min_v, state_path):
    state = load_state(state_path)
    if not getattr(api, "cached_devices", None):
        api.cached_devices = api.devices()
    devs = api.cached_devices
    if not devs:
        raise RuntimeError("Инверторы в аккаунте не найдены")

    pn, devcode, devaddr, sn, name = devs[0]
    volts, title = find_grid_voltage(api.last_data(pn, devcode, devaddr, sn))
    if volts is None:
        raise RuntimeError("Не нашёл напряжение сети — запустите с --list")

    grid_on = volts >= min_v
    now = time.time()
    prev = state.get("grid_on")
    stamp = datetime.now(KYIV).strftime("%H:%M")

    if prev is None:
        state["since"] = now
    elif prev != grid_on:
        dur = fmt_duration(now - state.get("since", now))
        if grid_on:
            tg_send(f"💡 Свет появился ({stamp}), {volts:.0f} В\nНе было: {dur}")
        else:
            tg_send(f"🔌 Свет пропал ({stamp})\nБыл: {dur}")
        state["since"] = now

    state["grid_on"] = grid_on
    save_state(state_path, state)
    print(f"{datetime.now(KYIV):%Y-%m-%d %H:%M:%S} {title}={volts} V -> "
          f"{'есть' if grid_on else 'нет'}", flush=True)


def main():
    api = SmartESS(os.environ["SMARTESS_USER"], os.environ["SMARTESS_PASS"],
                   os.getenv("API_PROFILE", "dessmonitor"))
    min_v = float(os.getenv("GRID_MIN_VOLTAGE", "170"))
    state_path = os.getenv("STATE_FILE", "state.json")
    arg = sys.argv[1] if len(sys.argv) > 1 else ""

    if arg == "--list":
        for pn, devcode, devaddr, sn, name in api.devices():
            print(f"\n=== {name} (sn {sn}, devcode {devcode})")
            for p in api.last_data(pn, devcode, devaddr, sn):
                print(f"  {p.get('title')}: {p.get('val')} {p.get('unit', '')}")
        return
    if arg == "--test":
        tg_send("✅ Бот оповещений о свете подключён")
        print("Отправлено")
        return
    if arg == "--once":
        check(api, min_v, state_path)
        return

    interval = int(os.getenv("POLL_SECONDS", "60"))
    while True:
        try:
            check(api, min_v, state_path)
        except Exception as e:  # сеть/облако иногда сбоят — просто пробуем снова
            print(f"Ошибка: {e}", flush=True)
            api.token = None
        time.sleep(interval)


if __name__ == "__main__":
    main()
