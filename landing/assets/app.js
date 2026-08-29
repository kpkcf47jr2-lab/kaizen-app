// ══════════════════════════════════════════════════════════════════════
//  Kaizen 777 landing — starfield + shooting stars + waitlist submit.
//  Zero build tools; ships as a single <script defer>.
// ══════════════════════════════════════════════════════════════════════

(() => {
  "use strict";

  // ── 1. Starfield ────────────────────────────────────────────────────
  // A real canvas starfield tuned to feel like the logo's night sky:
  // most stars a cool white, a minority tinted cobalt-blue, plus rare
  // shooting stars that streak across the frame.
  const canvas = document.getElementById("starfield");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (canvas && canvas.getContext) initStarfield(canvas, reduceMotion);

  function initStarfield(cvs, reduce) {
    const ctx = cvs.getContext("2d");
    let stars = [], shooters = [], w = 0, h = 0, dpr = 1, last = 0;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = cvs.clientWidth = window.innerWidth;
      h = cvs.clientHeight = window.innerHeight;
      cvs.width = w * dpr;
      cvs.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    }

    function seed() {
      // Density scales with area — hand-tuned so mobile isn't overwhelmed
      // and desktop feels dense without hammering the compositor.
      const density = reduce ? 0.00012 : 0.00028;
      const count = Math.min(360, Math.floor(w * h * density));
      stars = [];
      for (let i = 0; i < count; i++) {
        const cobalt = Math.random() < 0.18;
        stars.push({
          x: Math.random() * w,
          y: Math.random() * h,
          r: Math.random() * 1.4 + 0.3,
          a: Math.random() * 0.6 + 0.35,
          twinkleSpeed: (Math.random() * 0.6 + 0.2) * (reduce ? 0 : 1),
          phase: Math.random() * Math.PI * 2,
          cobalt,
        });
      }
      shooters = [];
    }

    function maybeSpawnShooter(t) {
      if (reduce) return;
      // ~one shooter every ~7s on average
      if (shooters.length < 2 && Math.random() < 0.0022) {
        const fromTop = Math.random() < 0.5;
        shooters.push({
          x: Math.random() * w * 0.6 + w * 0.1,
          y: fromTop ? -20 : Math.random() * h * 0.4,
          vx: (Math.random() * 3 + 4) * (Math.random() < 0.5 ? 1 : -1),
          vy: Math.random() * 2 + 3,
          life: 0,
          maxLife: 60 + Math.random() * 30,
        });
      }
    }

    function draw(t) {
      const dt = last ? Math.min(50, t - last) : 16;
      last = t;

      ctx.clearRect(0, 0, w, h);

      // Stars
      for (const s of stars) {
        s.phase += s.twinkleSpeed * dt * 0.002;
        const twinkle = 0.55 + Math.sin(s.phase) * 0.45;
        const a = Math.max(0.05, Math.min(1, s.a * twinkle));
        ctx.beginPath();
        ctx.fillStyle = s.cobalt
          ? `rgba(76, 111, 255, ${a})`
          : `rgba(232, 236, 255, ${a})`;
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Shooters
      maybeSpawnShooter(t);
      for (let i = shooters.length - 1; i >= 0; i--) {
        const sh = shooters[i];
        sh.life += 1;
        sh.x += sh.vx;
        sh.y += sh.vy;
        const fade = Math.max(0, 1 - sh.life / sh.maxLife);
        const grad = ctx.createLinearGradient(sh.x, sh.y, sh.x - sh.vx * 8, sh.y - sh.vy * 8);
        grad.addColorStop(0, `rgba(255, 255, 255, ${fade})`);
        grad.addColorStop(1, "rgba(76, 111, 255, 0)");
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(sh.x, sh.y);
        ctx.lineTo(sh.x - sh.vx * 8, sh.y - sh.vy * 8);
        ctx.stroke();
        if (sh.life > sh.maxLife || sh.x < -100 || sh.x > w + 100 || sh.y > h + 100) {
          shooters.splice(i, 1);
        }
      }

      if (!reduce) requestAnimationFrame(draw);
    }

    resize();
    let resizeTimer;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 120);
    });
    // Draw at least once even if reduced-motion; keeps a static field.
    requestAnimationFrame(draw);
  }

  // ── 2. Waitlist ────────────────────────────────────────────────────
  // Backend URL — currently the Cloudflare Tunnel while backend runs on
  // owner's Mac. When we move to Hetzner, change this constant and
  // redeploy. Same-origin fallback isn't wired because the landing lives
  // on kaizen-777.com (Pages) while the API sits behind the tunnel.
  const API_BASE = "https://mass-chrome-temperature-editorials.trycloudflare.com";

  const form = document.getElementById("waitlist-form");
  const status = document.getElementById("waitlist-status");
  if (!form || !status) return;

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = (new FormData(form).get("email") || "").toString().trim();
    if (!isEmail(email)) {
      setStatus("Escribí un email válido.", "err");
      return;
    }

    const btn = form.querySelector("button");
    const label = btn.querySelector(".btn-label");
    const original = label ? label.textContent : "Notificarme";
    btn.disabled = true;
    if (label) label.textContent = "Enviando…";
    setStatus("", "");

    try {
      const res = await fetch(`${API_BASE.replace(/\/$/, "")}/waitlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, source: "kaizen-777.com" }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok !== false) {
        setStatus(data.already
          ? "Ya estabas en la waitlist — te avisamos cuando abramos."
          : "Listo. Te avisamos cuando abramos acceso.", "ok");
        form.reset();
      } else {
        setStatus(data.error || `No pudimos guardar tu email (${res.status}).`, "err");
      }
    } catch {
      setStatus("El sistema está temporalmente offline — probá en unos minutos.", "err");
    } finally {
      btn.disabled = false;
      if (label) label.textContent = original;
    }
  });

  function isEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  }
  function setStatus(msg, kind) {
    status.textContent = msg;
    status.className = "waitlist-status" + (kind ? " " + kind : "");
  }
})();
