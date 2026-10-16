/* FieldPos map status controls */
"use strict";

(function () {
  function create(options) {
    const map = options.map;
    const L = options.L || window.L;

    const state = {
      activePoints: 0,
      shownMeasurements: 0,
      emailIntervalActive: false,
      container: null,
      started: false
    };

    function render() {
      if (!state.container) return;
      state.container.innerHTML = [
        "<div class=\"map-info-title\">Status:</div>",
        `<div>Zoom ${map.getZoom()}</div>`,
        `<div>Aktive punkter: ${state.activePoints}</div>`,
        `<div>Viste målinger: ${state.shownMeasurements}</div>`,
        `<div class="${state.emailIntervalActive ? "map-info-email-on" : "map-info-email-off"}">Epost: ${state.emailIntervalActive ? "på" : "av"}</div>`
      ].join("");
    }

    function update(values = {}) {
      if (Number.isFinite(Number(values.activePoints))) {
        state.activePoints = Number(values.activePoints);
      }
      if (Number.isFinite(Number(values.shownMeasurements))) {
        state.shownMeasurements = Number(values.shownMeasurements);
      }
      if (typeof values.emailIntervalActive === "boolean") {
        state.emailIntervalActive = values.emailIntervalActive;
      }
      render();
    }

    function start() {
      if (state.started) return;
      state.started = true;

      L.control.scale({
        imperial: false,
        metric: true,
        position: "bottomleft"
      }).addTo(map);

      const statusControl = L.control({ position: "bottomleft" });
      statusControl.onAdd = () => {
        state.container = L.DomUtil.create("div", "leaflet-control fieldpos-map-info");
        state.container.setAttribute("aria-live", "polite");
        L.DomEvent.disableClickPropagation(state.container);
        render();
        return state.container;
      };
      statusControl.addTo(map);

      map.on("zoomend", render);
    }

    return {
      start,
      update
    };
  }

  window.FieldPosKartInfo = { create };
})();
