/* FieldPos MET wind overlay */
"use strict";

(function () {
  const STORAGE_KEY = "fieldposMetWind";
  const DATA_URL = "data/online2/met_wind_nearby.geojson";
  const FILE_REFRESH_MS = 30 * 1000;
  const WIND_SPEED_SCALE = [
    { max: 0.2, label: "Stille", range: "0-0.2", color: "#d8f3ff" },
    { max: 1.5, label: "Flau vind", range: "0.3-1.5", color: "#8fd3ff" },
    { max: 3.3, label: "Svak vind", range: "1.6-3.3", color: "#36b9ff" },
    { max: 5.4, label: "Lett bris", range: "3.4-5.4", color: "#39d88a" },
    { max: 7.9, label: "Laber bris", range: "5.5-7.9", color: "#b8e03f" },
    { max: 10.7, label: "Frisk bris", range: "8.0-10.7", color: "#ffe14a" },
    { max: 13.8, label: "Liten kuling", range: "10.8-13.8", color: "#ff9d2e" },
    { max: 17.1, label: "Stiv kuling", range: "13.9-17.1", color: "#ff5b2e" },
    { max: 20.7, label: "Sterk kuling", range: "17.2-20.7", color: "#e51f2f" },
    { max: 24.4, label: "Liten storm", range: "20.8-24.4", color: "#b00070" },
    { max: Infinity, label: "Storm+", range: ">= 24.5", color: "#5b168f" }
  ];
  let sharedScaleControl = null;
  let sharedScaleContainer = null;
  let sharedScaleUsers = 0;
  const WIND_ARROW_SIZE = 24;

  function storedEnabled() {
    try {
      const value = window.localStorage.getItem(STORAGE_KEY);
      return value === null ? false : value === "1";
    } catch (err) {
      return false;
    }
  }

  function numberText(value, digits = 1) {
    const num = Number(value);
    return Number.isFinite(num) ? num.toFixed(digits) : "ukjent";
  }

  function windSpeedClass(speedMS) {
    const value = Number(speedMS || 0);
    return WIND_SPEED_SCALE.find((item) => value <= item.max) || WIND_SPEED_SCALE[WIND_SPEED_SCALE.length - 1];
  }

  function normalizeDirection(deg) {
    const num = Number(deg);
    if (!Number.isFinite(num)) return 0;
    return ((num % 360) + 360) % 360;
  }

  function sharedScaleHtml(escapeHtml) {
    return `
      <strong>Vindstyrke</strong>
      <div class="met-wind-scale">
        ${WIND_SPEED_SCALE.map((item) => `
          <div class="met-wind-scale-row">
            <span style="background:${item.color}"></span>
            <em>${escapeHtml(item.range)} m/s · ${escapeHtml(item.label)}</em>
          </div>
        `).join("")}
      </div>
    `;
  }

  function create(options) {
    const map = options.map;
    const L = options.L || window.L;
    const escapeHtml = options.escapeHtml;
    const toggle = options.toggle || null;
    const dockToggle = options.dockToggle || null;
    const dockClick = options.dockClick !== false;
    const storageKey = options.storageKey || STORAGE_KEY;
    const dataUrl = options.dataUrl || DATA_URL;
    const statusEvent = options.statusEvent === undefined ? "fieldpos:met-wind-status" : options.statusEvent;
    const persistEnabled = options.persistEnabled !== false;
    const labelBase = options.label || "Vind";
    const showScale = options.showScale !== false;
    const state = {
      enabled: true,
      loaded: false,
      loading: false,
      error: "",
      updatedAt: "",
      forecastTime: "",
      refreshMinutes: "",
      gridStepKm: "",
      nearbyRadiusKm: "",
      featureCount: 0,
      cachedPointCount: "",
      fetchedPointCount: "",
      referencePointCount: "",
      windReferencePointCount: "",
      windReferenceMergeCount: "",
      gridLimited: false,
      gridMode: "",
      windArea: "",
      status: "",
      layer: null,
      legend: null,
      legendContainer: null,
      timer: null,
      legendTimer: null,
      sharedScaleActive: false
    };

    function formatDateTime(value) {
      if (!value) return "ukjent";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString("no-NO", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    }

    function nextRefreshText() {
      const refresh = Number(state.refreshMinutes);
      if (!Number.isFinite(refresh) || refresh <= 0 || !state.updatedAt) return "ukjent";
      const updated = new Date(state.updatedAt).getTime();
      if (Number.isNaN(updated)) return "ukjent";
      const next = updated + refresh * 60 * 1000;
      const remainingMs = next - Date.now();
      if (remainingMs <= 0) return "forfalt";
      const totalSeconds = Math.ceil(remainingMs / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return `${minutes}:${String(seconds).padStart(2, "0")}`;
    }

    function legendHtml() {
      const grid = Number(state.gridStepKm);
      const gridText = Number.isFinite(grid) && grid > 0
        ? `${Number.isInteger(grid) ? grid : grid.toFixed(1)} km`
        : "ukjent";
      const radius = Number(state.nearbyRadiusKm);
      const radiusText = Number.isFinite(radius) && radius > 0
        ? `${Number.isInteger(radius) ? radius : radius.toFixed(1)} km`
        : "ukjent";
      const status = state.loading
        ? "Vindfil lastes i nettleser ..."
        : state.error
          ? `Feil: ${escapeHtml(state.error)}`
          : state.status === "backend-loading"
            ? "Backend henter nye MET-data"
            : state.loaded
            ? `Ferdig lastet (${state.featureCount} piler)`
            : "Vinddata ikke lastet";
      const cacheText = state.cachedPointCount !== "" || state.fetchedPointCount !== ""
        ? `Cache: ${Number(state.cachedPointCount || 0)} brukt / ${Number(state.fetchedPointCount || 0)} hentet`
        : "Cache: venter på ny vindfil";
      const backendText = state.referencePointCount !== ""
        ? `Backend: ${Number(state.referencePointCount || 0)} ref / ${Number(state.windReferencePointCount || 0)} vindpunkt`
        : "Backend: venter på ny vindfil";
      const mergedText = Number(state.windReferenceMergeCount || 0) > 0
        ? `, ${Number(state.windReferenceMergeCount)} slått sammen`
        : "";
      const limitText = state.gridLimited ? ", grid begrenset" : "";
      const loadingClass = state.loading || state.status === "backend-loading"
        ? " met-wind-loading-status"
        : "";

      return `
        <strong>${escapeHtml(labelBase)}</strong>
        <div class="kommune-demografi-legend-row kommune-demografi-legend-text">
          <em>Pilavstand: ${escapeHtml(gridText)}</em>
        </div>
        <div class="kommune-demografi-legend-row kommune-demografi-legend-text">
          <em>Radius pr punkt: ${escapeHtml(radiusText)}</em>
        </div>
        <div class="kommune-demografi-legend-row kommune-demografi-legend-text">
          <em>Sist hentet: ${escapeHtml(formatDateTime(state.updatedAt))}</em>
        </div>
        <div class="kommune-demografi-legend-row kommune-demografi-legend-text">
          <em>MET tid: ${escapeHtml(formatDateTime(state.forecastTime))}</em>
        </div>
        <div class="kommune-demografi-legend-row kommune-demografi-legend-text">
          <em>Neste MET-sjekk: ${escapeHtml(nextRefreshText())}</em>
        </div>
        <div class="kommune-demografi-legend-row kommune-demografi-legend-text">
          <em>${escapeHtml(cacheText)}</em>
        </div>
        <div class="kommune-demografi-legend-row kommune-demografi-legend-text">
          <em>${escapeHtml(`${backendText}${mergedText}${limitText}`)}</em>
        </div>
        <div class="kommune-demografi-legend-row kommune-demografi-legend-text${loadingClass}">
          <em>${status}</em>
        </div>
      `;
    }

    function showSharedScale() {
      if (!showScale || state.sharedScaleActive) return;
      if (!sharedScaleControl) {
        sharedScaleControl = L.control({ position: "bottomright" });
        sharedScaleControl.onAdd = () => {
          const container = L.DomUtil.create("div", "leaflet-control kommune-demografi-legend met-wind-legend met-wind-scale-legend");
          sharedScaleContainer = container;
          container.innerHTML = sharedScaleHtml(escapeHtml);
          L.DomEvent.disableClickPropagation(container);
          return container;
        };
      }
      if (sharedScaleUsers <= 0) sharedScaleControl.addTo(map);
      sharedScaleUsers += 1;
      state.sharedScaleActive = true;
      bringSharedScaleToBottom();
    }

    function bringSharedScaleToBottom() {
      if (!sharedScaleControl || sharedScaleUsers <= 0) return;
      map.removeControl(sharedScaleControl);
      sharedScaleControl.addTo(map);
    }

    function hideSharedScale() {
      if (!state.sharedScaleActive) return;
      sharedScaleUsers = Math.max(0, sharedScaleUsers - 1);
      state.sharedScaleActive = false;
      if (sharedScaleUsers === 0 && sharedScaleControl) {
        map.removeControl(sharedScaleControl);
        sharedScaleContainer = null;
      }
    }

    function createLegend() {
      const legend = L.control({ position: "bottomright" });
      legend.onAdd = () => {
        const container = L.DomUtil.create("div", "leaflet-control kommune-demografi-legend met-wind-legend");
        state.legendContainer = container;
        container.innerHTML = legendHtml();
        L.DomEvent.disableClickPropagation(container);
        return container;
      };
      return legend;
    }

    function updateLegend() {
      const container = state.legendContainer;
      if (!container) return;
      container.innerHTML = legendHtml();
    }

    function dispatchStatus() {
      if (!statusEvent) return;
      window.dispatchEvent(new CustomEvent(statusEvent, {
        detail: {
          visible: state.enabled,
          loaded: state.loaded,
          loading: state.loading,
          error: state.error,
          updatedAt: state.updatedAt,
          forecastTime: state.forecastTime,
          refreshMinutes: state.refreshMinutes,
          gridStepKm: state.gridStepKm,
          nearbyRadiusKm: state.nearbyRadiusKm,
          featureCount: state.featureCount,
          cachedPointCount: state.cachedPointCount,
          fetchedPointCount: state.fetchedPointCount,
          referencePointCount: state.referencePointCount,
          windReferencePointCount: state.windReferencePointCount,
          windReferenceMergeCount: state.windReferenceMergeCount,
          gridLimited: state.gridLimited,
          gridMode: state.gridMode,
          windArea: state.windArea,
          status: state.status
        }
      }));
    }

    function windArrowIcon(feature) {
      const props = feature.properties || {};
      const speed = Number(props.windSpeedMS || 0);
      const direction = normalizeDirection(
        props.windTowardDirectionDeg ?? ((Number(props.windDirectionDeg || 0) + 180) % 360)
      );
      const size = WIND_ARROW_SIZE;
      const color = windSpeedClass(speed).color;

      return L.divIcon({
        className: "met-wind-div-icon",
        html: `
          <div class="met-wind-marker" title="MET vind ${numberText(speed)} m/s">
            <svg
              class="met-wind-arrow"
              width="${size}"
              height="${size}"
              viewBox="0 0 32 32"
              style="transform: rotate(${direction}deg);"
              aria-hidden="true"
            >
              <path
                d="M16 3 L19.6 13 L16.8 12 L16.8 29 L15.2 29 L15.2 12 L12.4 13 Z"
                fill="${color}"
              ></path>
            </svg>
          </div>
        `,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2]
      });
    }

    function popupHtml(feature) {
      const props = feature.properties || {};
      const fromDirection = numberText(props.windDirectionDeg, 0);
      const towardDirection = numberText(props.windTowardDirectionDeg, 0);
      const gust = props.windGustMS == null ? "ikke oppgitt" : `${numberText(props.windGustMS)} m/s`;
      const temp = props.airTemperatureC == null ? "" : `<br>Temperatur: ${numberText(props.airTemperatureC)} °C`;
      const error = props.error ? `<br><span class="met-wind-error">Feil: ${escapeHtml(props.error)}</span>` : "";

      return `
        <div class="met-wind-popup">
          <strong>MET vind</strong><br>
          Vind: ${numberText(props.windSpeedMS)} ${escapeHtml(props.unit || "m/s")}<br>
          Kast: ${gust}<br>
          Fra retning: ${fromDirection}°<br>
          Mot retning: ${towardDirection}°${temp}<br>
          Tid: ${escapeHtml(props.forecastTime || "ukjent")}<br>
          Kilde: ${escapeHtml(props.source || "MET Locationforecast 2.0")}
          ${error}
        </div>
      `;
    }

    function removeLayer() {
      if (state.layer && map.hasLayer(state.layer)) {
        map.removeLayer(state.layer);
      }
      state.layer = null;
    }

    function removeLegend() {
      if (state.legend) {
        map.removeControl(state.legend);
        state.legend = null;
        state.legendContainer = null;
      }
    }

    async function load() {
      if (!state.enabled || state.loading) return;
      state.loading = true;
      state.error = "";
      updateControls();
      updateLegend();

      try {
        const res = await fetch(dataUrl, {
          cache: "no-store",
          headers: { "Accept": "application/geo+json, application/json" }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const geojson = await res.json();
        state.status = geojson.status || "";

        if (state.status === "aborted-config-changed") {
          state.error = "Vinddata oppdateres...";
          state.loading = false;
          updateControls();
          dispatchStatus();
          return;
        }

        state.updatedAt = geojson.updatedAt || "";
        state.refreshMinutes = geojson.refreshMinutes || "";
        state.gridStepKm = geojson.bounds?.gridStepKm || "";
        state.nearbyRadiusKm = geojson.bounds?.nearbyRadiusKm || "";
        state.featureCount = Array.isArray(geojson.features) ? geojson.features.length : 0;
        state.cachedPointCount = geojson.cachedPointCount ?? "";
        state.fetchedPointCount = geojson.fetchedPointCount ?? "";
        state.referencePointCount = geojson.referencePointCount ?? "";
        state.windReferencePointCount = geojson.windReferencePointCount ?? "";
        state.windReferenceMergeCount = geojson.windReferenceMergeCount ?? "";
        state.gridLimited = Boolean(geojson.gridLimited);
        state.gridMode = geojson.bounds?.gridMode || "";
        state.windArea = geojson.bounds?.windArea || "";
        const firstWindFeature = Array.isArray(geojson.features)
          ? geojson.features.find((feature) => feature?.properties?.forecastTime)
          : null;
        state.forecastTime = firstWindFeature?.properties?.forecastTime || "";
        removeLayer();

        state.layer = L.geoJSON(geojson, {
          filter: (feature) => {
            const props = feature.properties || {};
            return props.windSpeedMS != null && props.windDirectionDeg != null && !props.error;
          },
          pointToLayer: (feature, latlng) => L.marker(latlng, {
            icon: windArrowIcon(feature),
            interactive: true,
            keyboard: false
          }),
          onEachFeature: (feature, layer) => {
            layer.bindPopup(popupHtml(feature), {
              className: "met-wind-leaflet-popup"
            });
          }
        });

        if (state.enabled) state.layer.addTo(map);
        state.loaded = true;
        updateLegend();
      } catch (err) {
        state.error = err?.message || "ukjent feil";
        console.warn("[fieldpos] MET vind kunne ikke lastes", err);
      } finally {
        state.loading = false;
        updateControls();
        updateLegend();
        dispatchStatus();
      }
    }

    function updateControls() {
      const label = state.enabled
        ? state.loading
          ? `${labelBase} ...`
          : state.error
            ? (state.status === "aborted-config-changed" ? `${labelBase} oppdateres` : `${labelBase} feil`)
            : `${labelBase} på`
        : `${labelBase} av`;

      if (toggle) toggle.checked = state.enabled;
      if (dockToggle) {
        dockToggle.textContent = label;
        dockToggle.classList.toggle("active", state.enabled);
        dockToggle.setAttribute("aria-pressed", state.enabled ? "true" : "false");
      }
      dispatchStatus();
    }

    function stopRefresh() {
      if (state.timer) {
        window.clearInterval(state.timer);
        state.timer = null;
      }
    }

    function stopLegendRefresh() {
      if (state.legendTimer) {
        window.clearInterval(state.legendTimer);
        state.legendTimer = null;
      }
    }

    function startRefresh() {
      stopRefresh();
      state.timer = window.setInterval(load, FILE_REFRESH_MS);
    }

    function startLegendRefresh() {
      stopLegendRefresh();
      state.legendTimer = window.setInterval(updateLegend, 1000);
    }

    function setEnabled(enabled) {
      state.enabled = Boolean(enabled);

      if (persistEnabled) {
        try {
          window.localStorage.setItem(storageKey, state.enabled ? "1" : "0");
        } catch (err) {}
      }

      updateControls();

      if (!state.enabled) {
        stopRefresh();
        stopLegendRefresh();
        hideSharedScale();
        removeLayer();
        removeLegend();
        return;
      }

      if (!state.legend && statusEvent) {
        state.legend = createLegend();
        state.legend.addTo(map);
      }
      showSharedScale();
      bringSharedScaleToBottom();
      updateLegend();
      load();
      startRefresh();
      startLegendRefresh();
    }

    function start() {
      if (toggle) {
        toggle.addEventListener("change", () => setEnabled(toggle.checked));
      }
      if (dockToggle && dockClick) {
        dockToggle.addEventListener("click", () => setEnabled(!state.enabled));
      }
      let enabled = false;
      if (persistEnabled) {
        try {
          const value = window.localStorage.getItem(storageKey);
          enabled = value === null ? false : value === "1";
        } catch (err) {}
      }
      setEnabled(enabled);
    }

    return {
      reload: load,
      setEnabled,
      start
    };
  }

  window.FieldPosMetWindScale = WIND_SPEED_SCALE;
  window.FieldPosMetWind = { create };
})();
