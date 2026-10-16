/* FieldPos ambient gamma overlay */
"use strict";

(function () {
  const STORAGE_KEY = "fieldposAmbientGamma";
  const DATA_URL = "data/online2/ambient_gamma_stations.geojson";

  function storedEnabled() {
    try {
      const value = window.localStorage.getItem(STORAGE_KEY);
      return value === null ? false : value === "1";
    } catch (err) {
      return false;
    }
  }

  function gammaColor(nSvH) {
    if (nSvH >= 500) return "#7a0000";
    if (nSvH >= 300) return "#cc0000";
    if (nSvH >= 200) return "#ff8800";
    if (nSvH >= 150) return "#ffd000";
    return "#2ecc71";
  }

  function create(options) {
    const map = options.map;
    const L = options.L || window.L;
    const escapeHtml = options.escapeHtml;
    const toggle = options.toggle || null;
    const dockToggle = options.dockToggle || null;
    const disabled = options.disabled === true;
    const state = {
      enabled: true,
      loaded: false,
      loading: false,
      error: "",
      featureCount: 0,
      layer: null
    };

    function popupHtml(feature) {
      const p = feature?.properties || {};
      return `
        <div class="ambient-gamma-popup">
          <strong>Ambient gamma dose rate</strong>
          <div>${escapeHtml(p.stationName || p.stationId || "Ukjent stasjon")}</div>
          <div>${escapeHtml(p.doseRateNSvH ?? "?")} ${escapeHtml(p.unit || "nSv/h")}</div>
          <div>Tid: ${escapeHtml(p.timestampUtc || "ukjent")}</div>
          <div>Kilde: ${escapeHtml(p.source || "ukjent")}</div>
          <small>Foreløpig/ikke validert verdi.</small>
        </div>
      `;
    }

    function markerForFeature(feature, latlng) {
      const value = Number(feature?.properties?.doseRateNSvH || 0);
      return L.circleMarker(latlng, {
        radius: 6,
        weight: 2,
        color: "#ffffff",
        fillColor: gammaColor(value),
        fillOpacity: 0.9
      });
    }

    async function load() {
      if (disabled) return;
      if (state.loaded || state.loading) return;
      state.loading = true;
      state.error = "";
      updateControls();

      try {
        const res = await fetch(DATA_URL, {
          cache: "no-store",
          headers: { "Accept": "application/geo+json, application/json" }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const geojson = await res.json();
        state.featureCount = Array.isArray(geojson.features) ? geojson.features.length : 0;
        state.layer = L.geoJSON(geojson, {
          pointToLayer: markerForFeature,
          onEachFeature: (feature, layer) => {
            layer.bindPopup(popupHtml(feature), {
              className: "ambient-gamma-leaflet-popup"
            });
          }
        });
        state.loaded = true;
        if (state.enabled) state.layer.addTo(map);
      } catch (err) {
        state.error = err?.message || "ukjent feil";
        console.warn("[fieldpos] ambient gamma kunne ikke lastes", err);
      } finally {
        state.loading = false;
        updateControls();
      }
    }

    function updateControls() {
      const label = disabled
        ? "Gamma"
        : state.enabled
        ? state.loading
          ? "Gamma ..."
          : state.error
            ? "Gamma feil"
            : "Gamma på"
        : "Gamma av";

      if (toggle) {
        toggle.checked = disabled ? false : state.enabled;
        toggle.disabled = disabled;
      }
      if (dockToggle) {
        dockToggle.textContent = label;
        dockToggle.disabled = disabled;
        dockToggle.classList.toggle("active", !disabled && state.enabled);
        dockToggle.setAttribute("aria-disabled", disabled ? "true" : "false");
        dockToggle.setAttribute("aria-pressed", !disabled && state.enabled ? "true" : "false");
      }
    }

    function setEnabled(enabled) {
      state.enabled = disabled ? false : Boolean(enabled);

      try {
        window.localStorage.setItem(STORAGE_KEY, state.enabled ? "1" : "0");
      } catch (err) {}

      updateControls();

      if (!state.enabled) {
        if (state.layer) map.removeLayer(state.layer);
        return;
      }

      load();
      if (state.layer && !map.hasLayer(state.layer)) state.layer.addTo(map);
    }

    function start() {
      if (toggle && !disabled) {
        toggle.addEventListener("change", () => setEnabled(toggle.checked));
      }
      if (dockToggle && !disabled) {
        dockToggle.addEventListener("click", () => setEnabled(!state.enabled));
      }
      setEnabled(disabled ? false : storedEnabled());
    }

    return {
      setEnabled,
      start
    };
  }

  window.FieldPosAmbientGamma = { create };
})();
