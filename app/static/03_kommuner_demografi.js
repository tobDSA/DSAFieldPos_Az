/* FieldPos municipality demographics overlay */
"use strict";

(function () {
  const STORAGE_KEY = "fieldposKommunerDemografi";
  const DATA_URL = "data/kartverk/kommuner_demografi.geojson";
  const BINS = [
    { min: 200001, label: "> 200 000", color: "#7a0177" },
    { min: 100001, label: "100 001-200 000", color: "#c51b8a" },
    { min: 50001, label: "50 001-100 000", color: "#f768a1" },
    { min: 20001, label: "20 001-50 000", color: "#fa9fb5" },
    { min: 10001, label: "10 001-20 000", color: "#fcc5c0" },
    { min: 0, label: "0-10 000", color: "#feebe2" }
  ];

  function storedEnabled() {
    try {
      const value = window.localStorage.getItem(STORAGE_KEY);
      return value === null ? true : value === "1";
    } catch (err) {
      return true;
    }
  }

  function populationOf(feature) {
    const value = Number(feature?.properties?.population);
    return Number.isFinite(value) ? value : null;
  }

  function kommuneName(feature) {
    const props = feature?.properties || {};
    return props.kommunenavn || props.navn || props.name || props.kommunenummer || "Kommune";
  }

  function binForPopulation(population) {
    if (!Number.isFinite(population)) return { label: "Ukjent", color: "#d6dbe1" };
    return BINS.find((bin) => population >= bin.min) || BINS[BINS.length - 1];
  }

  function formatPopulation(population) {
    if (!Number.isFinite(population)) return "ukjent";
    return new Intl.NumberFormat("no-NO").format(population);
  }

  function create(options) {
    const map = options.map;
    const L = options.L || window.L;
    const escapeHtml = options.escapeHtml;
    const toggle = options.toggle || null;
    const button = options.button || null;
    const state = {
      enabled: true,
      loaded: false,
      loading: false,
      error: "",
      featureCount: 0,
      layer: null,
      legend: null,
      legendContainer: null
    };

    function styleFeature(feature) {
      const bin = binForPopulation(populationOf(feature));
      return {
        color: "#555",
        weight: 1,
        fillColor: bin.color,
        fillOpacity: 0.35
      };
    }

    function popupHtml(feature) {
      const props = feature?.properties || {};
      const population = populationOf(feature);
      const year = props.population_year ? ` (${props.population_year})` : "";
      return `
        <div class="kommune-demografi-popup">
          <strong>${escapeHtml(kommuneName(feature))}</strong>
          <div>Innbyggere${escapeHtml(year)}: ${escapeHtml(formatPopulation(population))}</div>
          <div>Kommunenr: ${escapeHtml(props.kommunenummer || "")}</div>
        </div>
      `;
    }

    async function load() {
      if (state.loaded || state.loading) return;
      state.loading = true;
      state.error = "";
      updateLegend();
      updateControls();

      try {
        const res = await fetch(DATA_URL, {
          cache: "force-cache",
          headers: { "Accept": "application/geo+json, application/json" }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const geojson = await res.json();
        state.featureCount = Array.isArray(geojson.features) ? geojson.features.length : 0;
        state.layer = L.geoJSON(null, {
          style: styleFeature,
          onEachFeature: (feature, layer) => {
            layer.bindPopup(popupHtml(feature), {
              className: "kommune-demografi-leaflet-popup"
            });
          }
        });
        state.layer.addData(geojson);
        state.loaded = true;
        updateLegend();
        updateControls();
        if (state.enabled) {
          state.layer.addTo(map);
        }
      } catch (err) {
        state.error = err?.message || "ukjent feil";
        updateLegend();
        updateControls();
        console.warn("[fieldpos] kommuner/demografi kunne ikke lastes", err);
      } finally {
        state.loading = false;
        updateControls();
      }
    }

    function createLegend() {
      const legend = L.control({ position: "topright" });
      legend.onAdd = () => {
        const container = L.DomUtil.create("div", "leaflet-control kommune-demografi-legend");
        state.legendContainer = container;
        container.innerHTML = legendHtml();
        L.DomEvent.disableClickPropagation(container);
        return container;
      };
      return legend;
    }

    function legendHtml() {
      const title = state.error
        ? `Feil ved lasting: ${state.error}`
        : state.loaded
          ? `Innbyggere (${state.featureCount} kommuner)`
          : "Laster kommuner ...";
      return [
        `<strong>${escapeHtml(title)}</strong>`,
        ...BINS.map((bin) => `
          <div class="kommune-demografi-legend-row">
            <span style="background:${bin.color}"></span>
            <em>${bin.label}</em>
          </div>
        `)
      ].join("");
    }

    function updateLegend() {
      const container = state.legendContainer || document.querySelector(".kommune-demografi-legend");
      if (!container) return;
      container.innerHTML = legendHtml();
    }

    function updateControls() {
      const label = state.enabled
        ? state.loaded
          ? "Kommuner på"
          : state.loading
            ? "Kommuner ..."
            : state.error
              ? "Kommuner feil"
              : "Kommuner på"
        : "Kommuner av";

      if (toggle) {
        toggle.checked = state.enabled;
      }
      if (button) {
        button.textContent = label;
        button.classList.toggle("active", state.enabled);
        button.setAttribute("aria-pressed", state.enabled ? "true" : "false");
      }
    }

    function setEnabled(enabled) {
      state.enabled = Boolean(enabled);

      try {
        window.localStorage.setItem(STORAGE_KEY, state.enabled ? "1" : "0");
      } catch (err) {}

      if (toggle) {
        toggle.checked = state.enabled;
      }
      updateControls();

      if (!state.enabled) {
        if (state.layer) map.removeLayer(state.layer);
        if (state.legend) map.removeControl(state.legend);
        state.legend = null;
        return;
      }

      if (!state.legend) {
        state.legend = createLegend();
        state.legend.addTo(map);
      }
      updateLegend();
      updateControls();
      load();
      if (state.layer && !map.hasLayer(state.layer)) state.layer.addTo(map);
    }

    function start() {
      if (toggle) {
        toggle.addEventListener("change", () => setEnabled(toggle.checked));
      }
      if (button) {
        button.addEventListener("click", () => setEnabled(!state.enabled));
      }
      setEnabled(storedEnabled());
    }

    return {
      setEnabled,
      start
    };
  }

  window.FieldPosKommunerDemografi = { create };
})();
