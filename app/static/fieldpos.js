/* HPTrax FieldPos */
"use strict";

(function () {
  const PRESENCE_ENDPOINT = "/api/my-position/presence";
  const FETCH_INTERVAL_MS = 5000;
  const VERSION_CHECK_INTERVAL_MS = 30000;
  const OFFLINE_COORD = -999;
  const NORWAY_BOUNDS = [
    [57.7, 3.8],
    [71.4, 31.4]
  ];
  const NORWAY_MAX_ZOOM = 4.75;
  const MAP_STORAGE_KEY = "fieldposBaseMap";
  const APP_VERSION = document.querySelector('meta[name="fieldpos-version"]')?.content || "";
  const RELOAD_TO_NORWAY_KEY = "fieldposReloadToNorway";
  let loadedIndexSignature = "";

  const state = {
    enabled: false,
    watchId: null,
    position: null,
    clientId: getClientId(),
    clientHash: null,
    markers: new Map(),
    measurementMarkers: new Map(),
    clients: [],
    measurementMarker: null,
    lastMeasurement: null,
    sentMeasurements: [],
    lastMeasurementPosition: null,
    metWindReferences: [],
    metWindCustomReferences: [],
    metWindManualMarker: null,
    metWindSettingsDirty: false,
    metWindPickingMapPoint: false,
    metWindAdmin: false,
    zoomBoxActive: false,
    zoomBoxStart: null,
    zoomBoxLayer: null,
    zoomBoxPointerId: null,
    zoomBoxSuppressClick: false,
    currentView: "map",
    firstFix: true,
    inFlight: false,
    intervalId: null
  };

  const map = L.map("map", {
    zoomControl: true,
    zoomDelta: 0.25,
    zoomSnap: 0.25
  });
  focusNorway();

  const baseMaps = {
    osm: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    }),
    topo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      attribution: "&copy; OpenTopoMap"
    }),
    satellite: L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 19,
        attribution: "&copy; Esri"
      }
    ),
    cartoLight: L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      {
        maxZoom: 19,
        attribution: "&copy; CARTO"
      }
    )
  };

  let activeBaseMapKey = null;

  const markerLayer = L.layerGroup().addTo(map);
  const statusText = document.getElementById("status-text");
  const gpsButton = document.getElementById("gps-toggle");
  const placeNamesToggle = document.getElementById("place-names-toggle");
  const kommunerDemografiToggle = document.getElementById("kommuner-demografi-toggle");
  const radnettStationsToggle = document.getElementById("radnett-stations-toggle");
  const ambientGammaToggle = document.getElementById("ambient-gamma-toggle");
  const metWindToggle = document.getElementById("met-wind-toggle");
  const placeNamesDockToggle = document.getElementById("place-names-dock-toggle");
  const kommunerDemografiDockToggle = document.getElementById("kommuner-demografi-dock-toggle");
  const radnettStationsDockToggle = document.getElementById("radnett-stations-dock-toggle");
  const ambientGammaDockToggle = document.getElementById("ambient-gamma-dock-toggle");
  const metWindDockToggle = document.getElementById("met-wind-dock-toggle");
  const metWindAreaDockToggle = document.getElementById("met-wind-area-dock-toggle");
  const adminModeIndicator = document.getElementById("admin-mode-indicator");
  const layoutSettingsPanel = document.getElementById("layout-settings-panel");
  const layoutSettingsClose = document.getElementById("layout-settings-close");
  const layoutPlaceNamesToggle = document.getElementById("layout-place-names-toggle");
  const layoutKommunerToggle = document.getElementById("layout-kommuner-toggle");
  const layoutRadnettToggle = document.getElementById("layout-radnett-toggle");
  const layoutGammaToggle = document.getElementById("layout-gamma-toggle");
  const layoutMetWindToggle = document.getElementById("layout-met-wind-toggle");
  const metWindGridStepInput = document.getElementById("met-wind-grid-step");
  const metWindChoiceButtons = document.querySelectorAll(".met-wind-choice");
  const metWindGridStatus = document.getElementById("met-wind-grid-status");
  const metWindRadiusInput = document.getElementById("met-wind-radius");
  const metWindRadiusStatus = document.getElementById("met-wind-radius-status");
  const metWindReferencePanel = document.getElementById("met-wind-reference-panel");
  const metWindReferenceClose = document.getElementById("met-wind-reference-close");
  const metWindReferenceList = document.getElementById("met-wind-reference-list");
  const metWindReferenceAll = document.getElementById("met-wind-reference-all");
  const metWindReferenceNone = document.getElementById("met-wind-reference-none");
  const metWindReferenceSave = document.getElementById("met-wind-reference-save");
  const metWindReferenceStatus = document.getElementById("met-wind-reference-status");
  const metWindMapPickButton = document.getElementById("met-wind-map-pick-button");
  const metWindAdminLogout = document.getElementById("met-wind-admin-logout");
  const metWindVisibleOnClose = document.getElementById("met-wind-visible-on-close");
  const reportEmailInput = document.getElementById("report-email");
  const reportIntervalInput = document.getElementById("report-interval");
  const reportSaveButton = document.getElementById("report-save");
  const dosimeterWindowOpenButton = document.getElementById("dosimeter-window-open");
  const reportSendNowButton = document.getElementById("report-send-now");
  const reportIntervalToggleButton = document.getElementById("report-interval-toggle");
  const reportStatus = document.getElementById("report-status");
  const baseMapButtons = document.querySelectorAll("[data-base-map]");
  const zoomAllButton = document.getElementById("zoom-all");
  const zoomNorwayButton = document.getElementById("zoom-norway");
  const zoomBoxButton = document.getElementById("zoom-box");
  const clientFocusSelect = document.getElementById("client-focus");
  const measurementFocusSelect = document.getElementById("measurement-focus");
  const measurementForm = document.getElementById("measurement-a-form");
  const measurementLatInput = document.getElementById("measure-lat");
  const measurementLonInput = document.getElementById("measure-lon");
  const measurementTimestampInput = document.getElementById("measure-timestamp");
  const measurementOutput = document.getElementById("measurement-output");
  const measurementNowButton = document.getElementById("measurement-now");
  const measurementZoomButton = document.getElementById("measurement-zoom");
  const measurementGpsStatus = document.getElementById("measure-gps-status");
  const stationNameInput = document.getElementById("measure-station-name");
  const viewButtons = document.querySelectorAll("[data-view-target]");
  const appTitle = document.querySelector("h1");
  const measurementAPanel = document.getElementById("measurement-a-panel");
  const measurementBPanel = document.getElementById("measurement-b-panel");
  const mapElement = document.getElementById("map");
  const mapHomeSlot = document.getElementById("map-home-slot");
  const measurementMapSlot = document.getElementById("measurement-map-slot");
  const clearMeasurementsButton = document.getElementById("clear-measurements-button");
  const placeNames = window.FieldPosPlaceNames?.create({
    L,
    map,
    toggle: placeNamesToggle,
    validLatLon,
    escapeHtml
  });
  const kartInfo = window.FieldPosKartInfo?.create({
    L,
    map
  });
  const kommunerDemografi = window.FieldPosKommunerDemografi?.create({
    L,
    map,
    toggle: kommunerDemografiToggle,
    button: kommunerDemografiDockToggle,
    escapeHtml
  });
  const radnettStations = window.FieldPosRadnettStations?.create({
    L,
    map,
    toggle: radnettStationsToggle,
    dockToggle: radnettStationsDockToggle,
    validLatLon,
    escapeHtml
  });
  const ambientGamma = window.FieldPosAmbientGamma?.create({
    L,
    map,
    toggle: ambientGammaToggle,
    dockToggle: ambientGammaDockToggle,
    disabled: true,
    escapeHtml
  });
  const metWind = window.FieldPosMetWind?.create({
    L,
    map,
    toggle: metWindToggle,
    dockToggle: metWindDockToggle,
    dockClick: false,
    escapeHtml
  });
  const metWindArea = window.FieldPosMetWind?.create({
    L,
    map,
    dataUrl: "data/online2/met_wind_area.geojson",
    storageKey: "fieldposMetWindArea",
    dockToggle: metWindAreaDockToggle,
    label: "Norge vind",
    statusEvent: "fieldpos:met-wind-area-status",
    escapeHtml
  });


  function getClientId() {
    const key = "fieldposClientId";
    try {
      const existing = window.sessionStorage.getItem(key);
      if (existing) return existing;

      const next = window.crypto?.randomUUID
        ? `fieldpos-${window.crypto.randomUUID()}`
        : `fieldpos-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

      window.sessionStorage.setItem(key, next);
      return next;
    } catch (err) {
      return `fieldpos-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    }
  }

  function setStatus(text, mode) {
    statusText.textContent = text;
    if (measurementGpsStatus) measurementGpsStatus.value = text;
    gpsButton.classList.remove("active", "waiting", "error");
    if (mode) gpsButton.classList.add(mode);
    gpsButton.setAttribute("aria-pressed", String(state.enabled));
    gpsButton.setAttribute("aria-label", state.enabled ? "Slå av GPS" : "Slå på GPS");
    if (document.body.classList.contains("mobile-view")) {
      gpsButton.textContent = state.enabled ? "GPS av" : "GPS på";
    }
  }

  function focusNorway() {
    map.fitBounds(NORWAY_BOUNDS, {
      maxZoom: NORWAY_MAX_ZOOM,
      padding: [18, 18]
    });
  }

  function focusBounds(bounds) {
    map.fitBounds(bounds, {
      padding: [18, 18]
    });
  }

  function indexSignature(response, html, version) {
    const lastModified = response.headers.get("Last-Modified") || "";
    return `${version || "no-version"}|${lastModified}|${html.length}`;
  }

  async function checkForAppUpgrade() {
    if (!APP_VERSION) return;

    try {
      const res = await fetch(`index.html?version-check=${Date.now()}`, {
        cache: "no-store",
        headers: { "Accept": "text/html" }
      });
      if (!res.ok) return;

      const html = await res.text();
      const match = html.match(/<meta\s+name=["']fieldpos-version["']\s+content=["']([^"']+)["']/i);
      const serverVersion = match?.[1] || "";
      const serverSignature = indexSignature(res, html, serverVersion);
      const versionChanged = Boolean(serverVersion && serverVersion !== APP_VERSION);
      const fileChanged = Boolean(loadedIndexSignature && serverSignature !== loadedIndexSignature);

      if (!loadedIndexSignature) {
        loadedIndexSignature = serverSignature;
        if (!versionChanged) return;
      } else if (!versionChanged && !fileChanged) {
        return;
      }

      try {
        window.sessionStorage.setItem(RELOAD_TO_NORWAY_KEY, "1");
      } catch (err) {}
      window.location.reload();
    } catch (err) {
      console.warn("[fieldpos] versjonssjekk feilet", err);
    }
  }

  function applyReloadFocus() {
    try {
      if (window.sessionStorage.getItem(RELOAD_TO_NORWAY_KEY) !== "1") return;
      window.sessionStorage.removeItem(RELOAD_TO_NORWAY_KEY);
    } catch (err) {
      return;
    }

    setView("map");
    focusNorway();
    state.firstFix = false;
  }

  function setView(view) {
    state.currentView = view;
    const isMeasureA = view === "measure-a";
    const isMeasureB = view === "measure-b";
    document.body.classList.toggle("measurement-active", isMeasureA || isMeasureB);

    if (measurementAPanel) measurementAPanel.hidden = !isMeasureA;
    if (measurementBPanel) measurementBPanel.hidden = !isMeasureB;

    if (!isMeasureA && state.measurementMarker) {
      markerLayer.removeLayer(state.measurementMarker);
      state.measurementMarker = null;
    }

    viewButtons.forEach((button) => {
      const target = button.dataset.viewTarget;
      button.hidden = view === "map" ? target === "map" : target !== "map";
      button.classList.toggle("active", target === view);
    });

    if (appTitle) {
      if (isMeasureA) appTitle.textContent = "Modul: Måledata A";
      else if (isMeasureB) appTitle.textContent = "Modul: Måledata B";
      else appTitle.textContent = "Modul: FieldPos";
    }

    const nextMapParent = isMeasureA ? measurementMapSlot : mapHomeSlot;
    if (mapElement && nextMapParent && mapElement.parentElement !== nextMapParent) {
      nextMapParent.appendChild(mapElement);
    }

    requestAnimationFrame(() => {
      map.invalidateSize();
      if (isMeasureA) updateMeasurementMarker(false);
    });
  }

  function storedBaseMapKey() {
    try {
      const key = window.localStorage.getItem(MAP_STORAGE_KEY);
      return baseMaps[key] && key !== "cartoLight" ? key : "osm";
    } catch (err) {
      return "osm";
    }
  }

  function setBaseMap(key) {
    const nextKey = baseMaps[key] ? key : "osm";
    if (activeBaseMapKey === nextKey) return;

    if (activeBaseMapKey && baseMaps[activeBaseMapKey]) {
      map.removeLayer(baseMaps[activeBaseMapKey]);
    }

    baseMaps[nextKey].addTo(map);
    activeBaseMapKey = nextKey;
    document.body.dataset.baseMap = nextKey;

    try {
      window.localStorage.setItem(MAP_STORAGE_KEY, nextKey);
    } catch (err) {}

    document.querySelectorAll('input[name="base-map"]').forEach((input) => {
      input.checked = input.value === nextKey;
    });

    baseMapButtons.forEach((button) => {
      const active = button.dataset.baseMap === nextKey;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });

    requestAnimationFrame(() => map.invalidateSize());
  }

  function setupBaseMapButtons() {
    document.querySelectorAll('input[name="base-map"]').forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) setBaseMap(input.value);
      });
    });

    baseMapButtons.forEach((button) => {
      button.addEventListener("click", () => {
        setBaseMap(button.dataset.baseMap);
      });
    });
  }

  function storedToggleValue(key, fallback = true) {
    try {
      const value = window.localStorage.getItem(key);
      return value === null ? fallback : value === "1";
    } catch (err) {
      return fallback;
    }
  }

  function syncLayoutToggles() {
    if (layoutPlaceNamesToggle) {
      layoutPlaceNamesToggle.checked = placeNamesToggle
        ? placeNamesToggle.checked
        : storedToggleValue("fieldposPlaceNames", true);
    }
    if (layoutKommunerToggle) {
      layoutKommunerToggle.checked = kommunerDemografiToggle
        ? kommunerDemografiToggle.checked
        : storedToggleValue("fieldposKommunerDemografi", true);
    }
    if (layoutRadnettToggle) {
      layoutRadnettToggle.checked = radnettStationsToggle
        ? radnettStationsToggle.checked
        : storedToggleValue("fieldposRadnettStations", true);
    }
    if (layoutGammaToggle) {
      layoutGammaToggle.checked = ambientGammaToggle
        ? ambientGammaToggle.checked
        : storedToggleValue("fieldposAmbientGamma", false);
    }
    if (layoutMetWindToggle) {
      layoutMetWindToggle.checked = metWindToggle
        ? metWindToggle.checked
        : storedToggleValue("fieldposMetWind", false);
    }
  }

  function setReportStatus(text) {
    if (reportStatus) reportStatus.textContent = text || "";
  }

  function isIdentifiedForEmail() {
    const gpsReady = gpsButton.classList.contains("active") || gpsButton.classList.contains("waiting");
    return Boolean(state.clientHash && state.enabled && gpsReady);
  }

  function setReportSendButtonPressed(pressed) {
    if (!reportSendNowButton) return;
    reportSendNowButton.classList.toggle("active", Boolean(pressed));
    reportSendNowButton.setAttribute("aria-pressed", pressed ? "true" : "false");
    reportSendNowButton.disabled = Boolean(pressed);
  }

  function setReportIntervalButtonActive(active) {
    if (reportIntervalToggleButton) {
      reportIntervalToggleButton.classList.toggle("active", Boolean(active));
      reportIntervalToggleButton.setAttribute("aria-pressed", active ? "true" : "false");
      reportIntervalToggleButton.dataset.active = active ? "1" : "0";
      reportIntervalToggleButton.textContent = active ? "Stopp intervall" : "Start intervall";
    }
    if (reportIntervalInput) {
      reportIntervalInput.disabled = Boolean(active);
      reportIntervalInput.setAttribute("aria-disabled", active ? "true" : "false");
    }
  }

  function formatReportTime(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return "";
    return new Date(num).toLocaleString("no-NO");
  }

  function reportStatusText(payload) {
    const settings = payload?.settings || {};
    const state = payload?.state || {};
    const intervalActive = Boolean(state.intervalActive);
    setReportIntervalButtonActive(intervalActive);
    kartInfo?.update({ emailIntervalActive: intervalActive });
    const count = Number(payload?.measurementCount || state.lastSentCount || 0);
    const lastSent = formatReportTime(state.lastSentAt);
    const intervalAnchor = formatReportTime(state.intervalAnchorAt);
    const intervalState = state.intervalActive
      ? (intervalAnchor ? ` Intervall fra: ${intervalAnchor}.` : " Intervall aktiv.")
      : " Intervall av. Start/stopp krever admin.";
    const method = state.lastDeliveryMethod ? ` via ${state.lastDeliveryMethod}` : "";
    const error = state.lastError ? ` Feil: ${state.lastError}` : "";
    return `Rapport: ${settings.email || ""}, hvert ${settings.intervalMinutes || ""} min. Målinger: ${count}.${lastSent ? ` Sist sendt: ${lastSent}${method}.` : ""}${intervalState}${error}`;
  }

  function setMetWindGridStatus(gridStepKm, maxGridPoints, refresh) {
    if (!metWindGridStatus) return;
    const step = Number(gridStepKm);
    const stepText = Number.isFinite(step) && step > 0
      ? (Number.isInteger(step) ? String(step) : step.toFixed(1))
      : String(gridStepKm || "");
    const maxText = Number.isFinite(Number(maxGridPoints)) ? `, maks ${maxGridPoints} punkter` : "";
    const errorText = refresh?.lastError ? ` Feil: ${refresh.lastError}` : "";
    const completed = Number(refresh?.completed);
    const total = Number(refresh?.total);
    const errors = Number(refresh?.errors);
    const progressText = Number.isFinite(completed) && Number.isFinite(total) && total > 0
      ? `${completed}/${total} punkter${Number.isFinite(errors) && errors > 0 ? `, ${errors} feil` : ""}`
      : "";
    const refreshText = refresh?.running
      ? `. Nye vinddata lastes ...${progressText ? ` ${progressText}` : ""}`
      : refresh?.restartPending
        ? ". Ny lasting starter ..."
      : refresh?.finishedAt
        ? `. Ferdig lastet${progressText ? `: ${progressText}` : ""}.`
        : "";
    metWindGridStatus.textContent = `Valgt: ${stepText || "5"} km${maxText}${refreshText}${errorText}`;
  }

  function setMetWindRadiusStatus(radiusKm) {
    if (!metWindRadiusStatus) return;
    const radius = Number(radiusKm);
    const radiusText = Number.isFinite(radius) && radius > 0
      ? (Number.isInteger(radius) ? String(radius) : radius.toFixed(1))
      : "25";
    metWindRadiusStatus.textContent = `Valgt: ${radiusText} km`;
  }

  function formatKm(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return String(value || "");
    return Number.isInteger(num) ? String(num) : num.toLocaleString("no-NO", { maximumFractionDigits: 1 });
  }

  function setMetWindChoice(radiusKm, gridStepKm, options = {}) {
    const radius = Number(radiusKm);
    const gridStep = Number(gridStepKm);
    if (!Number.isFinite(radius) || !Number.isFinite(gridStep)) return;
    if (metWindRadiusInput) metWindRadiusInput.value = String(radius);
    if (metWindGridStepInput) metWindGridStepInput.value = String(gridStep);
    metWindChoiceButtons.forEach((button) => {
      const buttonRadius = Number(button.dataset.radiusKm);
      const buttonGridStep = Number(button.dataset.gridStepKm);
      button.classList.toggle("active", buttonRadius === radius && buttonGridStep === gridStep);
    });
    setMetWindRadiusStatus(radius);
    if (options.markDirty) {
      state.metWindSettingsDirty = true;
      if (metWindGridStatus) metWindGridStatus.textContent = `Valgt: ${formatKm(gridStep)} km. Trykk Lagre og hent.`;
    }
  }

  async function loadMetWindSettings(options = {}) {
    if (!metWindGridStepInput) return;
    const preserveInputs = Boolean(options.preserveInputs && state.metWindSettingsDirty);
    try {
      const res = await fetch("/api/met-wind-settings", {
        cache: "no-store",
        headers: { "Accept": "application/json" }
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      const settings = payload.settings || {};
      if (!preserveInputs) {
        setMetWindChoice(settings.nearbyRadiusKm || 25, settings.gridStepKm || 5);
      }
      const shownGridStep = preserveInputs ? metWindGridStepInput.value || settings.gridStepKm || 5 : settings.gridStepKm || 5;
      const shownRadius = preserveInputs ? metWindRadiusInput?.value || settings.nearbyRadiusKm || 25 : settings.nearbyRadiusKm || 25;
      if (preserveInputs) setMetWindChoice(shownRadius, shownGridStep);
      setMetWindGridStatus(shownGridStep, settings.maxGridPoints, settings.refresh);
      setMetWindRadiusStatus(shownRadius);
    } catch (err) {
      if (metWindGridStatus) metWindGridStatus.textContent = `Vindavstand ikke hentet: ${err.message}`;
    }
  }

  function setMetWindReferenceStatus(text) {
    if (metWindReferenceStatus) metWindReferenceStatus.textContent = text || "";
  }

  function storedMetWindVisible() {
    try {
      return window.localStorage.getItem("fieldposMetWind") === "1";
    } catch (err) {
      return false;
    }
  }

  function toggleNearbyWindLayer() {
    const next = !storedMetWindVisible();
    setWindLayersVisible(next);
  }

  function setWindLayersVisible(visible) {
    const enabled = Boolean(visible);
    metWind?.setEnabled(enabled);
    if (metWindToggle) metWindToggle.checked = enabled;
    if (layoutMetWindToggle) layoutMetWindToggle.checked = enabled;
  }

  function setAdminMode(active) {
    state.metWindAdmin = Boolean(active);
    if (adminModeIndicator) adminModeIndicator.hidden = !state.metWindAdmin;
    updateMetWindManualMarker();
  }

  async function requestMetWindAdmin() {
    if (!state.metWindAdmin) {
      const password = await fetch("/api/access").then(r => r.json()).then(p => p.admin).catch(() => false);
      if (!password) {
        setMetWindReferenceStatus("Vindadmin ikke aktivert.");
        return;
      }
      setAdminMode(true);
    }
    setWindLayersVisible(true);
    if (metWindVisibleOnClose) metWindVisibleOnClose.checked = true;
    openMetWindReferencePanel();
  }

  function referenceLabel(ref) {
    return ref?.label || ref?.key || "Ukjent vindpunkt";
  }

  function sortMetWindReferences(references) {
    return [...references].sort((a, b) => {
      const aManual = a?.source === "manualWindReference" ? 0 : 1;
      const bManual = b?.source === "manualWindReference" ? 0 : 1;
      if (aManual !== bManual) return aManual - bManual;
      return referenceLabel(a).localeCompare(referenceLabel(b), "no");
    });
  }

  function renderMetWindReferences(references, selectedReferenceKeys) {
    if (!metWindReferenceList) {
      updateMetWindManualMarker();
      return;
    }
    state.metWindReferences = sortMetWindReferences(Array.isArray(references) ? references : []);
    const selected = Array.isArray(selectedReferenceKeys)
      ? new Set(selectedReferenceKeys.map(String))
      : new Set(state.metWindReferences.map((ref) => String(ref.key || "")));

    metWindReferenceList.textContent = "";

    if (!state.metWindReferences.length) {
      metWindReferenceList.textContent = "Ingen målepunkter eller aktive noder funnet.";
      updateMetWindManualMarker();
      return;
    }

    state.metWindReferences.forEach((ref) => {
      const key = String(ref.key || "");
      const label = document.createElement("label");
      label.className = "met-wind-reference-row";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = key;
      checkbox.checked = selected.has(key);

      const text = document.createElement("span");
      const main = document.createElement("span");
      main.className = "met-wind-reference-main";
      main.textContent = referenceLabel(ref);
      const sub = document.createElement("span");
      sub.className = "met-wind-reference-sub";
      sub.textContent = `${Number(ref.lat).toFixed(5)}, ${Number(ref.lon).toFixed(5)} · ${ref.source || ""}`;

      text.appendChild(main);
      text.appendChild(sub);
      label.appendChild(checkbox);
      label.appendChild(text);
      metWindReferenceList.appendChild(label);
    });
    updateMetWindManualMarker();
  }

  function currentMetWindManualReference() {
    const custom = Array.isArray(state.metWindCustomReferences) ? state.metWindCustomReferences : [];
    return custom.find((ref) => ref?.source === "manualWindReference") || null;
  }

  function removeMetWindManualMarker() {
    if (!state.metWindManualMarker) return;
    markerLayer.removeLayer(state.metWindManualMarker);
    state.metWindManualMarker = null;
  }

  function updateMetWindManualMarker() {
    const panelOpen = metWindReferencePanel && !metWindReferencePanel.hidden;
    const ref = currentMetWindManualReference();
    const lat = Number(ref?.lat);
    const lon = Number(ref?.lon);

    if (!state.metWindAdmin || !panelOpen || !validLatLon(lat, lon)) {
      removeMetWindManualMarker();
      return;
    }

    const latlng = [lat, lon];
    if (!state.metWindManualMarker) {
      state.metWindManualMarker = L.marker(latlng, {
        interactive: false,
        keyboard: false,
        zIndexOffset: 1400,
        icon: L.divIcon({
          className: "met-wind-manual-reference-marker",
          html: '<span class="met-wind-manual-reference-dot"></span>',
          iconSize: [28, 28],
          iconAnchor: [14, 14]
        })
      }).addTo(markerLayer);
      return;
    }

    state.metWindManualMarker.setLatLng(latlng);
  }

  async function loadMetWindReferences() {
    if (!metWindReferenceList) return;
    metWindReferenceList.textContent = "Laster vindreferanser ...";
    setMetWindReferenceStatus("");
    try {
      const res = await fetch("/api/met-wind-references", {
        cache: "no-store",
        headers: { "Accept": "application/json" }
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      state.metWindCustomReferences = Array.isArray(payload.customReferencePoints)
        ? payload.customReferencePoints
        : [];
      renderMetWindReferences(payload.references || [], payload.selectedReferenceKeys);
      const count = Array.isArray(payload.references) ? payload.references.length : 0;
      setMetWindReferenceStatus(`${count} mulige vindreferanser.`);
    } catch (err) {
      metWindReferenceList.textContent = "Klarte ikke å hente vindreferanser.";
      setMetWindReferenceStatus(err.message);
    }
  }

  function checkedMetWindReferenceKeys() {
    if (!metWindReferenceList) return [];
    return Array.from(metWindReferenceList.querySelectorAll('input[type="checkbox"]:checked'))
      .map((input) => input.value)
      .filter(Boolean);
  }

  function setAllMetWindReferences(checked) {
    if (!metWindReferenceList) return;
    metWindReferenceList.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.checked = checked;
    });
  }

  function setMetWindMapPickMode(active) {
    state.metWindPickingMapPoint = Boolean(active);
    metWindMapPickButton?.classList.toggle("active", state.metWindPickingMapPoint);
    if (state.metWindPickingMapPoint) {
      setMetWindReferenceStatus("Klikk i kartet for å velge vindpunkt.");
    }
  }

  function selectedMetWindReferenceKeysWith(keyToAdd = "") {
    const selected = new Set(checkedMetWindReferenceKeys());
    if (keyToAdd) selected.add(String(keyToAdd));
    return Array.from(selected);
  }

  function addManualMetWindReference(latlng) {
    if (!state.metWindAdmin) return;
    const lat = Number(latlng?.lat);
    const lon = Number(latlng?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const roundedLat = Number(lat.toFixed(6));
    const roundedLon = Number(lon.toFixed(6));
    const key = `manual:${roundedLat.toFixed(6)},${roundedLon.toFixed(6)}`;
    const manualRef = {
      lat: roundedLat,
      lon: roundedLon,
      key,
      label: "Valgt kartpunkt",
      source: "manualWindReference"
    };
    const selected = selectedMetWindReferenceKeysWith(key);
    state.metWindCustomReferences = [manualRef];
    renderMetWindReferences([
      manualRef,
      ...state.metWindReferences.filter((ref) => ref?.source !== "manualWindReference")
    ], selected);
    updateMetWindManualMarker();
    setMetWindMapPickMode(false);
    setMetWindReferenceStatus(`Valgt kartpunkt: ${roundedLat.toFixed(5)}, ${roundedLon.toFixed(5)}. Trykk Lagre og hent.`);
  }

  function openMetWindReferencePanel() {
    if (!metWindReferencePanel) return;
    if (!state.metWindAdmin) return;
    state.metWindSettingsDirty = false;
    metWindReferencePanel.hidden = false;
    metWindDockToggle?.classList.add("active");
    if (metWindVisibleOnClose) metWindVisibleOnClose.checked = storedMetWindVisible();
    loadMetWindSettings();
    loadMetWindReferences();
    updateMetWindManualMarker();
  }

  function closeMetWindReferencePanel(options = {}) {
    if (!metWindReferencePanel) return;
    metWindReferencePanel.hidden = true;
    setMetWindMapPickMode(false);
    removeMetWindManualMarker();
    const keepVisible = Boolean(metWindVisibleOnClose?.checked);
    setWindLayersVisible(keepVisible);
    if (options.logout) {
      setAdminMode(false);
      metWindDockToggle?.classList.toggle("active", keepVisible);
    }
  }

  async function saveMetWindReferences() {
    if (!state.metWindAdmin) return;
    const selected = checkedMetWindReferenceKeys();
    setMetWindReferenceStatus(`${selected.length} vindreferanser valgt. Henter nye vinddata ...`);
    try {
      metWind?.setEnabled(true);
      if (metWindToggle) metWindToggle.checked = true;
      if (layoutMetWindToggle) layoutMetWindToggle.checked = true;
      await saveMetWindSettings(selected, state.metWindCustomReferences);
      setMetWindReferenceStatus(`${selected.length} vindreferanser lagret.`);
    } catch (err) {
      setMetWindReferenceStatus(`Lagring feilet: ${err.message}`);
    }
  }

  async function waitForMetWindRefreshAndReload(initialRefresh) {
    if (!metWind?.reload) return;
    let refresh = initialRefresh || {};

    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (!refresh.running && !refresh.restartPending) {
        await metWind.reload();
        if (metWindGridStatus) {
          const gridStepKm = metWindGridStepInput?.value || 5;
          const completed = Number(refresh.completed);
          const total = Number(refresh.total);
          const errors = Number(refresh.errors);
          const progressText = Number.isFinite(completed) && Number.isFinite(total) && total > 0
            ? `: ${completed}/${total} punkter${Number.isFinite(errors) && errors > 0 ? `, ${errors} feil` : ""}`
            : "";
          metWindGridStatus.textContent = `Valgt: ${gridStepKm} km. Ferdig lastet${progressText}.`;
        }
        return;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 2000));

      try {
        const res = await fetch("/api/met-wind-settings", {
          cache: "no-store",
          headers: { "Accept": "application/json" }
        });
        const payload = await res.json();
        if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
        const settings = payload.settings || {};
        refresh = settings.refresh || {};
        if (!state.metWindSettingsDirty) {
          setMetWindChoice(settings.nearbyRadiusKm || metWindRadiusInput?.value || 25, settings.gridStepKm || metWindGridStepInput?.value || 5);
        }
        const shownGridStep = state.metWindSettingsDirty ? metWindGridStepInput?.value || settings.gridStepKm || 5 : settings.gridStepKm || 5;
        const shownRadius = state.metWindSettingsDirty ? metWindRadiusInput?.value || settings.nearbyRadiusKm || 25 : settings.nearbyRadiusKm || 25;
        setMetWindGridStatus(shownGridStep, settings.maxGridPoints, refresh);
        setMetWindRadiusStatus(shownRadius);
        window.dispatchEvent(new CustomEvent("fieldpos:met-wind-status", {
          detail: {
            visible: true,
            loading: Boolean(refresh.running),
            loaded: Boolean(refresh.finishedAt),
            error: refresh.lastError || "",
            gridStepKm: settings.gridStepKm || 5,
            nearbyRadiusKm: Number(settings.nearbyRadiusKm || 25),
            completed: refresh.completed || 0,
            total: refresh.total || 0,
            errors: refresh.errors || 0
          }
        }));
      } catch (err) {
        if (metWindGridStatus) metWindGridStatus.textContent = `Vindstatus ikke hentet: ${err.message}`;
        return;
      }
    }

    await metWind.reload();
    if (metWindGridStatus) {
      const gridStepKm = metWindGridStepInput?.value || 5;
      metWindGridStatus.textContent = `Valgt: ${gridStepKm} km. Sjekk pågår fortsatt. Kartet er lastet på nytt.`;
    }
  }

  async function saveMetWindSettings(selectedReferenceKeys = null, customReferences = null) {
    if (!state.metWindAdmin) return;
    if (!metWindGridStepInput) return;
    const gridStepKm = Math.max(0.5, Math.min(100, Number(metWindGridStepInput.value || 5)));
    const nearbyRadiusKm = Math.max(1, Math.min(500, Number(metWindRadiusInput?.value || 25)));
    metWindGridStepInput.value = gridStepKm;
    if (metWindRadiusInput) metWindRadiusInput.value = nearbyRadiusKm;
    if (metWindGridStatus) metWindGridStatus.textContent = `Valgt: ${gridStepKm} km. Starter lasting ...`;
    setMetWindRadiusStatus(nearbyRadiusKm);
    window.dispatchEvent(new CustomEvent("fieldpos:met-wind-status", {
      detail: {
        visible: true,
        loading: true,
        loaded: false,
        error: "",
        gridStepKm,
        nearbyRadiusKm
      }
    }));
    const params = new URLSearchParams({
      gridStepKm: String(gridStepKm),
      nearbyRadiusKm: String(nearbyRadiusKm),

    });
    if (Array.isArray(selectedReferenceKeys)) {
      params.set("selectedReferences", JSON.stringify(selectedReferenceKeys));
    }
    if (Array.isArray(customReferences)) {
      params.set("customReferences", JSON.stringify(customReferences));
    }
    try {
      const res = await fetch(`/api/met-wind-settings?${params.toString()}`, {
        cache: "no-store",
        headers: { "Accept": "application/json" }
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      const settings = payload.settings || {};
      state.metWindSettingsDirty = false;
      setMetWindGridStatus(settings.gridStepKm || gridStepKm, settings.maxGridPoints, settings.refresh);
      setMetWindRadiusStatus(settings.nearbyRadiusKm || nearbyRadiusKm);
      await waitForMetWindRefreshAndReload(settings.refresh);
      return payload;
    } catch (err) {
      if (metWindGridStatus) metWindGridStatus.textContent = `Lagring feilet: ${err.message}`;
      window.dispatchEvent(new CustomEvent("fieldpos:met-wind-status", {
        detail: {
          visible: true,
          loading: false,
          error: err.message,
          gridStepKm
        }
      }));
      throw err;
    }
  }

  async function loadReportSettings() {
    if (!reportEmailInput || !reportIntervalInput) return;
    try {
      const res = await fetch("/api/report-settings", {
        cache: "no-store",
        headers: { "Accept": "application/json" }
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      reportEmailInput.value = payload.settings?.email || "opbitlab@dsa.no";
      reportIntervalInput.value = payload.settings?.intervalMinutes || 60;
      setReportStatus(reportStatusText(payload));
    } catch (err) {
      setReportStatus(`Rapportinnstillinger ikke hentet: ${err.message}`);
    }
  }

  async function saveReportSettings() {
    if (!reportEmailInput || !reportIntervalInput) return;
    const params = new URLSearchParams({
      email: reportEmailInput.value || "opbitlab@dsa.no",
      intervalMinutes: reportIntervalInput.value || "60"
    });
    try {
      const res = await fetch(`/api/report-settings?${params.toString()}`, {
        cache: "no-store",
        headers: { "Accept": "application/json" }
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      setReportStatus(`Lagret. ${reportStatusText(payload)}`);
    } catch (err) {
      setReportStatus(`Lagring feilet: ${err.message}`);
    }
  }

  function closeLayoutSettingsPanel() {
    if (!layoutSettingsPanel) return;
    layoutSettingsPanel.hidden = true;
    placeNamesDockToggle?.classList.remove("active");
  }

  function openDosimeterWindow() {
    if (document.body.classList.contains("mobile-view")) {
      document.getElementById("mobile-dosimeter-dialog")?.showModal();
      return;
    }
    const features = "popup=yes,width=430,height=860,resizable=yes,scrollbars=yes";
    const win = window.open("07_dosimeter_lcars.html", "fieldpos-dosimeter", features);
    if (win) {
      win.focus();
      return;
    }
    window.location.href = "07_dosimeter_lcars.html";
  }

  async function sendReportNow() {
    if (!isIdentifiedForEmail()) {
      setReportStatus("Epost kan ikke sendes før S er aktiv og klienten er identifisert.");
      return;
    }

    setReportSendButtonPressed(true);
    setReportStatus("Sender epost ...");
    const params = new URLSearchParams({
      clientId: state.clientId,
      clientHash: state.clientHash || "",
      senderName: ownName()
    });
    try {
      const res = await fetch(`/api/report-send-now?${params.toString()}`, {
        cache: "no-store",
        headers: { "Accept": "application/json" }
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      setReportStatus("Rapport sendt nå.");
      loadReportSettings();
    } catch (err) {
      setReportStatus(`Epostsending feilet: ${err.message}`);
    } finally {
      window.setTimeout(() => setReportSendButtonPressed(false), 900);
    }
  }

  async function toggleReportInterval() {
    const password = await fetch("/api/access").then(r => r.json()).then(p => p.admin).catch(() => false);
    if (!password) {
      setReportStatus("Epostadmin ikke aktivert.");
      return;
    }

    const isActive = reportIntervalToggleButton?.dataset.active === "1";
    const endpoint = isActive ? "/api/report-interval-stop" : "/api/report-interval-start";
    const params = new URLSearchParams();
    if (!isActive) {
      params.set("email", reportEmailInput?.value || "opbitlab@dsa.no");
      params.set("intervalMinutes", reportIntervalInput?.value || "60");
    }
    try {
      const res = await fetch(`${endpoint}?${params.toString()}`, {
        cache: "no-store",
        headers: { "Accept": "application/json" }
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      setReportStatus(isActive ? "Epostintervall stoppet." : "Epostintervall startet.");
      loadReportSettings();
    } catch (err) {
      setReportStatus(`Epostintervall feilet: ${err.message}`);
    }
  }

  function setupLayoutSettingsPanel() {
    if (placeNamesDockToggle && layoutSettingsPanel) {
      placeNamesDockToggle.addEventListener("click", () => {
        const open = layoutSettingsPanel.hidden;
        layoutSettingsPanel.hidden = !open;
        placeNamesDockToggle.classList.toggle("active", open);
        syncLayoutToggles();
        if (open) loadReportSettings();
        if (open) loadMetWindSettings();
      });
    }

    if (layoutSettingsClose && layoutSettingsPanel) {
      layoutSettingsClose.addEventListener("click", closeLayoutSettingsPanel);
    }

    if (layoutPlaceNamesToggle) {
      layoutPlaceNamesToggle.addEventListener("change", () => {
        placeNames?.setEnabled(layoutPlaceNamesToggle.checked);
        if (placeNamesToggle) placeNamesToggle.checked = layoutPlaceNamesToggle.checked;
      });
    }

    if (placeNamesToggle) {
      placeNamesToggle.addEventListener("change", () => {
        if (layoutPlaceNamesToggle) layoutPlaceNamesToggle.checked = placeNamesToggle.checked;
      });
    }

    if (layoutKommunerToggle) {
      layoutKommunerToggle.addEventListener("change", () => {
        kommunerDemografi?.setEnabled(layoutKommunerToggle.checked);
        if (kommunerDemografiToggle) kommunerDemografiToggle.checked = layoutKommunerToggle.checked;
      });
    }

    if (kommunerDemografiToggle) {
      kommunerDemografiToggle.addEventListener("change", () => {
        if (layoutKommunerToggle) layoutKommunerToggle.checked = kommunerDemografiToggle.checked;
      });
    }

    if (layoutRadnettToggle) {
      layoutRadnettToggle.addEventListener("change", () => {
        radnettStations?.setEnabled(layoutRadnettToggle.checked);
        if (radnettStationsToggle) radnettStationsToggle.checked = layoutRadnettToggle.checked;
      });
    }

    if (radnettStationsToggle) {
      radnettStationsToggle.addEventListener("change", () => {
        if (layoutRadnettToggle) layoutRadnettToggle.checked = radnettStationsToggle.checked;
      });
    }

    if (layoutGammaToggle) {
      layoutGammaToggle.disabled = true;
      layoutGammaToggle.addEventListener("change", () => {
        if (layoutGammaToggle.disabled) return;
        ambientGamma?.setEnabled(layoutGammaToggle.checked);
        if (ambientGammaToggle) ambientGammaToggle.checked = layoutGammaToggle.checked;
      });
    }

    if (ambientGammaToggle) {
      ambientGammaToggle.addEventListener("change", () => {
        if (layoutGammaToggle) layoutGammaToggle.checked = ambientGammaToggle.checked;
      });
    }

    if (layoutMetWindToggle) {
      layoutMetWindToggle.addEventListener("change", () => {
        setWindLayersVisible(layoutMetWindToggle.checked);
      });
    }

    if (metWindToggle) {
      metWindToggle.addEventListener("change", () => {
        setWindLayersVisible(metWindToggle.checked);
        if (layoutMetWindToggle) layoutMetWindToggle.checked = metWindToggle.checked;
      });
    }

    let metWindClickTimer = null;
    metWindDockToggle?.addEventListener("click", () => {
      if (metWindClickTimer) return;
      metWindClickTimer = window.setTimeout(() => {
        metWindClickTimer = null;
        toggleNearbyWindLayer();
      }, 230);
    });
    metWindDockToggle?.addEventListener("dblclick", (ev) => {
      ev.preventDefault();
      if (metWindClickTimer) {
        window.clearTimeout(metWindClickTimer);
        metWindClickTimer = null;
      }
      requestMetWindAdmin();
    });
    metWindReferenceClose?.addEventListener("click", closeMetWindReferencePanel);
    metWindAdminLogout?.addEventListener("click", () => closeMetWindReferencePanel({ logout: true }));
    metWindReferenceAll?.addEventListener("click", () => setAllMetWindReferences(true));
    metWindReferenceNone?.addEventListener("click", () => setAllMetWindReferences(false));
    metWindReferenceSave?.addEventListener("click", saveMetWindReferences);
    metWindMapPickButton?.addEventListener("click", () => setMetWindMapPickMode(!state.metWindPickingMapPoint));
    map.getContainer().addEventListener("pointerdown", startZoomBoxDrag, { passive: false });
    map.getContainer().addEventListener("pointermove", moveZoomBoxDrag, { passive: false });
    map.getContainer().addEventListener("pointerup", endZoomBoxDrag, { passive: false });
    map.getContainer().addEventListener("pointercancel", cancelZoomBoxDrag, { passive: false });
    map.on("click", (ev) => {
      if (state.zoomBoxActive || state.zoomBoxSuppressClick) return;
      if (!state.metWindPickingMapPoint) return;
      addManualMetWindReference(ev.latlng);
    });

    reportSaveButton?.addEventListener("click", closeLayoutSettingsPanel);
    dosimeterWindowOpenButton?.addEventListener("click", openDosimeterWindow);
    reportSendNowButton?.addEventListener("click", sendReportNow);
    reportIntervalToggleButton?.addEventListener("click", toggleReportInterval);
    metWindChoiceButtons.forEach((button) => {
      button.addEventListener("click", () => {
        setMetWindChoice(button.dataset.radiusKm, button.dataset.gridStepKm, { markDirty: true });
      });
    });
    syncLayoutToggles();
    loadReportSettings();
    loadMetWindSettings();
  }

  function validLatLon(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  }

  function intValue(value) {
    return Number.parseInt(String(value ?? "0"), 10) || 0;
  }

  function ownName() {
    try {
      return (window.localStorage.getItem("fieldposDisplayName") || "").trim() || "Min pos";
    } catch (err) {
      return "Min pos";
    }
  }

  function setOwnName(name) {
    const clean = String(name || "").trim().slice(0, 24);
    try {
      if (clean) window.localStorage.setItem("fieldposDisplayName", clean);
      else window.localStorage.removeItem("fieldposDisplayName");
    } catch (err) {}
    if (stationNameInput && stationNameInput.value !== clean) {
      stationNameInput.value = clean;
    }
    return clean;
  }

  function askNameIfNeeded() {
    try {
      const current = window.localStorage.getItem("fieldposDisplayName") || "";
      if (current) return current;
      const next = (window.prompt("Navn som vises på kartet:", "") || "").trim().slice(0, 24);
      if (next) setOwnName(next);
      return next || "Min pos";
    } catch (err) {
      return "Min pos";
    }
  }

  function positionFromGeolocation(position) {
    const coords = position.coords || {};
    const lat = Number(coords.latitude);
    const lon = Number(coords.longitude);
    if (!validLatLon(lat, lon)) return null;

    const speedMps = Number(coords.speed);
    return {
      lat,
      lon,
      accuracy: Number.isFinite(Number(coords.accuracy)) ? Number(coords.accuracy) : 0,
      speed: Number.isFinite(speedMps) ? speedMps * 3.6 : 0,
      heading: Number.isFinite(Number(coords.heading)) ? Number(coords.heading) : 0,
      ts: Date.now()
    };
  }

  function localDateTimeValue(date = new Date()) {
    const offsetMs = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
  }

  function updateMeasurementClock() {
    if (measurementTimestampInput) {
      measurementTimestampInput.value = localDateTimeValue();
    }
  }

  function compactMeasurementTime(value) {
    if (!value) return "";
    const text = String(value);
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/);
    if (match) return `${match[3]}.${match[2]} ${match[4]}`;
    return text;
  }

  function csvValue(value) {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function measurementPosition() {
    if (!measurementLatInput || !measurementLonInput) return null;
    const lat = Number(measurementLatInput.value);
    const lon = Number(measurementLonInput.value);
    return validLatLon(lat, lon) ? { lat, lon } : null;
  }

  function updateMeasurementMarker(zoom = false) {
    const pos = measurementPosition();
    if (!pos) return;
    const measurement = measurementSummary(state.lastMeasurement);
    const measurementHtml = measurement
      ? `<div class="marker-measurement">${escapeHtml(measurement)}</div>`
      : "";

    if (!state.measurementMarker) {
      state.measurementMarker = L.marker([pos.lat, pos.lon], {
        zIndexOffset: 3600,
        title: "Målepunkt"
      }).addTo(markerLayer);
    }

    state.measurementMarker.setLatLng([pos.lat, pos.lon]);
    state.measurementMarker.setIcon(L.divIcon({
      className: "fieldpos-measurement-marker",
      html: `<div class="marker-dot measurement"><div class="marker-label measurement-point"><div class="marker-name">Målepunkt A</div>${measurementHtml}</div></div>`,
      iconSize: [180, measurement ? 88 : 58],
      iconAnchor: [9, 9]
    }));
    state.measurementMarker.off("click");
    state.measurementMarker.on("click", () => showMeasurementDetails("Målepunkt A", state.lastMeasurement));

    if (zoom) map.setView([pos.lat, pos.lon], 16);
  }

  function fillMeasurementPosition(pos) {
    if (!measurementLatInput || !measurementLonInput || !pos || state.currentView !== "measure-a") return;
    measurementLatInput.value = Number(pos.lat).toFixed(8);
    measurementLonInput.value = Number(pos.lon).toFixed(8);
    updateMeasurementMarker(false);
  }

  function collectMeasurementRow() {
    if (!measurementForm) return "";

    const data = new FormData(measurementForm);
    const lat = String(data.get("latitude") || "");
    const lon = String(data.get("longitude") || "");
    const metadata = {
      comment: data.get("comment") || null,
      rainfall: data.get("rainfall") === "on",
      snow_depth: data.get("snow_depth") || null,
      measurement_id: `local-${Date.now()}`,
      instrument_number: data.get("instrument_number") || null,
      measuring_point_id: data.get("measuring_point_id") || null,
      measuring_point_name: data.get("measuring_point_name") || null
    };

    const row = [
      lon && lat ? `SRID=4326;POINT(${lon} ${lat})` : "",
      data.get("doserate") || "",
      data.get("timestamp") || "",
      data.get("measurement_height") || "",
      JSON.stringify(metadata),
      data.get("session") || "",
      data.get("team") || "",
      data.get("event") || "",
      data.get("measurement_type") || "",
      lon,
      lat
    ];

    return row.map(csvValue).join(",");
  }

  function collectMeasurementPayload(csvRow, pos = null) {
    if (!measurementForm) return null;
    const data = new FormData(measurementForm);
    return {
      measurementId: `local-${Date.now()}`,
      module: "A",
      stationName: String(data.get("station_name") || ""),
      doserate: String(data.get("doserate") || ""),
      timestamp: String(data.get("timestamp") || ""),
      measurementHeight: String(data.get("measurement_height") || ""),
      measurementType: String(data.get("measurement_type") || ""),
      longitude: String(data.get("longitude") || pos?.lon || ""),
      latitude: String(data.get("latitude") || pos?.lat || ""),
      measuringPointId: String(data.get("measuring_point_id") || ""),
      measuringPointName: String(data.get("measuring_point_name") || ""),
      session: String(data.get("session") || ""),
      team: String(data.get("team") || ""),
      event: String(data.get("event") || ""),
      instrumentNumber: String(data.get("instrument_number") || ""),
      snowDepth: String(data.get("snow_depth") || ""),
      rainfall: data.get("rainfall") === "on",
      comment: String(data.get("comment") || ""),
      csvRow
    };
  }

  function measurementSummary(measurement) {
    if (!measurement || typeof measurement !== "object") return "";
    if (!measurement.doserate) return "ingen data";

    const parts = [];
    parts.push(`${measurement.doserate} Sv/h`);
    if (measurement.measurementType) parts.push(measurement.measurementType);
    if (measurement.measuringPointId) parts.push(`#${measurement.measuringPointId}`);
    if (measurement.timestamp) parts.push(compactMeasurementTime(measurement.timestamp));
    if (measurement.session) parts.push(measurement.session);

    return `A: ${parts.join(" ")}`;
  }

  function measurementFocusLabel(measurement) {
    if (!measurement || typeof measurement !== "object") return "ingen data";

    const dose = measurement.doserate ? `${measurement.doserate} Sv/h` : "ingen data";
    const time = compactMeasurementTime(measurement.timestamp || measurement.receivedAt);
    const pointName = measurement.measuringPointName || measurement.measuringPointId || "ukjent punkt";
    const type = measurement.measurementType || "ukjent type";
    const moduleName = `Type ${measurement.module || "A"}`;

    return [moduleName, dose, time, pointName, type].filter(Boolean).join(" · ");
  }

  function buildPresenceUrl(online, measurement = null) {
    const params = new URLSearchParams();
    const manualPos = measurement ? measurementPosition() : null;
    const pos = state.position || manualPos || (state.lastMeasurement ? state.lastMeasurementPosition : null);

    params.set("clientId", state.clientId);
    params.set("presence", online && pos ? "1" : "0");
    params.set("name", ownName());

    if (online && pos) {
      params.set("lat", String(pos.lat));
      params.set("lon", String(pos.lon));
      params.set("speed", String(pos.speed || 0));
      params.set("heading", String(pos.heading || 0));
      params.set("accuracy", String(pos.accuracy || 0));
      params.set("ts", String(pos.ts || Date.now()));
    } else {
      params.set("lat", String(OFFLINE_COORD));
      params.set("lon", String(OFFLINE_COORD));
      params.set("speed", "0");
      params.set("heading", "0");
      params.set("accuracy", "0");
      params.set("ts", String(Date.now()));
    }

    if (measurement) {
      params.set("measurement", "1");
      params.set("measurementId", measurement.measurementId || "");
      params.set("measurementModule", measurement.module || "A");
      params.set("stationName", measurement.stationName || "");
      params.set("doserate", measurement.doserate || "");
      params.set("measurementTimestamp", measurement.timestamp || "");
      params.set("measurementHeight", measurement.measurementHeight || "");
      params.set("measurementType", measurement.measurementType || "");
      params.set("measurementLon", measurement.longitude || "");
      params.set("measurementLat", measurement.latitude || "");
      params.set("measuringPointId", measurement.measuringPointId || "");
      params.set("measuringPointName", measurement.measuringPointName || "");
      params.set("measurementSession", measurement.session || "");
      params.set("measurementTeam", measurement.team || "");
      params.set("measurementEvent", measurement.event || "");
      params.set("instrumentNumber", measurement.instrumentNumber || "");
      params.set("snowDepth", measurement.snowDepth || "");
      params.set("rainfall", measurement.rainfall ? "1" : "0");
      params.set("measurementComment", measurement.comment || "");
      params.set("csvRow", measurement.csvRow || "");
    }

    return `${PRESENCE_ENDPOINT}?${params.toString()}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function measurementPopupHtml(title, measurement) {
    const rows = [
      ["Modul", measurement?.module || "A"],
      ["Stasjon", measurement?.stationName || ""],
      ["Doserate", measurement?.doserate ? `${measurement.doserate} Sv/h` : "ingen data"],
      ["Tidspunkt", measurement?.timestamp || ""],
      ["Sesjon", measurement?.session || ""],
      ["Måletype", measurement?.measurementType || ""],
      ["Målehøyde", measurement?.measurementHeight || ""],
      ["Lengdegrad", measurement?.longitude || ""],
      ["Breddegrad", measurement?.latitude || ""],
      ["Målepunkt-ID", measurement?.measuringPointId || ""],
      ["Målepunktnavn", measurement?.measuringPointName || ""],
      ["Lag", measurement?.team || ""],
      ["Hendelse", measurement?.event || ""],
      ["Instrumentnr.", measurement?.instrumentNumber || ""],
      ["Snødybde", measurement?.snowDepth || ""],
      ["Nedbør", measurement?.rainfall ? "ja" : "nei"],
      ["Kommentar", measurement?.comment || ""],
      ["Mottatt", measurement?.receivedAt ? new Date(Number(measurement.receivedAt)).toLocaleString("no-NO") : ""],
      ["CSV-rad", measurement?.csvRow || ""]
    ];

    const details = rows
      .map(([label, value]) => `
        <div class="measurement-popup-row">
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value || "ikke utfylt")}</dd>
        </div>
      `)
      .join("");

    return `
      <div class="measurement-popup">
        <strong>${escapeHtml(title)}</strong>
        <dl>${details}</dl>
      </div>
    `;
  }

  function closeMeasurementDetails() {
    const sheet = document.getElementById("measurement-detail-sheet");
    if (sheet) sheet.remove();
  }

  function showMeasurementDetails(title, measurement) {
    closeMeasurementDetails();

    const sheet = document.createElement("div");
    sheet.id = "measurement-detail-sheet";
    sheet.className = "measurement-detail-sheet";
    sheet.innerHTML = `
      <div class="measurement-detail-backdrop" data-close-measurement></div>
      <section class="measurement-detail-panel" role="dialog" aria-modal="true" aria-label="Måledetaljer">
        <div class="measurement-detail-header">
          <strong>${escapeHtml(title)}</strong>
          <button type="button" class="measurement-detail-close" data-close-measurement aria-label="Lukk">×</button>
        </div>
        ${measurementPopupHtml(title, measurement)}
      </section>
    `;

    sheet.addEventListener("click", (ev) => {
      const target = ev.target;
      if (target instanceof HTMLElement && target.hasAttribute("data-close-measurement")) {
        closeMeasurementDetails();
      }
    });

    document.body.appendChild(sheet);
  }

  function visualPositionKey(lat, lon) {
    const point = map.latLngToLayerPoint([lat, lon]);
    const bucketSize = 34;
    return `${Math.round(point.x / bucketSize)},${Math.round(point.y / bucketSize)}`;
  }

  function clientKey(client) {
    return client.clientHash || client.clientId || "";
  }

  function clientLabel(client) {
    return client.displayName || client.name || client.shortName || "Ukjent";
  }

  function zoomToClients(clients) {
    const points = clients
      .map((client) => [Number(client.lat), Number(client.lon)])
      .filter(([lat, lon]) => validLatLon(lat, lon));

    zoomToPoints(points);
  }

  function zoomToPoints(points) {
    if (!points.length) return;

    if (points.length === 1) {
      map.setView(points[0], 16);
      return;
    }

    map.fitBounds(L.latLngBounds(points), {
      maxZoom: 16,
      padding: [42, 42]
    });
  }

  function removeZoomBoxLayer() {
    if (!state.zoomBoxLayer) return;
    map.removeLayer(state.zoomBoxLayer);
    state.zoomBoxLayer = null;
  }

  function setZoomBoxMode(active) {
    state.zoomBoxActive = Boolean(active);
    state.zoomBoxStart = null;
    state.zoomBoxPointerId = null;
    removeZoomBoxLayer();
    zoomBoxButton?.classList.toggle("active", state.zoomBoxActive);
    if (zoomBoxButton) zoomBoxButton.textContent = state.zoomBoxActive ? "Dra område" : "Velg område";
    document.body.classList.toggle("zoom-box-active", state.zoomBoxActive);

    if (state.zoomBoxActive) {
      map.dragging.disable();
      return;
    }

    map.dragging.enable();
  }

  function pointerLatLng(ev) {
    return map.mouseEventToLatLng(ev);
  }

  function startZoomBoxDrag(ev) {
    if (!state.zoomBoxActive) return;
    if (ev.button !== undefined && ev.button !== 0) return;

    state.zoomBoxPointerId = ev.pointerId ?? "mouse";
    state.zoomBoxStart = pointerLatLng(ev);
    updateZoomBox(state.zoomBoxStart);

    try {
      map.getContainer().setPointerCapture?.(state.zoomBoxPointerId);
    } catch (err) {}

    ev.preventDefault();
    ev.stopPropagation();
  }

  function moveZoomBoxDrag(ev) {
    if (!state.zoomBoxActive || !state.zoomBoxStart) return;
    if (state.zoomBoxPointerId !== null && ev.pointerId !== undefined && ev.pointerId !== state.zoomBoxPointerId) return;
    updateZoomBox(pointerLatLng(ev));
    ev.preventDefault();
  }

  function endZoomBoxDrag(ev) {
    if (!state.zoomBoxActive || !state.zoomBoxStart) return;
    if (state.zoomBoxPointerId !== null && ev.pointerId !== undefined && ev.pointerId !== state.zoomBoxPointerId) return;

    const endLatLng = pointerLatLng(ev);
    state.zoomBoxSuppressClick = true;
    finishZoomBox(endLatLng);

    window.setTimeout(() => {
      state.zoomBoxSuppressClick = false;
    }, 250);

    ev.preventDefault();
    ev.stopPropagation();
  }

  function cancelZoomBoxDrag(ev) {
    if (!state.zoomBoxActive) return;
    setZoomBoxMode(false);
    ev?.preventDefault?.();
  }

  function updateZoomBox(endLatLng) {
    if (!state.zoomBoxStart || !endLatLng) return;
    const bounds = L.latLngBounds(state.zoomBoxStart, endLatLng);
    if (!state.zoomBoxLayer) {
      state.zoomBoxLayer = L.rectangle(bounds, {
        color: "#f04438",
        weight: 2,
        fillColor: "#f04438",
        fillOpacity: 0.08,
        dashArray: "6 4",
        interactive: false
      }).addTo(map);
      return;
    }
    state.zoomBoxLayer.setBounds(bounds);
  }

  function finishZoomBox(endLatLng) {
    if (!state.zoomBoxActive || !state.zoomBoxStart || !endLatLng) {
      setZoomBoxMode(false);
      return;
    }

    const startPoint = map.latLngToContainerPoint(state.zoomBoxStart);
    const endPoint = map.latLngToContainerPoint(endLatLng);
    const dragDistance = startPoint.distanceTo(endPoint);
    const bounds = L.latLngBounds(state.zoomBoxStart, endLatLng);

    setZoomBoxMode(false);
    if (dragDistance < 12 || !bounds.isValid()) return;

    map.fitBounds(bounds, {
      maxZoom: 16,
      padding: [24, 24]
    });
  }

  function zoomToVisibleUsersAndMeasurements() {
    const points = [];

    for (const marker of state.markers.values()) {
      const pos = marker.getLatLng();
      if (validLatLon(pos.lat, pos.lng)) points.push([pos.lat, pos.lng]);
    }

    for (const marker of state.measurementMarkers.values()) {
      const pos = marker.getLatLng();
      if (validLatLon(pos.lat, pos.lng)) points.push([pos.lat, pos.lng]);
    }

    if (state.measurementMarker) {
      const pos = state.measurementMarker.getLatLng();
      if (validLatLon(pos.lat, pos.lng)) points.push([pos.lat, pos.lng]);
    }

    zoomToPoints(points);
  }

  function zoomToClient(key) {
    const client = state.clients.find((item) => clientKey(item) === key);
    if (!client) return;
    zoomToClients([client]);
  }

  function zoomToMeasurement(key) {
    const marker = state.measurementMarkers.get(key);
    if (!marker) return;

    const pos = marker.getLatLng();
    if (!validLatLon(pos.lat, pos.lng)) return;
    map.setView([pos.lat, pos.lng], 16);
    marker.fire("click");
  }

  function updateClientFocusOptions(clients) {
    if (!clientFocusSelect) return;

    const selected = clientFocusSelect.value;
    clientFocusSelect.textContent = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = clients.length ? "Aktive noder" : "Ingen noder";
    clientFocusSelect.appendChild(placeholder);

    for (const client of clients) {
      const key = clientKey(client);
      if (!key) continue;

      const option = document.createElement("option");
      option.value = key;
      option.textContent = clientLabel(client);
      clientFocusSelect.appendChild(option);
    }

    clientFocusSelect.disabled = clients.length === 0;
    if (clients.some((client) => clientKey(client) === selected)) {
      clientFocusSelect.value = selected;
    }
  }

  function updateMeasurementFocusOptions(items) {
    if (!measurementFocusSelect) return;

    const selected = measurementFocusSelect.value;
    measurementFocusSelect.textContent = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = items.length ? "Målinger zoom" : "Ingen målinger";
    measurementFocusSelect.appendChild(placeholder);

    for (const item of items) {
      const option = document.createElement("option");
      option.value = item.key;
      option.textContent = item.label;
      measurementFocusSelect.appendChild(option);
    }

    measurementFocusSelect.disabled = items.length === 0;
    if (items.some((item) => item.key === selected)) {
      measurementFocusSelect.value = selected;
    }
  }

  function measurementListForClient(client) {
    if (Array.isArray(client.measurements) && client.measurements.length) {
      return client.measurements;
    }
    return client.lastMeasurement ? [client.lastMeasurement] : [];
  }

  function mergeMeasurements(existing, extra) {
    const merged = [];
    const seen = new Set();
    [...existing, ...extra].forEach((measurement, index) => {
      if (!measurement || typeof measurement !== "object") return;
      const key = measurement.measurementId || measurement.receivedAt || measurement.timestamp || index;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(measurement);
    });
    return merged;
  }

  function mergeOwnMeasurements(client) {
    if (!state.sentMeasurements.length) return client;
    const existing = measurementListForClient(client);
    const measurements = mergeMeasurements(existing, state.sentMeasurements);
    return {
      ...client,
      measurements,
      lastMeasurement: measurements[measurements.length - 1] || client.lastMeasurement
    };
  }

  function measurementKey(client, measurement, index) {
    const id = measurement?.measurementId || measurement?.receivedAt || measurement?.timestamp || index;
    return `measurement:${clientKey(client)}:${id}`;
  }

  function measurementTitle(client, measurement) {
    const station = measurement?.stationName || clientLabel(client);
    const pointId = measurement?.measuringPointId ? ` #${measurement.measuringPointId}` : "";
    return `Måling A${pointId} · ${station}`;
  }

  function renderMeasurementMarkers(clients) {
    const seen = new Set();
    const grouped = new Map();
    const focusItems = [];

    for (const client of clients) {
      measurementListForClient(client).forEach((measurement, index) => {
        const lat = Number(measurement.latitude || client.lat);
        const lon = Number(measurement.longitude || client.lon);
        if (!validLatLon(lat, lon)) return;

        const key = measurementKey(client, measurement, index);
        const positionKey = visualPositionKey(lat, lon);
        const stackIndex = grouped.get(positionKey) || 0;
        grouped.set(positionKey, stackIndex + 1);
        seen.add(key);

        let marker = state.measurementMarkers.get(key);
        if (!marker) {
          marker = L.marker([lat, lon], {
            zIndexOffset: 7000,
            riseOnHover: true,
            title: "Måling"
          }).addTo(markerLayer);
          state.measurementMarkers.set(key, marker);
        }

        const title = measurementTitle(client, measurement);
        focusItems.push({ key, label: measurementFocusLabel(measurement) });
        marker.setLatLng([lat, lon]);
        marker.setIcon(measurementMarkerIcon(title, measurement, stackIndex));
        marker.off("click");
        marker.on("click", () => showMeasurementDetails(title, measurement));
      });
    }

    for (const [key, marker] of state.measurementMarkers.entries()) {
      if (!seen.has(key)) {
        markerLayer.removeLayer(marker);
        state.measurementMarkers.delete(key);
      }
    }

    updateMeasurementFocusOptions(focusItems);
  }

  function markerIcon(client, isOwn, stackIndex = 0) {
    const label = escapeHtml(clientLabel(client));
    const labelOffset = 8 + stackIndex * 30;
    const iconHeight = 58 + stackIndex * 32;
    return L.divIcon({
      className: isOwn ? "fieldpos-own-marker" : "fieldpos-marker",
      html: `<div class="marker-dot ${isOwn ? "own" : "presence"}"><div class="marker-label presence-label" style="--label-offset: ${labelOffset}px"><div class="marker-name">${label}</div></div></div>`,
      iconSize: [180, iconHeight],
      iconAnchor: [9, 9]
    });
  }

  function measurementMarkerIcon(title, measurement, stackIndex = 0) {
    const label = escapeHtml(title || "Måling A");
    const measurementText = measurementSummary(measurement) || "ingen data";
    const labelOffset = 28 + stackIndex * 42;
    const iconHeight = 88 + stackIndex * 42;

    return L.divIcon({
      className: "fieldpos-measurement-marker",
      html: `<div class="marker-dot measurement"><img class="measurement-symbol" src="images/radiaktivitet01.png" alt="" aria-hidden="true" /><div class="marker-label measurement-point" style="--label-offset: ${labelOffset}px"><div class="marker-name">${label}</div><div class="marker-measurement">${escapeHtml(measurementText)}</div></div></div>`,
      iconSize: [210, iconHeight],
      iconAnchor: [-18, 9]
    });
  }
  async function sendMeasurement() {
    if (!measurementForm) return;
    const stationName = stationNameInput ? stationNameInput.value.trim() : ownName();
    if (!stationName) {
      if (measurementOutput) measurementOutput.value = "Stasjonsnavn må fylles inn.";
      stationNameInput?.focus();
      return;
    }
    setOwnName(stationName);

    const pos = measurementPosition();
    if (!pos) {
      if (measurementOutput) measurementOutput.value = "Mangler gyldig breddegrad/lengdegrad.";
      return;
    }

    updateMeasurementClock();

    const csvRow = collectMeasurementRow();
    const measurement = collectMeasurementPayload(csvRow, pos);
    state.lastMeasurement = measurement;
    state.sentMeasurements = mergeMeasurements(state.sentMeasurements, [measurement]);
    state.lastMeasurementPosition = pos;

    try {
      const res = await fetch(buildPresenceUrl(true, measurement), {
        method: "GET",
        cache: "no-store",
        headers: { "Accept": "application/json" }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      state.clientHash = payload.clientHash || state.clientHash;
      renderClients(Array.isArray(payload.activeClients) ? payload.activeClients : []);
      if (state.measurementMarker) {
        markerLayer.removeLayer(state.measurementMarker);
        state.measurementMarker = null;
      }
      if (measurementOutput) measurementOutput.value = csvRow;
    } catch (err) {
      console.warn("[fieldpos] måling feilet", err);
      if (measurementOutput) measurementOutput.value = `Sending feilet: ${err.message}`;
    }
  }

  function renderClients(clients) {
    const seen = new Set();
    const grouped = new Map();
    const renderableClients = [];
    state.clients = [];
    const measurementClients = [];

    for (const rawClient of clients) {
      const isOwnClient = Boolean(
        (state.clientHash && rawClient.clientHash === state.clientHash) ||
        rawClient.clientId === state.clientId
      );
      const client = isOwnClient ? mergeOwnMeasurements(rawClient) : rawClient;
      if (measurementListForClient(client).length) {
        measurementClients.push(client);
      }

      const lat = Number(client.lat);
      const lon = Number(client.lon);
      if (intValue(client.presence) !== 1) continue;
      if (!validLatLon(lat, lon)) continue;

      const key = clientKey(client);
      if (!key) continue;

      const positionKey = visualPositionKey(lat, lon);
      const stackIndex = grouped.get(positionKey) || 0;
      grouped.set(positionKey, stackIndex + 1);

      renderableClients.push({ client, key, lat, lon, stackIndex });
      state.clients.push(client);
    }

    updateClientFocusOptions(state.clients);
    renderMeasurementMarkers(measurementClients);

    for (const item of renderableClients) {
      const { client, key, lat, lon, stackIndex } = item;
      seen.add(key);

      const isOwn = Boolean(
        (state.clientHash && client.clientHash === state.clientHash) ||
        client.clientId === state.clientId
      );

      let marker = state.markers.get(key);
      if (!marker) {
        marker = L.marker([lat, lon], { zIndexOffset: isOwn ? 3000 : 2500 }).addTo(markerLayer);
        state.markers.set(key, marker);
      }

      marker.setLatLng([lat, lon]);
      marker.setIcon(markerIcon(client, isOwn, stackIndex));
      marker.off("click");
      marker.on("click", () => showMeasurementDetails(clientLabel(client), null));
    }

    for (const [key, marker] of state.markers.entries()) {
      if (!seen.has(key)) {
        markerLayer.removeLayer(marker);
        state.markers.delete(key);
      }
    }

    kartInfo?.update({
      activePoints: state.markers.size,
      shownMeasurements: state.measurementMarkers.size
    });
  }

  async function updatePresence(forceOffline = false) {
    if (state.inFlight) return;
    state.inFlight = true;

    try {
      const online = !forceOffline && (
        (state.enabled && state.position) ||
        (state.lastMeasurement && state.lastMeasurementPosition)
      );
      const res = await fetch(buildPresenceUrl(online), {
        method: "GET",
        cache: "no-store",
        headers: { "Accept": "application/json" }
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      state.clientHash = payload.clientHash || state.clientHash;
      const clients = Array.isArray(payload.activeClients) ? payload.activeClients : [];
      renderClients(clients.map((client) => {
        const isOwnClient = Boolean(
          (state.clientHash && client.clientHash === state.clientHash) ||
          client.clientId === state.clientId
        );
        return isOwnClient && state.lastMeasurement
          ? { ...client, lastMeasurement: state.lastMeasurement }
          : client;
      }));

      if (state.enabled && state.position) {
        setStatus(`På · ${Math.round(state.position.accuracy || 0)} m`, "active");
      }
    } catch (err) {
      console.warn("[fieldpos] presence feilet", err);
      setStatus("Feil", "error");
    } finally {
      state.inFlight = false;
    }
  }

  function onPosition(position) {
    const next = positionFromGeolocation(position);
    if (!next) return;

    state.position = next;
    fillMeasurementPosition(next);

    if (state.firstFix) {
      map.setView([next.lat, next.lon], 15);
      state.firstFix = false;
    }

    updatePresence();
  }

  function onPositionError(err) {
    console.warn("[fieldpos] GPS feilet", err);
    setStatus("GPS-feil", "error");
  }

  function startGps() {
    if (state.enabled) return;
    if (!navigator.geolocation) {
      setStatus("GPS mangler", "error");
      return;
    }

    askNameIfNeeded();
    state.enabled = true;
    state.firstFix = true;
    setStatus("Venter", "waiting");

    state.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      timeout: 30000,
      maximumAge: 15000
    });

    updatePresence();
  }

  function stopGps() {
    state.enabled = false;

    if (state.watchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(state.watchId);
    }

    state.watchId = null;
    state.position = null;
    setStatus("Av", null);
    updatePresence(true);
  }

  async function clearMeasurements() {
    if (!window.confirm("Nullstille testdata? Alle posisjoner og målinger slettes.")) return;

    try {
      const res = await fetch("/api/measurements/clear", {
        method: "GET",
        cache: "no-store",
        headers: { "Accept": "application/json" }
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const payload = await res.json();

      state.lastMeasurement = null;
      state.sentMeasurements = [];
      state.lastMeasurementPosition = null;
      state.clients = [];

      for (const marker of state.markers.values()) {
        markerLayer.removeLayer(marker);
      }
      state.markers.clear();

      for (const marker of state.measurementMarkers.values()) {
        markerLayer.removeLayer(marker);
      }
      state.measurementMarkers.clear();
      updateMeasurementFocusOptions([]);

      if (state.measurementMarker) {
        markerLayer.removeLayer(state.measurementMarker);
        state.measurementMarker = null;
      }

      renderClients(Array.isArray(payload.activeClients) ? payload.activeClients : []);

      if (measurementOutput) {
        measurementOutput.value = `Nullstilt: ${payload.removedClients ?? 0} posisjoner, ${payload.removedMeasurements ?? 0} målinger.`;
      }
    } catch (err) {
      console.warn("[fieldpos] sletting av målinger feilet", err);
      window.alert(`Klarte ikke å slette målinger: ${err.message}`);
    }
  }

  gpsButton.addEventListener("click", () => {
    if (state.enabled) stopGps();
    else startGps();
  });

  gpsButton.addEventListener("dblclick", (ev) => {
    ev.preventDefault();
    const current = ownName() === "Min pos" ? "" : ownName();
    const next = (window.prompt("Navn som vises på kartet:", current) || "").trim().slice(0, 24);
    setOwnName(next);
    updatePresence();
  });

  if (zoomAllButton) {
    zoomAllButton.addEventListener("click", () => {
      setZoomBoxMode(false);
      zoomToVisibleUsersAndMeasurements();
    });
  }

  if (zoomNorwayButton) {
    zoomNorwayButton.addEventListener("click", () => {
      setZoomBoxMode(false);
      focusNorway();
    });
  }

  if (zoomBoxButton) {
    zoomBoxButton.addEventListener("click", () => {
      if (!state.zoomBoxActive) setMetWindMapPickMode(false);
      setZoomBoxMode(!state.zoomBoxActive);
    });
  }

  if (clientFocusSelect) {
    clientFocusSelect.addEventListener("change", () => {
      if (clientFocusSelect.value) zoomToClient(clientFocusSelect.value);
    });
  }

  if (measurementFocusSelect) {
    measurementFocusSelect.addEventListener("change", () => {
      if (measurementFocusSelect.value) zoomToMeasurement(measurementFocusSelect.value);
    });
  }

  if (clearMeasurementsButton) {
    clearMeasurementsButton.addEventListener("click", clearMeasurements);
  }

  viewButtons.forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.viewTarget || "map"));
  });

  if (measurementForm) {
    if (stationNameInput) {
      stationNameInput.value = ownName() === "Min pos" ? "" : ownName();
      stationNameInput.addEventListener("input", () => {
        setOwnName(stationNameInput.value);
        updatePresence();
      });
    }

    updateMeasurementClock();
    window.setInterval(updateMeasurementClock, 1000);

    [measurementLatInput, measurementLonInput].forEach((input) => {
      if (!input) return;
      input.addEventListener("input", () => updateMeasurementMarker(false));
    });

    if (measurementNowButton) {
      measurementNowButton.addEventListener("click", () => {
        updateMeasurementClock();
      });
    }

    if (measurementZoomButton) {
      measurementZoomButton.addEventListener("click", () => updateMeasurementMarker(true));
    }

    measurementForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      sendMeasurement();
    });
  }

  window.addEventListener("beforeunload", () => {
    try {
      fetch(buildPresenceUrl(false), {
        method: "GET",
        cache: "no-store",
        keepalive: true
      });
    } catch (err) {}
  });

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeMeasurementDetails();
  });

  setupBaseMapButtons();
  setupLayoutSettingsPanel();
  setView("map");
  setBaseMap(storedBaseMapKey());
  kartInfo?.start();
  kartInfo?.update({
    activePoints: 0,
    shownMeasurements: 0,
    emailIntervalActive: false
  });
  kommunerDemografi?.start();
  radnettStations?.start();
  ambientGamma?.start();
  metWind?.start();
  metWindArea?.start();
  placeNames?.start();
  applyReloadFocus();
  checkForAppUpgrade();
  window.setInterval(checkForAppUpgrade, VERSION_CHECK_INTERVAL_MS);
  state.intervalId = window.setInterval(() => updatePresence(), FETCH_INTERVAL_MS);
  updatePresence();
})();
