"""Read-only deployment configuration and shared, single-process storage helpers."""
import json
import logging
import math
import os
import tempfile
import threading
from pathlib import Path

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / 'static'
DATA_DIR = Path(os.environ.get('FIELDPOS_DATA_DIR', '/data/DSAFieldPos_Az'))
CONFIG_PATH = Path(os.environ.get('FIELDPOS_CONFIG', str(DATA_DIR / 'config/DSAFieldPos.json')))
FALLBACK_PATH = ROOT / 'defaults/DSAFieldPos.json'
DATA_LOCK = threading.RLock()
WIND_LOCK = threading.Lock()
STOP = threading.Event()


def read_object(path):
    with path.open(encoding='utf-8') as stream:
        value = json.load(stream, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    if not isinstance(value, dict):
        raise ValueError(f'Expected JSON object: {path}')
    return value


def validate_wind(wind):
    boolean_keys = {'enabled', 'norwayWindEnabled', 'norwayWindUseRotatedBand', 'windAreaLayerEnabled'}
    positive_keys = {'refreshMinutes', 'gridStepKm', 'nearbyRadiusKm', 'maxGridPoints',
                     'requestTimeoutSeconds', 'radiusKmOutsideBounds', 'norwayWindGridStepKm',
                     'norwayWindWestWidthKm', 'norwayWindEastWidthKm', 'norwayWindAxisMarginKm',
                     'norwayWindMaxGridPoints'}
    extra_keys = {'gridMode', 'windArea', 'windAreaLayerArea', 'userAgent', 'requestSleepSeconds',
                  'fallbackCenter', 'selectedReferenceKeys', 'customReferencePoints', 'configGeneration'}
    if set(wind) - boolean_keys - positive_keys - extra_keys:
        raise ValueError('Unknown wind configuration keys')
    for key, value in wind.items():
        if key in boolean_keys and type(value) is not bool:
            raise ValueError(f'wind.{key} must be boolean')
        if key in positive_keys | {'requestSleepSeconds', 'configGeneration'}:
            if type(value) not in (int, float) or not math.isfinite(value) or value < 0 or (key in positive_keys and value == 0):
                raise ValueError(f'Invalid wind.{key}')
        if key in {'maxGridPoints', 'norwayWindMaxGridPoints', 'configGeneration'} and type(value) is not int:
            raise ValueError(f'wind.{key} must be integer')
    if wind.get('gridMode', 'nearbyPoints') not in {'nearbyPoints', 'area'}:
        raise ValueError('Invalid wind.gridMode')
    for key in ('windArea', 'windAreaLayerArea'):
        if wind.get(key, '') not in {'', 'norway', 'southNorway', 'northNorway'}:
            raise ValueError(f'Invalid wind.{key}')
    if 'userAgent' in wind and (not isinstance(wind['userAgent'], str) or not wind['userAgent'].strip()):
        raise ValueError('Invalid wind.userAgent')
    if 'selectedReferenceKeys' in wind and (not isinstance(wind['selectedReferenceKeys'], list) or not all(isinstance(item, str) for item in wind['selectedReferenceKeys'])):
        raise ValueError('Invalid wind.selectedReferenceKeys')
    points = wind.get('customReferencePoints', [])
    if not isinstance(points, list):
        raise ValueError('Invalid customReferencePoints')
    for point in points:
        if not isinstance(point, dict):
            raise ValueError('Invalid reference point')
        for key, limit in (('lat', 90), ('lon', 180)):
            value = point.get(key)
            if type(value) not in (int, float) or not math.isfinite(value) or abs(value) > limit:
                raise ValueError('Invalid reference coordinates')
    if 'fallbackCenter' in wind:
        fallback = wind['fallbackCenter']
        if not isinstance(fallback, dict) or type(fallback.get('enabled')) is not bool:
            raise ValueError('Invalid fallbackCenter')
        for key, limit in (('lat', 90), ('lon', 180)):
            value = fallback.get(key)
            if type(value) not in (int, float) or not math.isfinite(value) or abs(value) > limit:
                raise ValueError('Invalid fallback coordinates')


def load_configuration(path=CONFIG_PATH):
    try:
        cfg = read_object(path)
    except FileNotFoundError:
        # A dangling symlink is a broken configuration, not an absent file.
        if path.is_symlink():
            raise
        logging.warning('Configuration missing at %s; reading image fallback %s without copying it', path, FALLBACK_PATH)
        cfg = read_object(FALLBACK_PATH)
    if set(cfg) != {'schemaVersion', 'wind', 'mail'} or cfg['schemaVersion'] != 1:
        raise ValueError('Unsupported configuration schema; expected schemaVersion=1, wind and mail')
    if not isinstance(cfg['wind'], dict) or not isinstance(cfg['mail'], dict):
        raise ValueError('wind and mail must be objects')
    wind = cfg['wind']
    for key in ('enabled', 'norwayWindEnabled'):
        if type(wind.get(key)) is not bool:
            raise ValueError(f'wind.{key} must be boolean')
    for key in ('refreshMinutes', 'gridStepKm', 'nearbyRadiusKm', 'maxGridPoints', 'requestTimeoutSeconds'):
        value = wind.get(key)
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise ValueError(f'wind.{key} must be positive and finite')
    if any(key in wind for key in ('outputPath', 'norwayWindOutputPath', 'positionSources')):
        raise ValueError('Storage paths are controlled by the runtime, not wind configuration')
    validate_wind(wind)
    mail = cfg['mail']
    if set(mail) - {'enabled', 'transport', 'host', 'port', 'from', 'ssl', 'tls', 'timeout'}:
        raise ValueError('Unknown mail configuration keys')
    if mail.get('transport') not in ('off', 'smtp') or type(mail.get('enabled')) is not bool:
        raise ValueError('mail requires boolean enabled and transport off or smtp')
    if any(key in mail for key in ('username', 'password')):
        raise ValueError('SMTP credentials must be environment secrets')
    for key in ('ssl', 'tls'):
        if key in mail and type(mail[key]) is not bool:
            raise ValueError(f'mail.{key} must be boolean')
    for key in ('port', 'timeout'):
        if key in mail and (type(mail[key]) is not int or mail[key] <= 0):
            raise ValueError(f'Invalid mail.{key}')
    if mail['transport'] == 'smtp' and mail['enabled']:
        if not mail.get('host') or not mail.get('from'):
            raise ValueError('SMTP requires host and from')
        if not all(os.environ.get(key) for key in ('FIELDPOS_SMTP_USERNAME', 'FIELDPOS_SMTP_PASSWORD')):
            raise ValueError('SMTP credentials are missing')
    return cfg


CONFIG = load_configuration()
WIND_SETTINGS_PATH = DATA_DIR / 'state/wind_settings.json'
WIND_SETTING_KEYS = {'gridMode', 'windArea', 'gridStepKm', 'nearbyRadiusKm', 'selectedReferenceKeys', 'customReferencePoints', 'configGeneration', 'windAreaLayerEnabled', 'windAreaLayerArea'}


def effective_wind_config():
    cfg = dict(CONFIG['wind'])
    with DATA_LOCK:
        try:
            settings = read_object(WIND_SETTINGS_PATH)
        except FileNotFoundError:
            settings = {}
        cfg.update({key: value for key, value in settings.items() if key in WIND_SETTING_KEYS})
    validate_wind(cfg)
    online = DATA_DIR / 'online2'
    cfg.update(outputPath=str(online / 'met_wind_nearby.geojson'),
               norwayWindOutputPath=str(online / 'met_wind_area.geojson'),
               positionSources=[str(online / 'fieldpos_measurements.jsonl'), str(online / '2g_presence_clients.json')])
    return cfg


def atomic_json(path, payload):
    path = Path(path)
    # Configuration directories are never writable through this helper.
    if path.resolve() == CONFIG_PATH.resolve() or 'config' in path.relative_to(DATA_DIR).parts:
        raise ValueError('Refusing to write deployment configuration')
    with DATA_LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            # Same-directory replacement: do not rename across local disk and SMB.
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, prefix='.' + path.name, suffix='.tmp', delete=False) as stream:
                temporary = Path(stream.name)
                json.dump(payload, stream, ensure_ascii=False, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


def save_wind_settings(cfg):
    atomic_json(WIND_SETTINGS_PATH, {key: value for key, value in cfg.items() if key in WIND_SETTING_KEYS})
