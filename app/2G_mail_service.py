#!/usr/bin/env python3
"""Mail/report service for FieldPos 2G backend."""

from __future__ import annotations

from datetime import datetime
from email.message import EmailMessage
import json
import smtplib
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterable

from runtime import CONFIG, DATA_LOCK, STOP, atomic_json
import os

MAIL_SETTINGS_PATH = None

DEFAULT_REPORT_EMAIL = "opbitlab@dsa.no"
DEFAULT_REPORT_INTERVAL_MINUTES = 60

REPORT_LOCK = threading.Lock()
REPORT_THREAD_STARTED = False


def mail_settings() -> Dict[str, Any]:
    settings = dict(CONFIG["mail"])
    settings["username"] = os.environ.get("FIELDPOS_SMTP_USERNAME", "")
    settings["password"] = os.environ.get("FIELDPOS_SMTP_PASSWORD", "")

    if not settings:
        raise RuntimeError(f"Fant ikke mail-konfigurasjon: {MAIL_SETTINGS_PATH}")

    if settings.get("enabled") is False:
        settings["transport"] = "off"

    transport = str(settings.get("transport", "console")).strip().lower()
    if transport not in {"console", "smtp", "off"}:
        raise RuntimeError(
            f"Ugyldig mail transport: {transport}. Bruk console, smtp eller off."
        )

    settings["transport"] = transport

    if transport == "smtp":
        required = ["host", "username", "password", "from"]
        missing = [key for key in required if not str(settings.get(key) or "").strip()]
        if missing:
            raise RuntimeError(
                f"Mail-konfigurasjon mangler felt: {', '.join(missing)} ({MAIL_SETTINGS_PATH})"
            )

    return settings


write_json_atomic = atomic_json


def parse_float(value: Any, default: Any = None) -> Any:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def append_json_line(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fp:
        fp.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        fp.write("\n")


def load_json_file(path: Path, fallback: Any) -> Any:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback
    return data if isinstance(data, type(fallback)) else fallback


def report_settings(report_settings_path: Path) -> Dict[str, Any]:
    data = load_json_file(report_settings_path, {})
    email = str(data.get("email") or DEFAULT_REPORT_EMAIL).strip() or DEFAULT_REPORT_EMAIL
    interval = parse_float(data.get("intervalMinutes"), DEFAULT_REPORT_INTERVAL_MINUTES)
    interval_minutes = max(1, int(interval or DEFAULT_REPORT_INTERVAL_MINUTES))
    return {
        "email": email,
        "intervalMinutes": interval_minutes,
    }


def save_report_settings(report_settings_path: Path, email: str, interval_minutes: Any) -> Dict[str, Any]:
    interval = parse_float(interval_minutes, DEFAULT_REPORT_INTERVAL_MINUTES)
    payload = {
        "email": (email or DEFAULT_REPORT_EMAIL).strip() or DEFAULT_REPORT_EMAIL,
        "intervalMinutes": max(1, int(interval or DEFAULT_REPORT_INTERVAL_MINUTES)),
        "updatedAt": time.time() * 1000,
    }
    write_json_atomic(report_settings_path, payload)
    return report_settings(report_settings_path)


def report_state(report_state_path: Path) -> Dict[str, Any]:
    state = load_json_file(report_state_path, {})
    if "intervalActive" not in state:
        state["intervalActive"] = False
    return state


def format_ms_time(value: Any) -> str:
    try:
        ts = float(value) / 1000.0
    except Exception:
        return str(value or "")
    return datetime.fromtimestamp(ts).isoformat(timespec="seconds")


def save_report_state(report_state_path: Path, **updates: Any) -> Dict[str, Any]:
    with REPORT_LOCK:
        state = report_state(report_state_path)
        state.update(updates)
        state["updatedAt"] = time.time() * 1000
        write_json_atomic(report_state_path, state)
        return state


def stop_report_interval(report_state_path: Path) -> Dict[str, Any]:
    return save_report_state(
        report_state_path,
        intervalActive=False,
        intervalStoppedAt=time.time() * 1000,
    )


def start_report_interval(report_state_path: Path) -> Dict[str, Any]:
    now_ms = time.time() * 1000
    return save_report_state(
        report_state_path,
        intervalActive=True,
        intervalAnchorAt=now_ms,
        intervalStartedAt=now_ms,
        lastError="",
    )


def read_measurement_lines(measurements_jsonl_path: Path) -> list[str]:
    try:
        return [
            line.strip()
            for line in measurements_jsonl_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    except FileNotFoundError:
        return []
    except Exception:
        return []


def append_measurement_log(measurements_jsonl_path: Path, client_hash: str, measurement: Dict[str, Any]) -> None:
    payload = {
        "loggedAt": time.time() * 1000,
        "clientHash": client_hash,
        "measurement": measurement,
    }
    append_json_line(measurements_jsonl_path, payload)


def measurement_dedupe_key(client_hash: str, measurement: Dict[str, Any], index: int = 0) -> str:
    marker = (
        measurement.get("measurementId")
        or measurement.get("receivedAt")
        or measurement.get("timestamp")
        or measurement.get("csvRow")
        or index
    )
    return f"{client_hash}:{marker}"


def measurements_from_client(client: Dict[str, Any]) -> list[Dict[str, Any]]:
    measurements = []
    if isinstance(client.get("measurements"), list):
        measurements.extend(item for item in client["measurements"] if isinstance(item, dict))
    if isinstance(client.get("lastMeasurement"), dict):
        measurements.append(client["lastMeasurement"])
    return measurements


def backfill_measurement_log_if_missing(measurements_jsonl_path: Path, clients: Iterable[Dict[str, Any]], parse_float_fn: Callable[[Any, Any], Any], safe_client_hash_fn: Callable[[str], str]) -> int:
    if measurements_jsonl_path.exists():
        return len(read_measurement_lines(measurements_jsonl_path))

    seen = set()
    records = []
    clients = list(clients)

    for client in clients:
        if not isinstance(client, dict):
            continue
        client_hash = str(client.get("clientHash") or safe_client_hash_fn(client.get("clientId", "")))
        for index, measurement in enumerate(measurements_from_client(client)):
            key = measurement_dedupe_key(client_hash, measurement, index)
            if key in seen:
                continue
            seen.add(key)
            logged_at = parse_float_fn(measurement.get("receivedAt"), None)
            records.append({
                "loggedAt": logged_at or time.time() * 1000,
                "clientHash": client_hash,
                "measurement": measurement,
            })

    records.sort(key=lambda item: float(item.get("loggedAt", 0) or 0))
    for record in records:
        append_json_line(measurements_jsonl_path, record)
    return len(records)


def send_measurement_report_now(
    measurements_jsonl_path: Path,
    report_settings_path: Path,
    report_state_path: Path,
    parse_presence_fn: Callable[[Any], int],
    activate_interval: bool = False,
    sender: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    settings = report_settings(report_settings_path)
    lines = read_measurement_lines(measurements_jsonl_path)
    now_ms = time.time() * 1000
    attempt_updates = {"lastAttemptAt": now_ms}
    if activate_interval:
        attempt_updates["intervalAnchorAt"] = now_ms
        attempt_updates["intervalActive"] = True
    save_report_state(report_state_path, **attempt_updates)

    message = EmailMessage()
    message["Subject"] = f"FieldPos målinger ({len(lines)})"
    mail_cfg = mail_settings()
    message["From"] = mail_cfg.get("from", "fieldpos@localhost")

    message["To"] = settings["email"]
    sender_info = sender or {}
    sender_lines = [
        "Sendt av:",
        f"Navn: {sender_info.get('name') or 'ukjent'}",
        f"Client ID: {sender_info.get('clientId') or 'ukjent'}",
        f"Client hash: {sender_info.get('clientHash') or 'ukjent'}",
    ]
    if sender_info.get("lat") is not None and sender_info.get("lon") is not None:
        sender_lines.append(f"Posisjon: {sender_info.get('lat')}, {sender_info.get('lon')}")
    if sender_info.get("updatedAt"):
        sender_lines.append(f"Sist sett: {format_ms_time(sender_info.get('updatedAt'))}")

    message.set_content(
        "FieldPos målerapport\n\n"
        + "\n".join(sender_lines)
        + "\n\n"
        f"Antall målinger i fil: {len(lines)}\n"
        f"Fil: {measurements_jsonl_path}\n\n"
        + ("\n".join(lines) if lines else "Ingen målinger registrert.")
    )

    delivery_method = send_report(message, parse_presence_fn)

    sent_updates = {
        "lastSentAt": time.time() * 1000,
        "lastSentTo": settings["email"],
        "lastSentCount": len(lines),
        "lastDeliveryMethod": delivery_method,
        "lastSentBy": sender_info,
        "lastError": "",
    }
    if activate_interval:
        sent_updates["intervalAnchorAt"] = now_ms
        sent_updates["intervalActive"] = True
    return save_report_state(report_state_path, **sent_updates)


def send_report_to_console(message: EmailMessage) -> None:
    print("\n" + "=" * 72, flush=True)
    print("FieldPos MAIL - CONSOLE TRANSPORT", flush=True)
    print("=" * 72, flush=True)
    print(f"Subject: {message.get('Subject', '')}", flush=True)
    print(f"From: {message.get('From', '')}", flush=True)
    print(f"To: {message.get('To', '')}", flush=True)
    print("-" * 72, flush=True)
    print(message.get_content(), flush=True)
    print("=" * 72 + "\n", flush=True)


def send_report(message: EmailMessage, parse_presence_fn: Callable[[Any], int]) -> str:
    settings = mail_settings()
    transport = settings.get("transport", "console")

    if transport == "off":
        return "off"

    if transport == "console":
        send_report_to_console(message)
        return "console"

    if transport == "smtp":
        send_report_via_smtp(message, parse_presence_fn)
        return "smtp"

    raise RuntimeError(f"Ukjent mail transport: {transport}")


def send_report_via_smtp(message: EmailMessage, parse_presence_fn: Callable[[Any], int]) -> None:
    settings = mail_settings()

    host = settings["host"]
    port = int(settings.get("port", 465))
    username = settings["username"]
    password = settings["password"]
    use_ssl = bool(settings.get("ssl", True))
    use_tls = bool(settings.get("tls", False))
    timeout = int(settings.get("timeout", 20))

    if use_ssl:
        with smtplib.SMTP_SSL(host, port, timeout=timeout) as smtp:
            smtp.login(username, password)
            smtp.send_message(message)
    else:
        with smtplib.SMTP(host, port, timeout=timeout) as smtp:
            if use_tls:
                smtp.starttls()
            smtp.login(username, password)
            smtp.send_message(message)


def report_worker(measurements_jsonl_path: Path, report_settings_path: Path, report_state_path: Path, parse_presence_fn: Callable[[Any], int]) -> None:
    while not STOP.is_set():
        with DATA_LOCK:
            report_tick(measurements_jsonl_path, report_settings_path, report_state_path, parse_presence_fn)
        STOP.wait(10)


def report_tick(measurements_jsonl_path, report_settings_path, report_state_path, parse_presence_fn):
        settings = report_settings(report_settings_path)
        state = report_state(report_state_path)
        now_ms = time.time() * 1000
        interval_ms = settings["intervalMinutes"] * 60 * 1000
        interval_active = bool(state.get("intervalActive"))
        interval_anchor_at = float(state.get("intervalAnchorAt", 0) or 0)
        last_sent_at = float(state.get("lastSentAt", 0) or 0)
        last_attempt_at = float(state.get("lastAttemptAt", 0) or 0)
        last_report_activity_at = max(interval_anchor_at, last_sent_at, last_attempt_at)

        if not interval_active or interval_anchor_at <= 0:
            pass
        elif last_report_activity_at <= 0:
            save_report_state(report_state_path, lastAttemptAt=now_ms)
        elif now_ms - last_report_activity_at >= interval_ms:
            try:
                save_report_state(report_state_path, lastAttemptAt=now_ms, intervalAnchorAt=now_ms)
                send_measurement_report_now(
                    measurements_jsonl_path,
                    report_settings_path,
                    report_state_path,
                    parse_presence_fn,
                    activate_interval=False,
                    sender={"name": "admin", "clientId": "admin", "clientHash": "admin"},
                )
                save_report_state(report_state_path, intervalAnchorAt=now_ms, intervalActive=True)
            except Exception as err:
                save_report_state(
                    report_state_path,
                    lastError=str(err),
                    lastErrorAt=time.time() * 1000,
                )




def start_report_thread(measurements_jsonl_path: Path, report_settings_path: Path, report_state_path: Path, parse_presence_fn: Callable[[Any], int]) -> None:
    global REPORT_THREAD_STARTED
    if REPORT_THREAD_STARTED:
        return
    REPORT_THREAD_STARTED = True
    thread = threading.Thread(
        target=report_worker,
        args=(measurements_jsonl_path, report_settings_path, report_state_path, parse_presence_fn),
        name="fieldpos-report-mailer",
        daemon=True,
    )
    thread.start()
    return thread
