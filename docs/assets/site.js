/* Small progressive enhancements: theme toggle, contents list, copy button. */
(function () {
  var root = document.documentElement;

  function currentTheme() {
    if (root.dataset.theme) return root.dataset.theme;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  var toggle = document.querySelector("[data-theme-toggle]");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try { localStorage.setItem("jev-theme", next); } catch (e) {}
    });
  }

  // Build the contents list from the headings the page actually has.
  var nav = document.getElementById("toc");
  var heads = document.querySelectorAll(".prose h2[id]");
  if (nav && heads.length > 2) {
    heads.forEach(function (h) {
      var a = document.createElement("a");
      a.href = "#" + h.id;
      a.textContent = h.textContent;
      nav.appendChild(a);
    });
    document.querySelector(".toc").classList.add("is-ready");

    var links = nav.querySelectorAll("a");
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (l) {
          l.classList.toggle("active", l.getAttribute("href") === "#" + entry.target.id);
        });
      });
    }, { rootMargin: "-80px 0px -70% 0px" });
    heads.forEach(function (h) { spy.observe(h); });
  }

  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      navigator.clipboard.writeText(btn.dataset.copy).then(function () {
        var was = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = was; }, 1600);
      });
    });
  });
})();
