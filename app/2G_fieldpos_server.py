#!/usr/bin/env python3
"""
2G_fieldpos_server.py

Minimal, selvstendig FieldPos-server:
- server statiske filer fra prosjektmappen
- tar imot browser-GPS fra frontend
- lagrer klienter i data/online2/clients/<clientHash>/2g_user_position.json
- returnerer alle aktive klienter via /api/my-position/presence
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import re
import threading
import time
from http.server import SimpleHTTPRequestHandler
from runtime import DATA_DIR, STATIC_DIR, effective_wind_config, save_wind_settings, atomic_json
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).parent.resolve()
MAIL_SERVICE_PATH = ROOT / "2G_mail_service.py"
MET_WIND_LOADER_PATH = ROOT / "2G_met_wind_loader.py"
ONLINE2_DIR = DATA_DIR / "online2"
CLIENTS_DIR = ONLINE2_DIR / "clients"
PRESENCE_STATE_PATH = ONLINE2_DIR / "2g_presence_clients.json"
MEASUREMENTS_JSONL_PATH = ONLINE2_DIR / "fieldpos_measurements.jsonl"
REPORT_SETTINGS_PATH = ONLINE2_DIR / "fieldpos_report_settings.json"
REPORT_STATE_PATH = ONLINE2_DIR / "fieldpos_report_state.json"
MET_WIND_CONFIG_PATH = DATA_DIR / "state" / "wind_settings.json"
MET_WIND_AREA_OUTPUT_PATH = ONLINE2_DIR / "met_wind_area.geojson"
OFFLINE_COORD = -999.0
ACTIVE_CLIENT_TTL_SECONDS = 90
DEFAULT_MET_WIND_GRID_STEP_KM = 5.0
DEFAULT_MET_WIND_NEARBY_RADIUS_KM = 25.0
DEFAULT_MET_WIND_MAX_GRID_POINTS = 600


MET_WIND_VALID_AREAS = {"southNorway", "northNorway", "norway"}

ACTIVE_CLIENTS: Dict[str, Dict[str, Any]] = {}
ACTIVE_CLIENTS_LOCK = threading.Lock()
MET_WIND_REFRESH_LOCK = threading.Lock()
MET_WIND_REFRESH_RUNNING = False
MET_WIND_REFRESH_PENDING_REASON: Optional[str] = None
MET_WIND_REFRESH_STATE: Dict[str, Any] = {}
MET_WIND_AREA_REFRESH_LOCK = threading.RLock()
MET_WIND_AREA_REFRESH_RUNNING = False
MET_WIND_AREA_REFRESH_STATE: Dict[str, Any] = {}


def load_mail_service() -> Any:
    spec = importlib.util.spec_from_file_location("fieldpos_mail_service", MAIL_SERVICE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Klarte ikke å laste mail service: {MAIL_SERVICE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mail_service = load_mail_service()


def load_met_wind_loader() -> Any:
    spec = importlib.util.spec_from_file_location("fieldpos_met_wind_loader", MET_WIND_LOADER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Klarte ikke å laste MET wind loader: {MET_WIND_LOADER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


write_json_atomic = atomic_json


def read_met_wind_config() -> Dict[str, Any]:
    return effective_wind_config()


def normalized_met_wind_config() -> Dict[str, Any]:
    loader = load_met_wind_loader()
    cfg = dict(getattr(loader, "DEFAULT_CONFIG", {}))
    existing = read_met_wind_config()
    cfg.update(existing)

    default_fallback = dict(getattr(loader, "DEFAULT_CONFIG", {}).get("fallbackCenter", {}))
    existing_fallback = existing.get("fallbackCenter")
    if isinstance(existing_fallback, dict):
        default_fallback.update(existing_fallback)
    cfg["fallbackCenter"] = default_fallback
    return cfg


def met_wind_settings_payload() -> Dict[str, Any]:
    cfg = normalized_met_wind_config()
    nearby_radius_km = parse_float(cfg.get("nearbyRadiusKm"), DEFAULT_MET_WIND_NEARBY_RADIUS_KM)
    nearby_radius_km = max(1.0, float(nearby_radius_km or DEFAULT_MET_WIND_NEARBY_RADIUS_KM))
    selected = cfg.get("selectedReferenceKeys")
    custom_refs = cfg.get("customReferencePoints")
    return {
        "gridMode": cfg.get("gridMode") or "nearbyPoints",
        "windArea": cfg.get("windArea") or "",
        "gridStepKm": parse_float(cfg.get("gridStepKm"), DEFAULT_MET_WIND_GRID_STEP_KM),
        "nearbyRadiusKm": int(nearby_radius_km) if nearby_radius_km.is_integer() else nearby_radius_km,
        "selectedReferenceKeys": selected if isinstance(selected, list) else None,
        "customReferencePoints": custom_refs if isinstance(custom_refs, list) else [],
        "maxGridPoints": int(parse_float(cfg.get("maxGridPoints"), DEFAULT_MET_WIND_MAX_GRID_POINTS) or DEFAULT_MET_WIND_MAX_GRID_POINTS),
        "refreshMinutes": int(parse_float(cfg.get("refreshMinutes"), 5) or 5),
        "configPath": str(MET_WIND_CONFIG_PATH),
        "refresh": met_wind_refresh_state(),
    }


def met_wind_refresh_state() -> Dict[str, Any]:
    with MET_WIND_REFRESH_LOCK:
        return {
            "running": MET_WIND_REFRESH_RUNNING,
            **MET_WIND_REFRESH_STATE,
        }


def met_wind_area_refresh_state() -> Dict[str, Any]:
    with MET_WIND_AREA_REFRESH_LOCK:
        return {
            "running": MET_WIND_AREA_REFRESH_RUNNING,
            **MET_WIND_AREA_REFRESH_STATE,
        }


def met_wind_area_settings_payload() -> Dict[str, Any]:
    cfg = normalized_met_wind_config()
    area = str(cfg.get("windAreaLayerArea") or "").strip()
    if area not in MET_WIND_VALID_AREAS:
        legacy_area = str(cfg.get("windArea") or "").strip()
        area = legacy_area if legacy_area in MET_WIND_VALID_AREAS else ""
    return {
        "enabled": bool(cfg.get("windAreaLayerEnabled", False)),
        "area": area,
        "gridStepKm": 50,
        "outputPath": str(MET_WIND_AREA_OUTPUT_PATH),
        "refresh": met_wind_area_refresh_state(),
    }


def save_met_wind_area_settings(enabled: Optional[bool] = None, area: Optional[str] = None) -> Dict[str, Any]:
    cfg = normalized_met_wind_config()
    if enabled is not None:
        cfg["windAreaLayerEnabled"] = bool(enabled)
    area = str(area or "").strip()
    if area in MET_WIND_VALID_AREAS:
        cfg["windAreaLayerArea"] = area
    save_wind_settings(cfg)
    return met_wind_area_settings_payload()


def trigger_met_wind_area_refresh(area: str) -> Dict[str, Any]:
    global MET_WIND_AREA_REFRESH_RUNNING
    area = str(area or "").strip()
    if area not in MET_WIND_VALID_AREAS:
        return met_wind_area_refresh_state()

    with MET_WIND_AREA_REFRESH_LOCK:
        if MET_WIND_AREA_REFRESH_RUNNING:
            MET_WIND_AREA_REFRESH_STATE.update({
                "pendingArea": area,
                "restartPending": True,
            })
            return met_wind_area_refresh_state()
        MET_WIND_AREA_REFRESH_RUNNING = True
        MET_WIND_AREA_REFRESH_STATE.clear()
        MET_WIND_AREA_REFRESH_STATE.update({
            "area": area,
            "startedAt": time.time() * 1000,
            "lastError": "",
            "completed": 0,
            "total": 0,
            "errors": 0,
        })

    def worker() -> None:
        global MET_WIND_AREA_REFRESH_RUNNING

        def progress_update(progress: Dict[str, Any]) -> None:
            with MET_WIND_AREA_REFRESH_LOCK:
                MET_WIND_AREA_REFRESH_STATE.update({
                    "completed": int(progress.get("completed", 0) or 0),
                    "total": int(progress.get("total", 0) or 0),
                    "errors": int(progress.get("errors", 0) or 0),
                    "lastProgressAt": time.time() * 1000,
                })

        pending_area = None
        try:
            loader = load_met_wind_loader()
            cfg = normalized_met_wind_config()
            cfg.update({
                "gridMode": "area",
                "windArea": area,
                "gridStepKm": 50,
                "outputPath": str(MET_WIND_AREA_OUTPUT_PATH),
                "disableConfigAbort": True,
            })
            loader.run_once(cfg, progress_callback=progress_update)
            with MET_WIND_AREA_REFRESH_LOCK:
                MET_WIND_AREA_REFRESH_STATE.update({
                    "area": area,
                    "finishedAt": time.time() * 1000,
                    "lastError": "",
                })
        except Exception as err:
            with MET_WIND_AREA_REFRESH_LOCK:
                MET_WIND_AREA_REFRESH_STATE.update({
                    "finishedAt": time.time() * 1000,
                    "lastError": str(err),
                })
        finally:
            with MET_WIND_AREA_REFRESH_LOCK:
                MET_WIND_AREA_REFRESH_RUNNING = False
                pending_area = MET_WIND_AREA_REFRESH_STATE.pop("pendingArea", None)
                MET_WIND_AREA_REFRESH_STATE["restartPending"] = False
            if pending_area:
                trigger_met_wind_area_refresh(str(pending_area))

    threading.Thread(target=worker, name="fieldpos-met-wind-area-refresh", daemon=True).start()
    return met_wind_area_refresh_state()


def trigger_met_wind_refresh(reason: str) -> Dict[str, Any]:
    global MET_WIND_REFRESH_PENDING_REASON, MET_WIND_REFRESH_RUNNING

    with MET_WIND_REFRESH_LOCK:
        if MET_WIND_REFRESH_RUNNING:
            MET_WIND_REFRESH_PENDING_REASON = reason
            MET_WIND_REFRESH_STATE.update({
                "pendingReason": reason,
                "restartPending": True,
            })
            return {
                "running": MET_WIND_REFRESH_RUNNING,
                **MET_WIND_REFRESH_STATE,
            }
        MET_WIND_REFRESH_RUNNING = True
        MET_WIND_REFRESH_PENDING_REASON = None
        MET_WIND_REFRESH_STATE.clear()
        MET_WIND_REFRESH_STATE.update({
            "reason": reason,
            "startedAt": time.time() * 1000,
            "lastError": "",
            "completed": 0,
            "total": 0,
            "errors": 0,
        })

    def worker() -> None:
        global MET_WIND_REFRESH_PENDING_REASON, MET_WIND_REFRESH_RUNNING
        def progress_update(progress: Dict[str, Any]) -> None:
            with MET_WIND_REFRESH_LOCK:
                MET_WIND_REFRESH_STATE.update({
                    "completed": int(progress.get("completed", 0) or 0),
                    "total": int(progress.get("total", 0) or 0),
                    "errors": int(progress.get("errors", 0) or 0),
                    "gridMode": progress.get("gridMode") or MET_WIND_REFRESH_STATE.get("gridMode"),
                    "gridStepKm": progress.get("gridStepKm") or MET_WIND_REFRESH_STATE.get("gridStepKm"),
                    "lastProgressAt": time.time() * 1000,
                })

        try:
            loader = load_met_wind_loader()
            cfg = loader.load_config(MET_WIND_CONFIG_PATH)
            loader.run_once(cfg, progress_callback=progress_update)
            with MET_WIND_REFRESH_LOCK:
                MET_WIND_REFRESH_STATE.update({
                    "finishedAt": time.time() * 1000,
                    "lastError": "",
                })
        except Exception as err:
            with MET_WIND_REFRESH_LOCK:
                MET_WIND_REFRESH_STATE.update({
                    "finishedAt": time.time() * 1000,
                    "lastError": str(err),
                })
        finally:
            pending_reason = None
            with MET_WIND_REFRESH_LOCK:
                MET_WIND_REFRESH_RUNNING = False
                pending_reason = MET_WIND_REFRESH_PENDING_REASON
                MET_WIND_REFRESH_PENDING_REASON = None
                MET_WIND_REFRESH_STATE.pop("pendingReason", None)
                MET_WIND_REFRESH_STATE["restartPending"] = False
            if pending_reason:
                trigger_met_wind_refresh(pending_reason)

    threading.Thread(target=worker, name="fieldpos-met-wind-refresh", daemon=True).start()
    return met_wind_refresh_state()


def met_wind_reference_candidates() -> Dict[str, Any]:
    loader = load_met_wind_loader()
    cfg = loader.load_config(MET_WIND_CONFIG_PATH)
    selected = cfg.get("selectedReferenceKeys")
    custom_refs = cfg.get("customReferencePoints")
    return {
        "references": loader.collect_reference_points(cfg, apply_selection=False),
        "selectedReferenceKeys": selected if isinstance(selected, list) else None,
        "customReferencePoints": custom_refs if isinstance(custom_refs, list) else [],
    }


def sanitize_met_wind_custom_references(raw_refs: Any) -> list[Dict[str, Any]]:
    cleaned: list[Dict[str, Any]] = []
    if not isinstance(raw_refs, list):
        return cleaned
    for index, ref in enumerate(raw_refs, start=1):
        if not isinstance(ref, dict):
            continue
        lat = parse_float(ref.get("lat"))
        lon = parse_float(ref.get("lon"))
        if lat is None or lon is None or not math.isfinite(lat) or not math.isfinite(lon):
            continue
        if lat < -90 or lat > 90 or lon < -180 or lon > 180:
            continue
        lat = round(float(lat), 6)
        lon = round(float(lon), 6)
        key = str(ref.get("key") or f"manual:{lat:.6f},{lon:.6f}").strip()
        if not key:
            key = f"manual:{lat:.6f},{lon:.6f}"
        cleaned.append({
            "lat": lat,
            "lon": lon,
            "key": key,
            "label": str(ref.get("label") or f"Valgt kartpunkt {index}").strip(),
        })
    return cleaned


def save_met_wind_settings(
    grid_step_km: Any,
    nearby_radius_km: Any = None,
    selected_reference_keys: Optional[list[str]] = None,
    custom_reference_points: Optional[list[Dict[str, Any]]] = None,
    wind_area: Optional[str] = None,
    trigger_refresh: bool = True,
) -> Dict[str, Any]:
    step = parse_float(grid_step_km, DEFAULT_MET_WIND_GRID_STEP_KM)
    if step is None or not math.isfinite(step):
        step = DEFAULT_MET_WIND_GRID_STEP_KM
    step = max(0.5, min(100.0, step))
    radius = parse_float(nearby_radius_km, DEFAULT_MET_WIND_NEARBY_RADIUS_KM)
    if radius is None or not math.isfinite(radius):
        radius = DEFAULT_MET_WIND_NEARBY_RADIUS_KM
    radius = max(1.0, min(500.0, radius))

    cfg = normalized_met_wind_config()
    wind_area = str(wind_area or "").strip()
    if wind_area in {"southNorway", "northNorway", "norway"}:
        cfg["gridMode"] = "area"
        cfg["windArea"] = wind_area
        step = 50.0
    else:
        cfg["gridMode"] = "nearbyPoints"
        cfg["windArea"] = ""
    cfg["gridStepKm"] = int(step) if float(step).is_integer() else step
    cfg["nearbyRadiusKm"] = int(radius) if float(radius).is_integer() else radius
    if selected_reference_keys is not None:
        cfg["selectedReferenceKeys"] = [
            str(key)
            for key in selected_reference_keys
            if str(key).strip()
        ]
    if custom_reference_points is not None:
        cfg["customReferencePoints"] = sanitize_met_wind_custom_references(custom_reference_points)
    cfg["configGeneration"] = int(cfg.get("configGeneration", 0) or 0) + 1
    if "maxGridPoints" not in cfg:
        cfg["maxGridPoints"] = DEFAULT_MET_WIND_MAX_GRID_POINTS
    save_wind_settings(cfg)
    if trigger_refresh:
        trigger_met_wind_refresh("settings-saved")
    return met_wind_settings_payload()



def parse_float(value: Any, default: Optional[float] = None) -> Optional[float]:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def parse_presence(value: Any) -> int:
    v = str(value or "").strip().lower()
    return 1 if v in {"1", "true", "yes", "on", "online"} else 0


def valid_lat_lon(lat: Any, lon: Any) -> bool:
    try:
        lat_f = float(lat)
        lon_f = float(lon)
    except (TypeError, ValueError):
        return False

    return (
        math.isfinite(lat_f)
        and math.isfinite(lon_f)
        and -90 <= lat_f <= 90
        and -180 <= lon_f <= 180
    )


def safe_client_hash(client_id: str) -> str:
    return hashlib.sha256(str(client_id or "anonymous").encode("utf-8")).hexdigest()[:16]


def client_dir(client_hash: str) -> Path:
    clean = re.sub(r"[^a-fA-F0-9]", "", str(client_hash or ""))[:32]
    if not clean:
        clean = safe_client_hash("anonymous")
    return CLIENTS_DIR / clean


def client_position_path(client_hash: str) -> Path:
    return client_dir(client_hash) / "2g_user_position.json"


def persist_presence_state() -> None:
    with ACTIVE_CLIENTS_LOCK:
        payload = {
            "ok": True,
            "updatedAt": time.time() * 1000,
            "clients": list(ACTIVE_CLIENTS.values()),
        }
    write_json_atomic(PRESENCE_STATE_PATH, payload)


def load_presence_state() -> None:
    try:
        data = json.loads(PRESENCE_STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return

    clients = data.get("clients") if isinstance(data, dict) else None
    if not isinstance(clients, list):
        return

    with ACTIVE_CLIENTS_LOCK:
        for client in clients:
            if not isinstance(client, dict):
                continue
            client_hash = str(client.get("clientHash") or "")
            if client_hash:
                ACTIVE_CLIENTS[client_hash] = client


def sync_client_files_state() -> None:
    for path in CLIENTS_DIR.glob("*/2g_user_position.json"):
        try:
            client = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue

        if not isinstance(client, dict):
            continue

        client_hash = str(client.get("clientHash") or path.parent.name or "")
        if not client_hash:
            continue

        client["clientHash"] = client_hash
        file_updated = path.stat().st_mtime * 1000
        incoming_updated = max(float(client.get("updatedAt", 0) or 0), file_updated)
        client["updatedAt"] = incoming_updated

        with ACTIVE_CLIENTS_LOCK:
            existing = ACTIVE_CLIENTS.get(client_hash)
            existing_updated = float(existing.get("updatedAt", 0) or 0) if existing else -1

            if existing is None or incoming_updated >= existing_updated:
                ACTIVE_CLIENTS[client_hash] = client


def update_active_client(
    client_id: str,
    client_hash: str,
    lat: Optional[float],
    lon: Optional[float],
    speed: Optional[float],
    heading: Optional[float],
    presence: int,
    name: str = "",
    last_measurement: Optional[Dict[str, Any]] = None,
) -> None:
    now_ms = time.time() * 1000
    presence = 1 if int(presence or 0) == 1 else 0
    clean_name = str(name or "").strip()[:24]

    if presence != 1 or not valid_lat_lon(lat, lon):
        presence = 0
        lat = OFFLINE_COORD
        lon = OFFLINE_COORD
        speed = 0.0
        heading = 0.0

    with ACTIVE_CLIENTS_LOCK:
        previous = ACTIVE_CLIENTS.get(client_hash)

    payload = {
        "clientId": client_id,
        "clientHash": client_hash,
        "shortName": f"U{client_hash[-4:]}",
        "name": clean_name or f"U{client_hash[-4:]}",
        "displayName": clean_name or f"U{client_hash[-4:]}",
        "presence": presence,
        "lat": float(lat),
        "lon": float(lon),
        "speed": float(speed or 0),
        "heading": float(heading or 0),
        "updatedAt": now_ms,
    }

    if last_measurement is not None:
        mail_service.append_measurement_log(MEASUREMENTS_JSONL_PATH, client_hash, last_measurement)
        payload["lastMeasurement"] = last_measurement
        previous_measurements = []
        if previous and isinstance(previous.get("measurements"), list):
            previous_measurements = [
                item for item in previous["measurements"]
                if isinstance(item, dict)
            ]
        elif previous and isinstance(previous.get("lastMeasurement"), dict):
            previous_measurements = [previous["lastMeasurement"]]

        seen_measurements = set()
        measurements = []
        for index, item in enumerate([*previous_measurements, last_measurement]):
            marker = str(
                item.get("measurementId")
                or item.get("receivedAt")
                or item.get("timestamp")
                or index
            )
            if marker in seen_measurements:
                continue
            seen_measurements.add(marker)
            measurements.append(item)

        payload["measurements"] = measurements[-100:]
    elif previous and isinstance(previous.get("lastMeasurement"), dict):
        payload["lastMeasurement"] = previous["lastMeasurement"]
        if isinstance(previous.get("measurements"), list):
            payload["measurements"] = previous["measurements"]
        else:
            payload["measurements"] = [previous["lastMeasurement"]]

    with ACTIVE_CLIENTS_LOCK:
        ACTIVE_CLIENTS[client_hash] = payload

    write_json_atomic(client_position_path(client_hash), payload)
    persist_presence_state()


def get_active_clients() -> list[Dict[str, Any]]:
    sync_client_files_state()

    now_ms = time.time() * 1000
    ttl_ms = ACTIVE_CLIENT_TTL_SECONDS * 1000

    with ACTIVE_CLIENTS_LOCK:
        def has_measurements(client: Dict[str, Any]) -> bool:
            return (
                isinstance(client.get("measurements"), list)
                and len(client.get("measurements") or []) > 0
            ) or isinstance(client.get("lastMeasurement"), dict)

        stale = [
            h for h, c in ACTIVE_CLIENTS.items()
            if now_ms - float(c.get("updatedAt", 0)) > ttl_ms and not has_measurements(c)
        ]

        for h in stale:
            ACTIVE_CLIENTS.pop(h, None)

        clients = []
        for client in ACTIVE_CLIENTS.values():
            active_position = (
                int(client.get("presence", 0)) == 1
                and valid_lat_lon(client.get("lat"), client.get("lon"))
                and now_ms - float(client.get("updatedAt", 0)) <= ttl_ms
            )
            if active_position or has_measurements(client):
                item = dict(client)
                if not active_position:
                    item["presence"] = 0
                clients.append(item)

    clients.sort(key=lambda c: str(c.get("displayName") or c.get("clientHash") or ""))
    return clients


def known_report_client(client_hash: str, client_id: str) -> Optional[Dict[str, Any]]:
    sync_client_files_state()
    with ACTIVE_CLIENTS_LOCK:
        client = ACTIVE_CLIENTS.get(str(client_hash or ""))
        if not client:
            return None
        if str(client.get("clientId") or "") != str(client_id or ""):
            return None
        return dict(client)

def clear_all_measurements() -> Dict[str, int]:
    removed_measurements = 0
    removed_clients = 0

    sync_client_files_state()

    with ACTIVE_CLIENTS_LOCK:
        removed_clients = len(ACTIVE_CLIENTS)
        ACTIVE_CLIENTS.clear()

    file_count = 0
    for path in CLIENTS_DIR.glob("*/2g_user_position.json"):
        file_count += 1
        try:
            client = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            client = {}

        if isinstance(client, dict):
            if isinstance(client.get("measurements"), list):
                removed_measurements += len(client.get("measurements") or [])
            elif isinstance(client.get("lastMeasurement"), dict):
                removed_measurements += 1

        path.unlink(missing_ok=True)
        try:
            path.parent.rmdir()
        except OSError:
            pass

    removed_clients = max(removed_clients, file_count)
    MEASUREMENTS_JSONL_PATH.unlink(missing_ok=True)
    persist_presence_state()
    return {
        "removedMeasurements": removed_measurements,
        "removedClients": removed_clients,
    }

def send_json(handler: SimpleHTTPRequestHandler, status: int, payload: Any) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def create_handler(verbose: bool = False):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

        def do_GET(self):
            parsed = urlparse(self.path)

            if parsed.path == "/api/my-position/presence":
                qs = parse_qs(parsed.query)
                client_id = qs.get("clientId", [None])[0]
                client_hash = safe_client_hash(client_id) if client_id else None

                if client_id is not None and "presence" in qs:
                    presence = parse_presence(qs.get("presence", ["0"])[0])
                    lat = parse_float(qs.get("lat", [OFFLINE_COORD])[0], OFFLINE_COORD)
                    lon = parse_float(qs.get("lon", [OFFLINE_COORD])[0], OFFLINE_COORD)
                    speed = parse_float(qs.get("speed", [0])[0], 0.0)
                    heading = parse_float(qs.get("heading", [0])[0], 0.0)
                    name = qs.get("name", [""])[0]
                    last_measurement = None

                    if parse_presence(qs.get("measurement", ["0"])[0]) == 1:
                        measurement_lon = qs.get("measurementLon", [""])[0] or str(lon)
                        measurement_lat = qs.get("measurementLat", [""])[0] or str(lat)
                        last_measurement = {
                            "measurementId": qs.get("measurementId", [""])[0] or f"m-{time.time_ns()}",
                            "module": qs.get("measurementModule", ["A"])[0],
                            "stationName": qs.get("stationName", [""])[0],
                            "doserate": qs.get("doserate", [""])[0],
                            "timestamp": qs.get("measurementTimestamp", [""])[0],
                            "measurementHeight": qs.get("measurementHeight", [""])[0],
                            "measurementType": qs.get("measurementType", [""])[0],
                            "longitude": measurement_lon,
                            "latitude": measurement_lat,
                            "measuringPointId": qs.get("measuringPointId", [""])[0],
                            "measuringPointName": qs.get("measuringPointName", [""])[0],
                            "session": qs.get("measurementSession", [""])[0],
                            "team": qs.get("measurementTeam", [""])[0],
                            "event": qs.get("measurementEvent", [""])[0],
                            "instrumentNumber": qs.get("instrumentNumber", [""])[0],
                            "snowDepth": qs.get("snowDepth", [""])[0],
                            "rainfall": parse_presence(qs.get("rainfall", ["0"])[0]) == 1,
                            "comment": qs.get("measurementComment", [""])[0],
                            "csvRow": qs.get("csvRow", [""])[0],
                            "receivedAt": time.time() * 1000,
                        }

                    update_active_client(
                        client_id=client_id,
                        client_hash=client_hash,
                        lat=lat,
                        lon=lon,
                        speed=speed,
                        heading=heading,
                        presence=presence,
                        name=name,
                        last_measurement=last_measurement,
                    )

                    if verbose:
                        print(
                            f"[FieldPos] presence client={client_hash} presence={presence} lat={lat} lon={lon}",
                            flush=True,
                        )

                send_json(
                    self,
                    200,
                    {
                        "ok": True,
                        "clientId": client_id,
                        "clientHash": client_hash,
                        "activeClients": get_active_clients(),
                    },
                )
                return

            if parsed.path == "/api/measurements/clear":
                if not self.is_admin:
                    send_json(self, 403, {"ok": False, "error": "Administrator kreves"})
                    return
                reset_result = clear_all_measurements()
                send_json(
                    self,
                    200,
                    {
                        "ok": True,
                        **reset_result,
                        "activeClients": get_active_clients(),
                    },
                )
                return

            if parsed.path == "/api/report-settings":
                qs = parse_qs(parsed.query)
                if "email" in qs or "intervalMinutes" in qs:
                    if not self.is_admin:
                        send_json(self, 403, {"ok": False, "error": "Administrator kreves"})
                        return
                    settings = mail_service.save_report_settings(
                        REPORT_SETTINGS_PATH,
                        qs.get("email", [mail_service.DEFAULT_REPORT_EMAIL])[0],
                        qs.get("intervalMinutes", [mail_service.DEFAULT_REPORT_INTERVAL_MINUTES])[0],
                    )
                else:
                    settings = mail_service.report_settings(REPORT_SETTINGS_PATH)

                lines = mail_service.read_measurement_lines(MEASUREMENTS_JSONL_PATH)
                send_json(
                    self,
                    200,
                    {
                        "ok": True,
                        "settings": settings,
                        "state": mail_service.report_state(REPORT_STATE_PATH),
                        "measurementLogPath": str(MEASUREMENTS_JSONL_PATH),
                        "measurementCount": len(lines),
                    },
                )
                return

            if parsed.path == "/api/met-wind-settings":
                qs = parse_qs(parsed.query, keep_blank_values=True)
                if "gridStepKm" in qs or "nearbyRadiusKm" in qs or "nearbyDiameterKm" in qs or "selectedReferences" in qs or "customReferences" in qs or "windArea" in qs:
                    if not self.is_admin:
                        send_json(self, 403, {"ok": False, "error": "Vindadmin kreves"})
                        return
                    radius_value = qs.get("nearbyRadiusKm", [None])[0]
                    if radius_value is None and "nearbyDiameterKm" in qs:
                        radius_value = (parse_float(qs.get("nearbyDiameterKm", [DEFAULT_MET_WIND_NEARBY_RADIUS_KM * 2])[0], DEFAULT_MET_WIND_NEARBY_RADIUS_KM * 2) or DEFAULT_MET_WIND_NEARBY_RADIUS_KM * 2) / 2.0
                    selected_refs = None
                    if "selectedReferences" in qs:
                        raw_selected_refs = qs.get("selectedReferences", ["[]"])[0] or "[]"
                        try:
                            parsed_selected_refs = json.loads(raw_selected_refs)
                        except Exception:
                            parsed_selected_refs = []
                        selected_refs = parsed_selected_refs if isinstance(parsed_selected_refs, list) else []
                    custom_refs = None
                    if "customReferences" in qs:
                        raw_custom_refs = qs.get("customReferences", ["[]"])[0] or "[]"
                        try:
                            parsed_custom_refs = json.loads(raw_custom_refs)
                        except Exception:
                            parsed_custom_refs = []
                        custom_refs = parsed_custom_refs if isinstance(parsed_custom_refs, list) else []
                    settings = save_met_wind_settings(
                        qs.get("gridStepKm", [DEFAULT_MET_WIND_GRID_STEP_KM])[0],
                        radius_value if radius_value is not None else DEFAULT_MET_WIND_NEARBY_RADIUS_KM,
                        selected_refs,
                        custom_refs,
                        qs.get("windArea", [""])[0],
                    )
                else:
                    settings = met_wind_settings_payload()
                send_json(self, 200, {"ok": True, "settings": settings})
                return

            if parsed.path == "/api/met-wind-references":
                payload = met_wind_reference_candidates()
                send_json(self, 200, {"ok": True, **payload})
                return

            if parsed.path == "/api/met-wind-area-settings":
                qs = parse_qs(parsed.query, keep_blank_values=True)
                area = qs.get("area", [""])[0]
                has_enabled = "enabled" in qs
                if area in MET_WIND_VALID_AREAS or has_enabled:
                    if not self.is_admin:
                        send_json(self, 403, {"ok": False, "error": "Vindadmin kreves"})
                        return
                    enabled_value = None
                    if has_enabled:
                        enabled_value = qs.get("enabled", ["0"])[0].strip().lower() in {"1", "true", "yes", "on"}
                    settings = save_met_wind_area_settings(
                        enabled=True if area in MET_WIND_VALID_AREAS else enabled_value,
                        area=area,
                    )
                    state = trigger_met_wind_area_refresh(area) if area in MET_WIND_VALID_AREAS else settings["refresh"]
                else:
                    settings = met_wind_area_settings_payload()
                    state = settings["refresh"]
                send_json(self, 200, {
                    "ok": True,
                    **met_wind_area_settings_payload(),
                    "refresh": state,
                })
                return

            if parsed.path == "/api/report-send-now":
                qs = parse_qs(parsed.query, keep_blank_values=True)
                sender_client = known_report_client(qs.get("clientHash", [""])[0], qs.get("clientId", [""])[0])
                if not sender_client:
                    send_json(self, 403, {"ok": False, "error": "Identifisert klient kreves"})
                    return
                sender = {
                    "clientId": sender_client.get("clientId") or qs.get("clientId", [""])[0],
                    "clientHash": sender_client.get("clientHash") or qs.get("clientHash", [""])[0],
                    "name": sender_client.get("displayName") or sender_client.get("name") or qs.get("senderName", [""])[0],
                    "lat": sender_client.get("lat"),
                    "lon": sender_client.get("lon"),
                    "presence": sender_client.get("presence"),
                    "updatedAt": sender_client.get("updatedAt"),
                }
                try:
                    state = mail_service.send_measurement_report_now(
                        MEASUREMENTS_JSONL_PATH,
                        REPORT_SETTINGS_PATH,
                        REPORT_STATE_PATH,
                        parse_presence,
                        activate_interval=False,
                        sender=sender,
                    )
                    send_json(self, 200, {"ok": True, "state": state})
                except Exception as err:
                    state = mail_service.save_report_state(
                        REPORT_STATE_PATH,
                        lastError=str(err),
                        lastErrorAt=time.time() * 1000,
                    )
                    send_json(self, 500, {"ok": False, "error": str(err), "state": state})
                return

            if parsed.path == "/api/report-interval-start":
                qs = parse_qs(parsed.query, keep_blank_values=True)
                if not self.is_admin:
                    send_json(self, 403, {"ok": False, "error": "Epostadmin kreves"})
                    return
                if "email" in qs or "intervalMinutes" in qs:
                    mail_service.save_report_settings(
                        REPORT_SETTINGS_PATH,
                        qs.get("email", [mail_service.DEFAULT_REPORT_EMAIL])[0],
                        qs.get("intervalMinutes", [mail_service.DEFAULT_REPORT_INTERVAL_MINUTES])[0],
                    )
                state = mail_service.start_report_interval(REPORT_STATE_PATH)
                send_json(self, 200, {"ok": True, "state": state})
                return

            if parsed.path == "/api/report-interval-stop":
                qs = parse_qs(parsed.query, keep_blank_values=True)
                if not self.is_admin:
                    send_json(self, 403, {"ok": False, "error": "Epostadmin kreves"})
                    return
                state = mail_service.stop_report_interval(REPORT_STATE_PATH)
                send_json(self, 200, {"ok": True, "state": state})
                return

            if parsed.path == "/api/my-position/status":
                send_json(
                    self,
                    200,
                    {
                        "ok": True,
                        "clientsDir": str(CLIENTS_DIR),
                        "activeClients": get_active_clients(),
                    },
                )
                return

            super().do_GET()

        def end_headers(self):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            super().end_headers()

    return Handler


def initialize_state():
    CLIENTS_DIR.mkdir(parents=True, exist_ok=True)
    load_presence_state()
    sync_client_files_state()
    with ACTIVE_CLIENTS_LOCK:
        clients_for_backfill = list(ACTIVE_CLIENTS.values())
    backfilled_count = mail_service.backfill_measurement_log_if_missing(
        MEASUREMENTS_JSONL_PATH,
        clients_for_backfill,
        parse_float,
        safe_client_hash,
    )
    mail_service.start_report_thread(
        MEASUREMENTS_JSONL_PATH,
        REPORT_SETTINGS_PATH,
        REPORT_STATE_PATH,
        parse_presence,
    )
