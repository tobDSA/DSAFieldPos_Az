"use strict";

(() => {
  const header = document.querySelector(".app-header");
  const heading = document.querySelector(".brand-block h1");
  heading.textContent = "DSA FieldPos Mobile";
  document.title = "DSA FieldPos Mobile";

  const desktop = document.createElement("a");
  desktop.href = "/";
  desktop.className = "mobile-desktop-link";
  desktop.textContent = "Full visning";
  header.append(desktop);

  const toolbar = document.createElement("nav");
  toolbar.className = "mobile-toolbar";
  toolbar.setAttribute("aria-label", "Kart og måler");
  const gps = document.getElementById("gps-toggle");
  gps.textContent = "GPS på";
  gps.setAttribute("aria-label", "Slå på GPS");
  gps.setAttribute("aria-pressed", "false");
  const dosimeter = document.getElementById("dosimeter-window-open");
  dosimeter.textContent = "Dosimeter";
  dosimeter.setAttribute("aria-haspopup", "dialog");
  const norway = document.getElementById("zoom-norway");
  toolbar.append(gps, dosimeter, norway);
  document.body.append(toolbar);

  const dialog = document.createElement("dialog");
  dialog.id = "mobile-dosimeter-dialog";
  dialog.setAttribute("aria-labelledby", "mobile-dosimeter-title");
  dialog.innerHTML = `<div class="mobile-dosimeter-heading">
    <h2 id="mobile-dosimeter-title">Dosimeter</h2>
    <button type="button" id="mobile-dosimeter-close">Til kartet</button>
  </div><iframe title="Dosimeter" allow="geolocation" src="about:blank"></iframe>`;
  document.body.append(dialog);
  const frame = dialog.querySelector("iframe");
  // Load only when requested. Keep the map and its GPS watch alive underneath.
  dosimeter.addEventListener("click", () => {
    if (frame.getAttribute("src") === "about:blank") frame.src = "/mobile/dosimeter";
  });
  dialog.querySelector("button").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    // Unload the instrument to release audio/timers when returning to the map.
    frame.src = "about:blank";
    dosimeter.focus();
  });
})();
