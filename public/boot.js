// Runs before the dashboard's own code. If that code can't load (a file the
// server didn't send, a browser that's too old), this says so, instead of
// "Opening the box…" forever.
(function () {
  var problems = [];
  window.addEventListener(
    "error",
    function (e) {
      var el = e.target;
      if (el && el !== window && (el.src || el.href)) problems.push("Couldn't load " + (el.src || el.href));
      else if (e.message) problems.push(e.message);
    },
    true,
  );
  window.addEventListener("unhandledrejection", function (e) {
    problems.push(String((e.reason && e.reason.message) || e.reason));
  });
  setTimeout(function () {
    var app = document.getElementById("app");
    if (!app || app.getAttribute("data-started")) return;
    var box = document.createElement("section");
    box.className = "card stack login";
    var title = document.createElement("h1");
    title.textContent = "The dashboard didn't load";
    var what = document.createElement("p");
    what.textContent =
      "This browser got the page, but not the code that runs it. Reload to try again. If it keeps happening, run `node src/cli.ts doctor` on the computer running Cardboard, and send what it says along with what's below.";
    box.append(title, what);
    if (problems.length) {
      var list = document.createElement("pre");
      list.className = "small";
      list.textContent = problems.slice(0, 8).join("\n");
      box.append(list);
    }
    app.replaceChildren(box);
  }, 12000);
})();
