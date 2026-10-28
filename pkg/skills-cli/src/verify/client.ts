export const VERIFY_JS = `(function () {
  var seen = null;
  function tick() {
    fetch("/reload", { cache: "no-store" }).then(function (response) {
      return response.json();
    }).then(function (body) {
      var token = body && typeof body.token === "string" ? body.token : "";
      if (seen === null) {
        seen = token;
        return;
      }
      if (token !== seen) location.reload();
    }).catch(function () {});
  }
  tick();
  setInterval(tick, 2000);
  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form || !form.getAttribute || form.getAttribute("action") !== "/decision") return;
    var submitter = event.submitter;
    var action = submitter ? submitter.getAttribute("value") || "" : "";
    var field = form.querySelector("textarea[name=note]");
    var note = field ? field.value.trim() : "";
    var error = form.querySelector("[data-note-error]");
    if ((action === "reject" || action === "tweak") && note.length === 0) {
      event.preventDefault();
      if (error) error.textContent = "A note is required.";
    }
  });
})();
`;

export const VERIFY_CSS = `:root { color-scheme: light dark; }
body { margin: 0; font: 16px/1.45 ui-sans-serif, system-ui, sans-serif; }
main { max-width: 1440px; margin: 0 auto; padding: 24px; }
.banner, .error { padding: 12px 14px; margin: 0 0 16px; border: 1px solid #8884; }
article { border-top: 1px solid #8884; margin-top: 28px; padding-top: 16px; }
.cols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
section h3 { margin: 0 0 8px; font-size: 14px; }
figure { margin: 0 0 12px; }
img { display: block; max-width: 100%; height: auto; background: #c8c8c8; }
figcaption { font-size: 12px; margin-top: 4px; }
textarea { width: 100%; min-height: 4.5rem; box-sizing: border-box; }
button { margin: 0 8px 8px 0; }
pre { white-space: pre-wrap; }
@media (max-width: 800px) {
  .cols { grid-template-columns: 1fr; }
}
`;
