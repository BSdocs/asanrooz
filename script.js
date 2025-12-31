(() => {
  "use strict";

  // ======================
  // ✅ CONFIG (FINAL)
  // ======================
  const WORKER_BASE =
    window.ASANROOZ_WORKER_BASE ||
    "https://asanrooz-check-captcha.mr-rahimi-kiasari.workers.dev";

  // endpoints
  const CAPTCHA_VERIFY_ENDPOINT =
    window.ASANROOZ_CAPTCHA_VERIFY_ENDPOINT || `${WORKER_BASE}/api/check-captcha`;
  const MESSAGE_ENDPOINT =
    window.ASANROOZ_MESSAGE_ENDPOINT || `${WORKER_BASE}/api/contact`;

  // timeouts
  const CAPTCHA_TIMEOUT_MS = 12_000;
  const MESSAGE_TIMEOUT_MS = 20_000;

  // ======================
  // Anti-spam / Quarantine (Front-only)
  // 3 successful sends in 10 minutes => quarantine for 1 hour
  // ======================
  const LS_SENDS = "asanrooz_contact_sends_v1";
  const LS_QUAR = "asanrooz_contact_quarantine_until_v1";
  const TEN_MIN = 10 * 60 * 1000;
  const ONE_HOUR = 60 * 60 * 1000;

  // ======================
  // Helpers
  // ======================
  const now = () => Date.now();
  const log = (...args) => console.log("[asanrooz]", ...args);

  function normalizeSpaces(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function onlyPersianChars(name) {
    return /^[\u0600-\u06FF\u200c\s]+$/.test(name);
  }

  function countPersianLetters(name) {
    return String(name || "").replace(/[\s\u200c]/g, "").length;
  }

  function isValidEmailByRules(email) {
    const v = String(email || "").trim();
    if (v.length < 7) return false;

    const parts = v.split("@");
    if (parts.length !== 2) return false;

    const local = parts[0];
    const domain = parts[1];
    if (!local || !domain) return false;

    if (domain.indexOf(".") === -1) return false;
    if (domain.startsWith(".") || domain.endsWith(".")) return false;

    const domLower = domain.toLowerCase();
    if (domLower === "codbanoo.ir" || domLower.endsWith(".codbanoo.ir")) return false;
    if (domLower === "asanrooz.ir" || domLower.endsWith(".asanrooz.ir")) return false;

    return true;
  }

  function captchaToken() {
    try {
      if (window.grecaptcha && typeof window.grecaptcha.getResponse === "function") {
        return String(window.grecaptcha.getResponse() || "");
      }
    } catch (_) {}
    return "";
  }

  function resetCaptcha() {
    try {
      if (window.grecaptcha && typeof window.grecaptcha.reset === "function") {
        window.grecaptcha.reset();
      }
    } catch (_) {}
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function withTimeout(promiseFn, ms, label) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(label || "TIMEOUT"), ms);

    const wrapped = (async () => {
      try {
        return await promiseFn(controller.signal);
      } finally {
        clearTimeout(id);
      }
    })();

    return { wrapped, controller };
  }

  function formatDetailsBlock(lines) {
    const clean = (lines || []).filter(Boolean).map(String);
    if (!clean.length) return "";
    return `\n\n— جزئیات فنی —\n${clean.join("\n")}`;
  }

  function pickWorkerMessage(data) {
    if (!data) return "";
    return String(
      data.message ||
        data.error ||
        (data.details && JSON.stringify(data.details)) ||
        ""
    ).trim();
  }

  function stringifyShort(obj, max = 800) {
    try {
      const s = JSON.stringify(obj);
      return s.length > max ? s.slice(0, max) + "…" : s;
    } catch (_) {
      return "";
    }
  }

  function collectClientMeta() {
    const tz = (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      } catch (_) {
        return "";
      }
    })();

    const scr = `${window.screen?.width || 0}x${window.screen?.height || 0}`;
    const vp = `${window.innerWidth || 0}x${window.innerHeight || 0}`;

    const dm = navigator.deviceMemory ? String(navigator.deviceMemory) : "";
    const hc = navigator.hardwareConcurrency ? String(navigator.hardwareConcurrency) : "";

    let conn = "";
    try {
      const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (c) {
        conn = [
          c.effectiveType ? `type=${c.effectiveType}` : "",
          typeof c.downlink === "number" ? `downlink=${c.downlink}` : "",
          typeof c.rtt === "number" ? `rtt=${c.rtt}` : "",
          c.saveData ? `saveData=1` : "",
        ]
          .filter(Boolean)
          .join(", ");
      }
    } catch (_) {}

    return {
      page: String(location.href || ""),
      referrer: String(document.referrer || ""),
      userAgent: String(navigator.userAgent || ""),
      language: String(navigator.language || ""),
      platform: String(navigator.platform || ""),
      timezone: tz,
      screen: scr,
      viewport: vp,
      deviceMemory: dm,
      hardwareConcurrency: hc,
      connection: conn,
      ts: new Date().toISOString(),
    };
  }

  // ======================
  // Quarantine storage
  // ======================
  function getSends() {
    try {
      const raw = localStorage.getItem(LS_SENDS);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((n) => typeof n === "number") : [];
    } catch (_) {
      return [];
    }
  }

  function setSends(arr) {
    try {
      localStorage.setItem(LS_SENDS, JSON.stringify(arr));
    } catch (_) {}
  }

  function getQuarantineUntil() {
    try {
      const v = Number(localStorage.getItem(LS_QUAR));
      return Number.isFinite(v) ? v : 0;
    } catch (_) {
      return 0;
    }
  }

  function setQuarantineUntil(ts) {
    try {
      localStorage.setItem(LS_QUAR, String(ts));
    } catch (_) {}
  }

  function minutesLeft(ts) {
    const diff = Math.max(0, ts - now());
    return Math.max(1, Math.ceil(diff / (60 * 1000)));
  }

  function quarantineMessage(mins) {
    return (
      `برای جلوگیری از شلوغی سرور، هر کاربر نهایتا ۳ پیام میتواند برای ما ارسال کند!\n` +
      `در صورتی که قصد ارسال پیام بیشتر دارید می‌توانید ${mins} دقیقه دیگر مجدد امتحان کنید یا اینکه با info@asanrooz.ir تماس بگیرید.`
    );
  }

  function isQuarantined() {
    const until = getQuarantineUntil();
    return !!(until && until > now());
  }

  function registerSuccessfulSend() {
    const t = now();
    let sends = getSends().filter((x) => t - x <= 2 * ONE_HOUR);
    sends.push(t);
    setSends(sends);

    const last10 = sends.filter((x) => t - x <= TEN_MIN);
    if (last10.length >= 3) setQuarantineUntil(t + ONE_HOUR);
  }

  // ======================
  // Global UX rules
  // ======================
  document.addEventListener("contextmenu", (e) => e.preventDefault(), { capture: true });

  // ======================
  // Elements
  // ======================
  const form = document.getElementById("contactForm");
  if (!form) return;

  const nameEl = document.getElementById("name");
  const emailEl = document.getElementById("email");
  const msgEl = document.getElementById("message");
  const sendBtn = document.getElementById("sendBtn");
  const contactSection = document.getElementById("contact");
  const contactLink = document.getElementById("contactLink");

  if (contactLink && contactSection) {
    contactLink.addEventListener("click", (e) => {
      e.preventDefault();
      try {
        contactSection.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (_) {
        location.hash = "#contact";
      }
    });
  }

  // ======================
  // Modal (uses your HTML modal)
  // ======================
  const modal = document.getElementById("modal");
  const modalTitle = document.getElementById("modalTitle");
  const modalText = document.getElementById("modalText");
  const modalOk = document.getElementById("modalOk");

  let afterCloseFocusEl = null;
  let pendingAfterCloseAction = null;

  function openModal(title, text, focusEl, afterClose, detailsLines) {
    const details = formatDetailsBlock(detailsLines);

    if (!modal || !modalTitle || !modalText || !modalOk) {
      alert(`${title}\n\n${text}${details ? "\n\n" + details : ""}`);
      return;
    }

    modalTitle.textContent = title || "پیام";
    modalText.textContent = String(text || "") + String(details || "");

    afterCloseFocusEl = focusEl || null;
    pendingAfterCloseAction = typeof afterClose === "function" ? afterClose : null;

    modal.classList.remove("is-closing");
    modal.classList.add("is-open");

    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";

    modalOk.focus();
  }

  function closeModal() {
    if (!modal) return;

    modal.classList.add("is-closing");

    setTimeout(() => {
      modal.classList.remove("is-open", "is-closing");

      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";

      if (pendingAfterCloseAction) {
        const fn = pendingAfterCloseAction;
        pendingAfterCloseAction = null;
        fn();
      } else if (afterCloseFocusEl && typeof afterCloseFocusEl.focus === "function") {
        afterCloseFocusEl.focus({ preventScroll: true });
        if (contactSection) {
          try {
            contactSection.scrollIntoView({ behavior: "smooth", block: "start" });
          } catch (_) {}
        }
      }

      afterCloseFocusEl = null;
    }, 460);
  }

  if (modalOk) modalOk.addEventListener("click", closeModal);

  // ESC should not close (only OK)
  document.addEventListener("keydown", (e) => {
    if (modal && modal.classList.contains("is-open") && (e.key === "Escape" || e.key === "Esc")) {
      e.preventDefault();
    }
  });

  // ======================
  // Validation (site rules)
  // ======================
  function validateInputsOnly() {
    const name = normalizeSpaces(nameEl?.value);
    const email = String(emailEl?.value || "").trim();
    const messageRaw = String(msgEl?.value || "");
    const messageTrim = messageRaw.trim();

    if (!name) {
      openModal("خطا", "لطفاً نام خود را وارد کنید.", nameEl);
      return false;
    }
    if (!onlyPersianChars(name)) {
      openModal("خطا", "لطفا نام خود را به فارسی وارد کنید.", nameEl);
      return false;
    }
    if (countPersianLetters(name) < 3) {
      openModal("خطا", "نام وارد شده صحیح نیست.", nameEl);
      return false;
    }

    if (!email) {
      openModal("خطا", "ایمیل خود را وارد کنید.", emailEl);
      return false;
    }
    if (!isValidEmailByRules(email)) {
      openModal("خطا", "ایمیل وارد شده صحیح نیست.", emailEl);
      return false;
    }

    if (!messageTrim) {
      openModal("خطا", "پیام خود را وارد کنید.", msgEl);
      return false;
    }
    if (messageTrim.length < 30) {
      openModal("خطا", "متن پیام باید حداقل ۳۰ کاراکتر باشد.", msgEl);
      return false;
    }
    const messageNoWhitespace = messageRaw.replace(/\s+/g, "");
    if (messageNoWhitespace.length === 0) {
      openModal("خطا", "لطفا پیام خود را بصورت صحیح بنویسید.", msgEl);
      return false;
    }

    // must be checked (token exists)
    const tok = captchaToken();
    if (!tok) {
      openModal("خطا", "لطفا تایید کنید که ربات نیستید!", null);
      return false;
    }

    return true;
  }

  // ======================
  // Network calls
  // ======================
  async function verifyCaptchaOnWorker(token) {
    const requestFn = async (signal) => {
      const res = await fetch(CAPTCHA_VERIFY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          captchaToken: token,
          source: "asanrooz-landing",
          ts: new Date().toISOString(),
        }),
        signal,
      });

      const text = await res.text().catch(() => "");
      const data = safeJsonParse(text);

      if (!res.ok) {
        const msg = pickWorkerMessage(data) || "CAPTCHA_VERIFY_FAILED";
        const err = new Error(msg);
        err.__http = { url: CAPTCHA_VERIFY_ENDPOINT, status: res.status, data, text };
        throw err;
      }

      if (!data) {
        const t = String(text || "").trim().toLowerCase();
        const ok = t === "ok" || t === "true" || t === "valid";
        return { ok, raw: text };
      }

      const ok =
        data.ok === true ||
        data.success === true ||
        data.valid === true ||
        data.human === true ||
        data.allowed === true ||
        data.pass === true;

      return { ok, raw: data };
    };

    const { wrapped } = withTimeout(requestFn, CAPTCHA_TIMEOUT_MS, "CAPTCHA_TIMEOUT");
    return await wrapped;
  }

  async function sendMessageToBackend(payload) {
    const requestFn = async (signal) => {
      const res = await fetch(MESSAGE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });

      const text = await res.text().catch(() => "");
      const data = safeJsonParse(text);

      if (!res.ok) {
        const msg = pickWorkerMessage(data) || "MESSAGE_SEND_FAILED";
        const err = new Error(msg);
        err.__http = { url: MESSAGE_ENDPOINT, status: res.status, data, text };
        throw err;
      }

      if (data) {
        const ok =
          data.ok === true ||
          data.success === true ||
          data.status === "ok" ||
          data.status === "success";
        if (!ok) {
          const msg = pickWorkerMessage(data) || "MESSAGE_SEND_FAILED";
          const err = new Error(msg);
          err.__http = { url: MESSAGE_ENDPOINT, status: res.status, data, text };
          throw err;
        }
        return data;
      }

      // 200 with non-JSON => assume success
      return { ok: true, raw: text };
    };

    const { wrapped } = withTimeout(requestFn, MESSAGE_TIMEOUT_MS, "MESSAGE_TIMEOUT");
    return await wrapped;
  }

  function buildTechLinesFromError(err) {
    const lines = [];
    if (!err) return lines;

    const name = err.name ? String(err.name) : "Error";
    const msg = err.message ? String(err.message) : "";
    lines.push(`${name}: ${msg}`);

    // Abort timeout
    if (String(msg).includes("TIMEOUT") || err.name === "AbortError") {
      lines.push("Reason: timeout/abort");
    }

    const http = err.__http;
    if (http) {
      lines.push(`URL: ${http.url}`);
      lines.push(`HTTP Status: ${http.status}`);
      if (http.data) lines.push(`Body(JSON): ${stringifyShort(http.data, 1200)}`);
      else if (http.text) lines.push(`Body(Text): ${String(http.text).slice(0, 1200)}${String(http.text).length > 1200 ? "…" : ""}`);
    }

    // Chrome fetch CORS errors typically appear as TypeError: Failed to fetch
    if (msg === "Failed to fetch") {
      lines.push("Hint: ممکن است مشکل CORS/Network باشد.");
    }

    return lines;
  }

  // ======================
  // Submit flow
  // ======================
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    // stay at contact section
    if (contactSection) {
      try {
        contactSection.scrollIntoView({ behavior: "auto", block: "start" });
      } catch (_) {}
    }

    // quarantine
    if (isQuarantined()) {
      openModal("خطا", quarantineMessage(minutesLeft(getQuarantineUntil())), null);
      return;
    }

    // local validation + captcha checked
    if (!validateInputsOnly()) return;

    const prevDisabled = sendBtn?.disabled;
    if (sendBtn) sendBtn.disabled = true;

    // debug logging
    log("Worker base:", WORKER_BASE);
    log("captcha endpoint:", CAPTCHA_VERIFY_ENDPOINT);
    log("message endpoint:", MESSAGE_ENDPOINT);

    try {
      const token = captchaToken();

      // 1) Verify captcha (step-1)
      let verifyResult;
      try {
        verifyResult = await verifyCaptchaOnWorker(token);
        log("captcha verify result:", verifyResult);
      } catch (err) {
        log("captcha verify error:", err);
        openModal(
          "خطا",
          "در بررسی کپچا مشکلی رخ داد! لطفاً دوباره تلاش کنید.",
          null,
          null,
          buildTechLinesFromError(err)
        );
        return;
      }

      if (!verifyResult || verifyResult.ok !== true) {
        openModal("خطا", "لطفا تایید کنید که ربات نیستید!", null, null, [
          "captcha check returned not-ok",
          `raw: ${stringifyShort(verifyResult, 800)}`,
        ]);
        return;
      }

      // 2) Send full message (step-2)
      const meta = collectClientMeta();

      const payload = {
        name: normalizeSpaces(nameEl.value),
        email: String(emailEl.value || "").trim(),
        message: String(msgEl.value || ""),
        captchaToken: token,

        // meta
        page: meta.page,
        referrer: meta.referrer,
        userAgent: meta.userAgent,
        language: meta.language,
        platform: meta.platform,
        timezone: meta.timezone,
        screen: meta.screen,
        viewport: meta.viewport,
        deviceMemory: meta.deviceMemory,
        hardwareConcurrency: meta.hardwareConcurrency,
        connection: meta.connection,
        ts: meta.ts,

        // optional tag
        source: "asanrooz-landing",
      };

      try {
        const resp = await sendMessageToBackend(payload);
        log("contact send response:", resp);
      } catch (err) {
        log("contact send error:", err);
        openModal(
          "خطا",
          "مشکلی در روند ارسال پیام رخ داد! لطفا بعدا دوباره امتحان کنید.",
          null,
          null,
          buildTechLinesFromError(err)
        );
        return;
      }

      // success -> register front quarantine
      registerSuccessfulSend();

      // success modal: after OK => reset + scroll top
      openModal(
        "توجه",
        "پیام شما را دریافت کردیم و به زودی از طریق ایمیل ثبت شده به آن پاسخ خواهیم داد.",
        null,
        () => {
          form.reset();
          resetCaptcha();
          try {
            window.scrollTo({ top: 0, behavior: "smooth" });
          } catch (_) {
            window.scrollTo(0, 0);
          }
        }
      );
    } finally {
      if (sendBtn) sendBtn.disabled = prevDisabled || false;
    }
  });
})();
