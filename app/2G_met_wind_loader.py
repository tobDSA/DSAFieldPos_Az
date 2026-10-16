#!/usr/bin/env python3
"""
2G_met_wind_loader.py

Nearby MET wind loader for DSAFieldNexus / FieldPos.

- Reads visible/finished measurement positions or fallback positions.
- Builds bounds around those points, expanded by radiusKmOutsideBounds.
- Generates a controlled grid inside the expanded bounds.
- Fetches wind data from MET Locationforecast 2.0 for each grid point.
- Writes local GeoJSON cache for frontend Leaflet layer.

Output:
    data/online2/met_wind_nearby.geojson

Frontend:
    06_met_wind_layer.js

Important:
- MET requires a meaningful User-Agent with contact information.
- Frontend must not call MET directly.
- MET wind_from_direction means where the wind comes FROM.
"""

from __future__ import annotations

import argparse
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from runtime import DATA_DIR, effective_wind_config, atomic_json, WIND_LOCK, STOP
from functools import wraps

ROOT = Path(__file__).parent.resolve()
ONLINE2_DIR = DATA_DIR / "online2"
CONFIG_PATH = DATA_DIR / "state" / "wind_settings.json"
DEFAULT_OUTPUT_PATH = ONLINE2_DIR / "met_wind_nearby.geojson"
DEFAULT_AREA_OUTPUT_PATH = ONLINE2_DIR / "met_wind_area.geojson"

DEFAULT_POSITION_SOURCES = [
    ONLINE2_DIR / "fieldpos_measurements.jsonl",
    ONLINE2_DIR / "2g_presence_clients.json",
]

MET_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact"

DEFAULT_CONFIG: Dict[str, Any] = {
    "enabled": True,
    "gridMode": "nearbyPoints",
    "nearbyRadiusKm": 25,
    "radiusKmOutsideBounds": 100,
    "gridStepKm": 5,
    "refreshMinutes": 5,
    "requestSleepSeconds": 0.05,
    "requestTimeoutSeconds": 6,
    "maxGridPoints": 600,
    "norwayWindEnabled": True,
    "norwayWindGridStepKm": 50,
    "norwayWindUseRotatedBand": False,
    "norwayWindWestWidthKm": 1300,
    "norwayWindEastWidthKm": 340,
    "norwayWindAxisMarginKm": 300,
    "norwayWindMaxGridPoints": 2200,
    "norwayWindOutputPath": str(DEFAULT_AREA_OUTPUT_PATH),
    "userAgent": "DSAFieldNexus/0.1 contact@example.no",
    "outputPath": str(DEFAULT_OUTPUT_PATH),
    "positionSources": [str(path) for path in DEFAULT_POSITION_SOURCES],
    "fallbackCenter": {
        "enabled": True,
        "lat": 59.9139,
        "lon": 10.7522,
        "name": "Oslo fallback"
    }
}

AREA_BOUNDS: Dict[str, Tuple[float, float, float, float]] = {
    "southNorway": (57.7, 65.35, 3.8, 15.2),
    "northNorway": (64.45, 71.4, 10.0, 31.4),
    "norway": (56.0, 72.0, -5.0, 35.0),
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json_file(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


write_json_atomic = atomic_json


def load_config(config_path: Path = CONFIG_PATH) -> Dict[str, Any]:
    cfg = dict(DEFAULT_CONFIG)
    cfg.update(effective_wind_config())
    return cfg


def config_signature(cfg: Dict[str, Any]) -> tuple:
    """Values that should abort/restart an ongoing MET wind load when changed."""
    return (
        int(cfg.get("configGeneration", 0) or 0),
        str(cfg.get("gridMode") or ""),
        str(cfg.get("windArea") or ""),
        float(cfg.get("nearbyRadiusKm", 0) or 0),
        float(cfg.get("radiusKmOutsideBounds", 0) or 0),
        float(cfg.get("gridStepKm", 0) or 0),
        int(cfg.get("maxGridPoints", 0) or 0),
        tuple(str(key) for key in cfg.get("selectedReferenceKeys", []) if isinstance(cfg.get("selectedReferenceKeys"), list)),
        bool(cfg.get("enabled", True)),
    )

def should_abort_load(config_path: Path, start_signature: tuple) -> bool:
    current_cfg = load_config(config_path)
    return config_signature(current_cfg) != start_signature


def parse_float(value: Any) -> Optional[float]:
    try:
        if value is None or value == "":
            return None
        v = float(value)
        if math.isfinite(v):
            return v
    except (TypeError, ValueError):
        pass
    return None


def valid_lat_lon(lat: Any, lon: Any) -> bool:
    lat_f = parse_float(lat)
    lon_f = parse_float(lon)
    return lat_f is not None and lon_f is not None and -90 <= lat_f <= 90 and -180 <= lon_f <= 180


def iter_points_from_presence(path: Path) -> Iterable[Dict[str, Any]]:
    data = load_json_file(path, {})
    clients = data.get("clients") if isinstance(data, dict) else None
    if not isinstance(clients, list):
        return

    for client in clients:
        if not isinstance(client, dict):
            continue

        lat = parse_float(client.get("lat"))
        lon = parse_float(client.get("lon"))
        if valid_lat_lon(lat, lon):
            yield {
                "lat": lat,
                "lon": lon,
                "source": str(path.name),
                "label": client.get("displayName") or client.get("name") or client.get("clientHash") or "presence",
            }

        items: List[Dict[str, Any]] = []
        if isinstance(client.get("measurements"), list):
            items.extend(item for item in client["measurements"] if isinstance(item, dict))
        if isinstance(client.get("lastMeasurement"), dict):
            items.append(client["lastMeasurement"])

        for measurement in items:
            m_lat = parse_float(measurement.get("latitude"))
            m_lon = parse_float(measurement.get("longitude"))
            if valid_lat_lon(m_lat, m_lon):
                yield {
                    "lat": m_lat,
                    "lon": m_lon,
                    "source": str(path.name),
                    "label": measurement.get("measuringPointName") or measurement.get("stationName") or "measurement",
                }


def iter_points_from_measurement_jsonl(path: Path) -> Iterable[Dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return
    except Exception:
        return

    for line in lines:
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        measurement = record.get("measurement") if isinstance(record, dict) else None
        if not isinstance(measurement, dict):
            continue
        lat = parse_float(measurement.get("latitude"))
        lon = parse_float(measurement.get("longitude"))
        if valid_lat_lon(lat, lon):
            yield {
                "lat": lat,
                "lon": lon,
                "source": str(path.name),
                "label": measurement.get("measuringPointName") or measurement.get("stationName") or "measurement-log",
            }


def reference_key(lat: float, lon: float) -> str:
    return f"{lat:.6f},{lon:.6f}"


def collect_reference_points(cfg: Dict[str, Any], apply_selection: bool = True) -> List[Dict[str, Any]]:
    points: List[Dict[str, Any]] = []
    seen = set()
    selected_raw = cfg.get("selectedReferenceKeys")
    selected_keys = {
        str(item)
        for item in selected_raw
        if str(item).strip()
    } if isinstance(selected_raw, list) else None

    for custom in cfg.get("customReferencePoints") or []:
        if not isinstance(custom, dict):
            continue
        lat = parse_float(custom.get("lat"))
        lon = parse_float(custom.get("lon"))
        if not valid_lat_lon(lat, lon):
            continue
        lat = round(float(lat), 6)
        lon = round(float(lon), 6)
        key = str(custom.get("key") or f"manual:{reference_key(lat, lon)}")
        if (lat, lon) in seen:
            continue
        seen.add((lat, lon))
        points.append({
            "lat": lat,
            "lon": lon,
            "key": key,
            "source": "manualWindReference",
            "label": custom.get("label") or "Valgt kartpunkt",
        })

    for raw_path in cfg.get("positionSources") or []:
        path = Path(raw_path)
        if not path.is_absolute():
            path = ROOT / path

        iterator = iter_points_from_measurement_jsonl(path) if path.name.endswith(".jsonl") else iter_points_from_presence(path)
        for point in iterator or []:
            lat = round(float(point["lat"]), 6)
            lon = round(float(point["lon"]), 6)
            key = (lat, lon)
            if key in seen:
                continue
            seen.add(key)
            ref_key = reference_key(lat, lon)
            points.append({**point, "lat": lat, "lon": lon, "key": ref_key})

    if apply_selection and selected_keys is not None:
        points = [point for point in points if point.get("key") in selected_keys]

    if not points and selected_keys is None and cfg.get("fallbackCenter", {}).get("enabled", True):
        fallback = cfg.get("fallbackCenter", {})
        lat = parse_float(fallback.get("lat"))
        lon = parse_float(fallback.get("lon"))
        if valid_lat_lon(lat, lon):
            lat_f = float(lat)
            lon_f = float(lon)
            points.append({
                "lat": lat_f,
                "lon": lon_f,
                "key": reference_key(lat_f, lon_f),
                "source": "fallbackCenter",
                "label": fallback.get("name") or "fallback",
            })

    return points


def km_to_lat_deg(km: float) -> float:
    return km / 111.32


def km_to_lon_deg(km: float, lat: float) -> float:
    cos_lat = math.cos(math.radians(lat))
    if abs(cos_lat) < 0.05:
        cos_lat = 0.05
    return km / (111.32 * cos_lat)


def expanded_bounds(points: List[Dict[str, Any]], radius_km: float) -> Tuple[float, float, float, float]:
    min_lat = min(float(p["lat"]) for p in points)
    max_lat = max(float(p["lat"]) for p in points)
    min_lon = min(float(p["lon"]) for p in points)
    max_lon = max(float(p["lon"]) for p in points)
    center_lat = (min_lat + max_lat) / 2.0
    lat_pad = km_to_lat_deg(radius_km)
    lon_pad = km_to_lon_deg(radius_km, center_lat)
    return (
        max(-90.0, min_lat - lat_pad),
        min(90.0, max_lat + lat_pad),
        max(-180.0, min_lon - lon_pad),
        min(180.0, max_lon + lon_pad),
    )


def bounds_for_area(area: Any) -> Optional[Tuple[float, float, float, float]]:
    return AREA_BOUNDS.get(str(area or "").strip())


def generate_grid(bounds: Tuple[float, float, float, float], step_km: float, max_points: int) -> List[Dict[str, float]]:
    min_lat, max_lat, min_lon, max_lon = bounds
    center_lat = (min_lat + max_lat) / 2.0
    lat_step = max(0.001, km_to_lat_deg(step_km))
    lon_step = max(0.001, km_to_lon_deg(step_km, center_lat))

    points = []
    lat = min_lat
    row = 0
    while lat <= max_lat + 1e-9:
        lon = min_lon + (lon_step / 2.0 if row % 2 == 1 else 0.0)
        while lon <= max_lon + 1e-9:
            points.append({"lat": round(lat, 5), "lon": round(lon, 5)})
            lon += lon_step
        lat += lat_step
        row += 1

    if len(points) <= max_points:
        return points
    stride = max(1, math.ceil(len(points) / max_points))
    return points[::stride][:max_points]


def latlon_to_local_xy(lat: float, lon: float, center_lat: float, center_lon: float) -> Tuple[float, float]:
    return (
        (lon - center_lon) * 111.32 * max(0.05, math.cos(math.radians(center_lat))),
        (lat - center_lat) * 111.32,
    )


def local_xy_to_latlon(x: float, y: float, center_lat: float, center_lon: float) -> Tuple[float, float]:
    lat = center_lat + y / 111.32
    lon = center_lon + x / (111.32 * max(0.05, math.cos(math.radians(center_lat))))
    return lat, lon


def rotated_norway_band_grid(
    step_km: float,
    west_width_km: float,
    east_width_km: float,
    margin_km: float,
    max_points: int,
) -> List[Dict[str, float]]:
    # Approximate Norway wind corridor axis: Oslo to Tromsø.
    start_lat, start_lon = 59.9139, 10.7522
    end_lat, end_lon = 69.6492, 18.9553
    center_lat = (start_lat + end_lat) / 2.0
    center_lon = (start_lon + end_lon) / 2.0
    sx, sy = latlon_to_local_xy(start_lat, start_lon, center_lat, center_lon)
    ex, ey = latlon_to_local_xy(end_lat, end_lon, center_lat, center_lon)
    axis_x = ex - sx
    axis_y = ey - sy
    axis_len = math.hypot(axis_x, axis_y)
    if axis_len <= 0:
        return []

    ux = axis_x / axis_len
    uy = axis_y / axis_len
    px = -uy
    py = ux
    start_along = -margin_km
    end_along = axis_len + margin_km
    west_width_km = max(step_km, west_width_km)
    east_width_km = max(step_km, east_width_km)

    points: List[Dict[str, float]] = []
    seen = set()
    along = start_along
    column = 0
    while along <= end_along + 1e-9:
        offset = -east_width_km + (step_km / 2.0 if column % 2 == 1 else 0.0)
        while offset <= west_width_km + 1e-9:
            x = sx + ux * along + px * offset
            y = sy + uy * along + py * offset
            lat, lon = local_xy_to_latlon(x, y, center_lat, center_lon)
            if -90 <= lat <= 90 and -180 <= lon <= 180:
                key = (round(lat, 4), round(lon, 4))
                if key not in seen:
                    seen.add(key)
                    points.append({"lat": round(lat, 5), "lon": round(lon, 5)})
            offset += step_km
        along += step_km
        column += 1

    return thin_points(points, max_points)


def bounds_from_grid(points: List[Dict[str, float]], fallback: Tuple[float, float, float, float]) -> Tuple[float, float, float, float]:
    if not points:
        return fallback
    return (
        min(float(point["lat"]) for point in points),
        max(float(point["lat"]) for point in points),
        min(float(point["lon"]) for point in points),
        max(float(point["lon"]) for point in points),
    )


def thin_points(points: List[Dict[str, float]], max_points: int) -> List[Dict[str, float]]:
    if len(points) <= max_points:
        return points
    stride = max(1, math.ceil(len(points) / max_points))
    return points[::stride][:max_points]


def clean_grid_points(points: List[Dict[str, float]]) -> List[Dict[str, float]]:
    return [
        {"lat": float(point["lat"]), "lon": float(point["lon"])}
        for point in points
    ]


def distance_km_between(a: Dict[str, Any], b: Dict[str, Any]) -> float:
    lat_a = float(a["lat"])
    lon_a = float(a["lon"])
    lat_b = float(b["lat"])
    lon_b = float(b["lon"])
    center_lat = (lat_a + lat_b) / 2.0
    return math.hypot(
        (lat_a - lat_b) * 111.32,
        (lon_a - lon_b) * 111.32 * max(0.05, math.cos(math.radians(center_lat))),
    )


def cluster_reference_points(ref_points: List[Dict[str, Any]], radius_km: float) -> List[Dict[str, Any]]:
    clusters: List[List[Dict[str, Any]]] = []

    for ref in ref_points:
        matches = [
            index
            for index, cluster in enumerate(clusters)
            if any(distance_km_between(ref, item) <= radius_km * 2.0 for item in cluster)
        ]
        if not matches:
            clusters.append([ref])
            continue

        first_index = matches[0]
        clusters[first_index].append(ref)
        for index in reversed(matches[1:]):
            clusters[first_index].extend(clusters.pop(index))

    merged: List[Dict[str, Any]] = []
    for index, cluster in enumerate(clusters, start=1):
        lat = sum(float(item["lat"]) for item in cluster) / len(cluster)
        lon = sum(float(item["lon"]) for item in cluster) / len(cluster)
        center = {"lat": lat, "lon": lon}
        extra_radius = max(distance_km_between(center, item) for item in cluster)
        labels = [str(item.get("label") or item.get("key") or "") for item in cluster]
        merged.append({
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "key": f"cluster:{index}",
            "source": "clusteredReferences",
            "label": " / ".join(label for label in labels if label) or f"Vindgruppe {index}",
            "memberCount": len(cluster),
            "memberKeys": [item.get("key") for item in cluster],
            "effectiveRadiusKm": radius_km + extra_radius,
        })
    return merged


def generate_nearby_grid(ref_points: List[Dict[str, Any]], radius_km: float, step_km: float, max_points: int) -> List[Dict[str, float]]:
    radius_km = max(step_km, radius_km)
    lat_step = max(0.001, km_to_lat_deg(step_km))
    seen = set()
    center_points: List[Dict[str, float]] = []
    ring_points: List[Dict[str, float]] = []

    for ref in ref_points:
        center_lat = float(ref["lat"])
        center_lon = float(ref["lon"])
        ref_radius_km = max(step_km, float(ref.get("effectiveRadiusKm", radius_km) or radius_km))
        center_key = (round(center_lat, 4), round(center_lon, 4))
        if center_key not in seen:
            seen.add(center_key)
            center_points.append({"lat": round(center_lat, 5), "lon": round(center_lon, 5)})
        lon_step = max(0.001, km_to_lon_deg(step_km, center_lat))
        lat_radius = km_to_lat_deg(ref_radius_km)
        lon_radius = km_to_lon_deg(ref_radius_km, center_lat)
        row = 0
        lat = center_lat - lat_radius
        while lat <= center_lat + lat_radius + 1e-9:
            lon = center_lon - lon_radius + (lon_step / 2.0 if row % 2 == 1 else 0.0)
            while lon <= center_lon + lon_radius + 1e-9:
                distance_km = math.hypot(
                    (lat - center_lat) * 111.32,
                    (lon - center_lon) * 111.32 * max(0.05, math.cos(math.radians(center_lat))),
                )
                if distance_km <= ref_radius_km:
                    key = (round(lat, 4), round(lon, 4))
                    if key not in seen:
                        seen.add(key)
                        ring_points.append({
                            "lat": round(lat, 5),
                            "lon": round(lon, 5),
                            "distanceKm": round(distance_km, 3),
                        })
                lon += lon_step
            lat += lat_step
            row += 1

    remaining_slots = max(0, max_points - len(center_points))
    if remaining_slots <= 0:
        return center_points
    ring_points.sort(key=lambda point: float(point.get("distanceKm", 0)))
    return center_points + clean_grid_points(ring_points[:remaining_slots])


def nearby_candidate_count(ref_points: List[Dict[str, Any]], radius_km: float, step_km: float) -> int:
    return len(generate_nearby_grid(ref_points, radius_km, step_km, 10**9))


def grid_point_key(point: Dict[str, Any]) -> str:
    return f"{float(point['lat']):.5f},{float(point['lon']):.5f}"


def feature_point_key(feature: Dict[str, Any]) -> Optional[str]:
    try:
        coords = feature.get("geometry", {}).get("coordinates", [])
        lon = float(coords[0])
        lat = float(coords[1])
        return f"{lat:.5f},{lon:.5f}"
    except (TypeError, ValueError, IndexError, AttributeError):
        return None


def feature_has_wind(feature: Dict[str, Any]) -> bool:
    props = feature.get("properties", {}) if isinstance(feature, dict) else {}
    return (
        isinstance(props, dict)
        and props.get("windSpeedMS") is not None
        and props.get("windDirectionDeg") is not None
        and not props.get("error")
    )


def load_existing_wind_features(output_path: Path) -> Dict[str, Dict[str, Any]]:
    data = load_json_file(output_path, {})
    features = data.get("features") if isinstance(data, dict) else None
    if not isinstance(features, list):
        return {}

    cached: Dict[str, Dict[str, Any]] = {}
    for feature in features:
        if not isinstance(feature, dict) or not feature_has_wind(feature):
            continue
        key = feature_point_key(feature)
        if key:
            cached[key] = feature
    return cached


def write_backend_loading_status(output_path: Path, refresh_minutes: int) -> None:
    existing = load_json_file(output_path, {})
    if not isinstance(existing, dict):
        existing = {"type": "FeatureCollection", "features": []}
    existing["type"] = "FeatureCollection"
    existing["status"] = "backend-loading"
    existing["backendLoadingStartedAt"] = utc_now_iso()
    existing["refreshMinutes"] = refresh_minutes
    existing.setdefault("source", "MET Locationforecast 2.0")
    existing.setdefault("features", [])
    write_json_atomic(output_path, existing)


def most_common_cached_forecast_time(features: Dict[str, Dict[str, Any]]) -> str:
    counts: Dict[str, int] = {}
    for feature in features.values():
        props = feature.get("properties", {})
        forecast_time = str(props.get("forecastTime") or "")
        if forecast_time:
            counts[forecast_time] = counts.get(forecast_time, 0) + 1
    if not counts:
        return ""
    return max(counts.items(), key=lambda item: item[1])[0]


def nearest_forecast_timeseries_item(data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    timeseries = data.get("properties", {}).get("timeseries") if isinstance(data, dict) else None
    if not isinstance(timeseries, list) or not timeseries:
        return None
    return timeseries[0] if isinstance(timeseries[0], dict) else None


def fetch_met_wind(lat: float, lon: float, user_agent: str, timeout: int) -> Dict[str, Any]:
    params = urllib.parse.urlencode({"lat": f"{lat:.5f}", "lon": f"{lon:.5f}"})
    req = urllib.request.Request(
        f"{MET_URL}?{params}",
        headers={"User-Agent": user_agent, "Accept": "application/json"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        data = json.loads(response.read().decode("utf-8"))

    item = nearest_forecast_timeseries_item(data)
    if not item:
        raise RuntimeError("MET response mangler properties.timeseries[0]")
    details = item.get("data", {}).get("instant", {}).get("details", {})
    if not isinstance(details, dict):
        raise RuntimeError("MET response mangler data.instant.details")

    return {
        "forecastTime": item.get("time"),
        "windSpeedMS": parse_float(details.get("wind_speed")),
        "windDirectionDeg": parse_float(details.get("wind_from_direction")),
        "windGustMS": parse_float(details.get("wind_speed_of_gust")),
        "airTemperatureC": parse_float(details.get("air_temperature")),
    }


def wind_feature(grid_point: Dict[str, float], wind: Dict[str, Any]) -> Dict[str, Any]:
    lat = float(grid_point["lat"])
    lon = float(grid_point["lon"])
    direction = wind.get("windDirectionDeg")
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {
            "id": f"metwind_{lat:.5f}_{lon:.5f}",
            "source": "MET Locationforecast 2.0",
            "unit": "m/s",
            "forecastTime": wind.get("forecastTime"),
            "windSpeedMS": wind.get("windSpeedMS"),
            "windDirectionDeg": direction,
            "windTowardDirectionDeg": (float(direction) + 180.0) % 360.0 if direction is not None else None,
            "windGustMS": wind.get("windGustMS"),
            "airTemperatureC": wind.get("airTemperatureC"),
        },
    }


def error_feature(grid_point: Dict[str, float], error: str) -> Dict[str, Any]:
    lat = float(grid_point["lat"])
    lon = float(grid_point["lon"])
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {
            "id": f"metwind_error_{lat:.5f}_{lon:.5f}",
            "source": "MET Locationforecast 2.0",
            "error": error,
            "windSpeedMS": None,
            "windDirectionDeg": None,
            "windTowardDirectionDeg": None,
            "windGustMS": None,
            "unit": "m/s",
        },
    }


def build_geojson(
    cfg: Dict[str, Any],
    config_path: Path = CONFIG_PATH,
    output_path: Optional[Path] = None,
    progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    job_label: str = "nearby",
) -> Dict[str, Any]:
    ref_points = collect_reference_points(cfg)
    grid_mode = str(cfg.get("gridMode") or "nearbyPoints").strip()
    nearby_radius_km = float(cfg.get("nearbyRadiusKm", 25))
    radius_km = float(cfg.get("radiusKmOutsideBounds", 100))
    grid_step_km = float(cfg.get("gridStepKm", 25))
    max_grid_points = int(cfg.get("maxGridPoints", 80))
    user_agent = str(cfg.get("userAgent") or "").strip()
    timeout = int(cfg.get("requestTimeoutSeconds", 20))
    request_sleep = float(cfg.get("requestSleepSeconds", 0.25))
    refresh_minutes = max(1, int(float(cfg.get("refreshMinutes", 5))))
    start_signature = config_signature(cfg)
    disable_config_abort = bool(cfg.get("disableConfigAbort", False))
    if output_path is None:
        output_path = Path(str(cfg.get("outputPath") or DEFAULT_OUTPUT_PATH))
        if not output_path.is_absolute():
            output_path = ROOT / output_path

    if not user_agent or "contact@example" in user_agent:
        print("[MET wind] ADVARSEL: sett reell User-Agent med kontaktinfo i config/met_wind.json", flush=True)

    area_name = str(cfg.get("windArea") or "").strip()
    area_bounds = bounds_for_area(area_name) if grid_mode == "area" else None
    use_rotated_norway_band = (
        grid_mode == "area"
        and area_name == "norway"
        and bool(cfg.get("norwayWindUseRotatedBand", True))
    )
    if not ref_points and area_bounds is None:
        return {
            "type": "FeatureCollection",
            "updatedAt": utc_now_iso(),
            "refreshMinutes": refresh_minutes,
            "source": "MET Locationforecast 2.0",
            "status": "no-reference-points",
            "referencePointCount": 0,
            "windReferencePointCount": 0,
            "windReferenceMergeCount": 0,
            "gridPointCount": 0,
            "candidatePointCount": 0,
            "cachedPointCount": 0,
            "fetchedPointCount": 0,
            "gridLimited": False,
            "bounds": {
                "radiusKmOutsideBounds": radius_km,
                "nearbyRadiusKm": nearby_radius_km,
                "gridStepKm": grid_step_km,
                "gridMode": grid_mode,
                "windArea": cfg.get("windArea") if area_bounds is not None else "",
            },
            "features": [],
        }

    wind_ref_points = cluster_reference_points(ref_points, nearby_radius_km) if grid_mode == "nearbyPoints" else ref_points
    if area_bounds is not None:
        bounds = area_bounds
    else:
        bounds_radius_km = nearby_radius_km if grid_mode == "nearbyPoints" else radius_km
        if grid_mode == "nearbyPoints" and wind_ref_points:
            bounds_radius_km = max(float(point.get("effectiveRadiusKm", nearby_radius_km) or nearby_radius_km) for point in wind_ref_points)
        bounds = expanded_bounds(wind_ref_points, bounds_radius_km)
    if grid_mode == "nearbyPoints":
        grid = generate_nearby_grid(wind_ref_points, nearby_radius_km, grid_step_km, max_grid_points)
        candidate_count = nearby_candidate_count(wind_ref_points, nearby_radius_km, grid_step_km)
    elif use_rotated_norway_band:
        grid = rotated_norway_band_grid(
            grid_step_km,
            float(cfg.get("norwayWindWestWidthKm", 1300) or 1300),
            float(cfg.get("norwayWindEastWidthKm", 340) or 340),
            float(cfg.get("norwayWindAxisMarginKm", 300) or 300),
            max_grid_points,
        )
        candidate_count = len(grid)
        bounds = bounds_from_grid(grid, area_bounds or AREA_BOUNDS["norway"])
    else:
        grid = generate_grid(bounds, grid_step_km, max_grid_points)
        candidate_count = len(grid)
    print(
        f"[MET wind] {job_label}: planlagt {len(grid)}/{candidate_count} punkter "
        f"mode={grid_mode} step={grid_step_km}km bounds=({bounds[0]:.2f},{bounds[1]:.2f},{bounds[2]:.2f},{bounds[3]:.2f})",
        flush=True,
    )
    cached_features = load_existing_wind_features(output_path)
    cached_forecast_time = most_common_cached_forecast_time(cached_features)
    reusable_forecast_time = ""
    probe_key = ""
    probe_feature: Optional[Dict[str, Any]] = None
    if cached_features and cached_forecast_time:
        for point in grid:
            key = grid_point_key(point)
            if key in cached_features:
                try:
                    probe_wind = fetch_met_wind(point["lat"], point["lon"], user_agent, timeout)
                    probe_feature = wind_feature(point, probe_wind)
                    probe_key = key
                    if str(probe_wind.get("forecastTime") or "") == cached_forecast_time:
                        reusable_forecast_time = cached_forecast_time
                except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, RuntimeError, json.JSONDecodeError):
                    reusable_forecast_time = cached_forecast_time
                except Exception:
                    reusable_forecast_time = cached_forecast_time
                break
    if cached_features:
        cache_state = "gjenbruker cache" if reusable_forecast_time else "ny MET-tid eller nye punkter"
        print(
            f"[MET wind] {job_label}: cache={len(cached_features)} forecast={cached_forecast_time or 'ukjent'} -> {cache_state}",
            flush=True,
        )
    if progress_callback:
        progress_callback({
            "completed": 0,
            "total": len(grid),
            "errors": 0,
            "cached": 0,
            "fetched": 0,
            "gridStepKm": grid_step_km,
            "gridMode": grid_mode,
        })
    features = []
    errors = 0
    cached_count = 0
    fetched_count = 0
    for index, point in enumerate(grid, start=1):
        if STOP.is_set():
            raise RuntimeError("Wind refresh stopped for shutdown")
        if index == 1 or index % 10 == 0:
            if not disable_config_abort and should_abort_load(config_path, start_signature):
                print("[MET wind] config changed - aborting current load", flush=True)
                return {
                    "type": "FeatureCollection",
                    "updatedAt": utc_now_iso(),
                    "refreshMinutes": refresh_minutes,
                    "source": "MET Locationforecast 2.0",
                    "status": "aborted-config-changed",
                    "errors": errors,
                    "referencePointCount": len(ref_points),
                    "windReferencePointCount": len(wind_ref_points),
                    "windReferenceMergeCount": max(0, len(ref_points) - len(wind_ref_points)),
                    "gridPointCount": len(grid),
                    "candidatePointCount": candidate_count,
                    "completedPointCount": max(0, index - 1),
                    "cachedPointCount": cached_count,
                    "fetchedPointCount": fetched_count,
                    "gridLimited": len(grid) < candidate_count,
                    "bounds": {
                        "minLat": bounds[0],
                        "maxLat": bounds[1],
                        "minLon": bounds[2],
                        "maxLon": bounds[3],
                        "radiusKmOutsideBounds": radius_km,
                        "nearbyRadiusKm": nearby_radius_km,
                        "gridStepKm": grid_step_km,
                        "gridMode": grid_mode,
                        "windArea": cfg.get("windArea") if area_bounds is not None else "",
                    },
                    "features": features,
                }

        key = grid_point_key(point)
        cached_feature = cached_features.get(key)
        cached_time = str(cached_feature.get("properties", {}).get("forecastTime") or "") if cached_feature else ""
        if key == probe_key and probe_feature is not None and cached_time != reusable_forecast_time:
            features.append(probe_feature)
            fetched_count += 1
        elif cached_feature and cached_time and cached_time == reusable_forecast_time:
            features.append(cached_feature)
            cached_count += 1
        else:
            try:
                features.append(wind_feature(point, fetch_met_wind(point["lat"], point["lon"], user_agent, timeout)))
                fetched_count += 1
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, RuntimeError, json.JSONDecodeError) as err:
                errors += 1
                fetched_count += 1
                features.append(error_feature(point, str(err)))
            except Exception as err:
                errors += 1
                fetched_count += 1
                features.append(error_feature(point, f"unexpected: {err}"))
        if progress_callback:
            progress_callback({
                "completed": index,
                "total": len(grid),
                "errors": errors,
                "cached": cached_count,
                "fetched": fetched_count,
                "gridStepKm": grid_step_km,
                "gridMode": grid_mode,
            })
        progress_interval = 50 if job_label == "Norge vind" else 25
        if index == 1 or index == len(grid) or index % progress_interval == 0:
            print(
                f"[MET wind] {job_label}: {index}/{len(grid)} "
                f"cache={cached_count} hentet={fetched_count} feil={errors}",
                flush=True,
            )
        if request_sleep > 0 and index < len(grid):
            time.sleep(request_sleep)

    min_lat, max_lat, min_lon, max_lon = bounds
    return {
        "type": "FeatureCollection",
        "updatedAt": utc_now_iso(),
        "refreshMinutes": refresh_minutes,
        "source": "MET Locationforecast 2.0",
        "status": "ok" if errors == 0 else "partial",
        "errors": errors,
        "referencePointCount": len(ref_points),
        "windReferencePointCount": len(wind_ref_points),
        "windReferenceMergeCount": max(0, len(ref_points) - len(wind_ref_points)),
        "gridPointCount": len(grid),
        "candidatePointCount": candidate_count,
        "cachedPointCount": cached_count,
        "fetchedPointCount": fetched_count,
        "cacheForecastTime": reusable_forecast_time,
        "gridLimited": len(grid) < candidate_count,
        "bounds": {
            "minLat": min_lat,
            "maxLat": max_lat,
            "minLon": min_lon,
            "maxLon": max_lon,
            "radiusKmOutsideBounds": radius_km,
            "nearbyRadiusKm": nearby_radius_km,
            "gridStepKm": grid_step_km,
            "gridMode": grid_mode,
            "windArea": cfg.get("windArea") if area_bounds is not None else "",
            "gridShape": "rotatedNorwayBand" if use_rotated_norway_band else "bounds",
            "norwayWestWidthKm": float(cfg.get("norwayWindWestWidthKm", 1300) or 1300) if use_rotated_norway_band else None,
            "norwayEastWidthKm": float(cfg.get("norwayWindEastWidthKm", 340) or 340) if use_rotated_norway_band else None,
            "norwayAxisMarginKm": float(cfg.get("norwayWindAxisMarginKm", 300) or 300) if use_rotated_norway_band else None,
        },
        "features": features,
    }


def serialized_wind(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        with WIND_LOCK:
            if not STOP.is_set():
                return fn(*args, **kwargs)
    return wrapped


@serialized_wind
def run_once(
    cfg: Dict[str, Any],
    config_path: Path = CONFIG_PATH,
    progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    job_label: str = "nearby",
) -> None:
    output_path = Path(str(cfg.get("outputPath") or DEFAULT_OUTPUT_PATH))
    if not output_path.is_absolute():
        output_path = ROOT / output_path

    if not bool(cfg.get("enabled", True)):
        refresh_minutes = max(1, int(float(cfg.get("refreshMinutes", 5))))
        write_json_atomic(output_path, {"type": "FeatureCollection", "updatedAt": utc_now_iso(), "refreshMinutes": refresh_minutes, "source": "MET Locationforecast 2.0", "status": "disabled", "features": []})
        print(f"[MET wind] disabled -> {output_path}", flush=True)
        return

    refresh_minutes = max(1, int(float(cfg.get("refreshMinutes", 5))))
    grid_mode = str(cfg.get("gridMode") or "nearbyPoints")
    grid_step = cfg.get("gridStepKm")
    radius = cfg.get("nearbyRadiusKm")
    print(
        f"[MET wind] starter {job_label} "
        f"mode={grid_mode} step={grid_step}km radius={radius}km -> {output_path}",
        flush=True,
    )
    write_backend_loading_status(output_path, refresh_minutes)
    geojson = build_geojson(
        cfg,
        config_path=config_path,
        output_path=output_path,
        progress_callback=progress_callback,
        job_label=job_label,
    )
    write_json_atomic(output_path, geojson)
    print(
        "[MET wind] wrote "
        f"{job_label} "
        f"{len(geojson.get('features', []))} features "
        f"status={geojson.get('status')} "
        f"cached={geojson.get('cachedPointCount', 0)} "
        f"fetched={geojson.get('fetchedPointCount', 0)} "
        f"-> {output_path}",
        flush=True,
    )


def run_norway_area_once(cfg: Dict[str, Any], config_path: Path = CONFIG_PATH) -> None:
    if not bool(cfg.get("norwayWindEnabled", True)):
        return
    area_cfg = dict(cfg)
    area_cfg.update({
        "gridMode": "area",
        "windArea": "norway",
        "gridStepKm": float(cfg.get("norwayWindGridStepKm", 50) or 50),
        "maxGridPoints": int(float(cfg.get("norwayWindMaxGridPoints", 1800) or 1800)),
        "outputPath": str(cfg.get("norwayWindOutputPath") or DEFAULT_AREA_OUTPUT_PATH),
        "disableConfigAbort": True,
    })
    run_once(area_cfg, config_path=config_path, job_label="Norge vind")


def main() -> int:
    parser = argparse.ArgumentParser(description="DSAFieldNexus nearby MET wind loader")
    parser.add_argument("--once", action="store_true", help="Run once and exit")
    parser.add_argument("--config", default=str(CONFIG_PATH), help="Config JSON path")
    args = parser.parse_args()

    config_path = Path(args.config)
    if not config_path.is_absolute():
        config_path = ROOT / config_path

    while True:
        cfg = load_config(config_path)
        run_once(cfg, config_path=config_path, job_label="nearby")
        run_norway_area_once(cfg, config_path=config_path)
        if args.once:
            return 0
        refresh_minutes = max(1, int(float(cfg.get("refreshMinutes", 5))))
        time.sleep(refresh_minutes * 60)


if __name__ == "__main__":
    raise SystemExit(main())
