(() => {
  "use strict";

  // ======================
  // ✅ CONFIG (FINAL)
  // ======================
  // Worker شما (اکانتش هرچی باشه مهم نیست)
  const WORKER_BASE =
    window.ASANROOZ_WORKER_BASE ||
    "https://asanrooz-check-captcha.mr-rahimi-kiasari.workers.dev";

  // مسیرهای استاندارد Worker جدید
  const CAPTCHA_VERIFY_ENDPOINT =
    window.ASANROOZ_CAPTCHA_VERIFY_ENDPOINT || `${WORKER_BASE}/api/check-captcha`;

  const MESSAGE_ENDPOINT =
    window.ASANROOZ_MESSAGE_ENDPOINT || `${WORKER_BASE}/api/contact`;

  // Timeout ها
  const CAPTCHA_TIMEOUT_MS = 12_000;
  const MESSAGE_TIMEOUT_MS = 20_000;

  // ======================
  // Anti-spam / Quarantine (Front-only)
  // 3 موفقیت در 10 دقیقه => قرنطینه 1 ساعت
  // ======================
  const LS_SENDS = "asanrooz_contact_sends_v1";
  const LS_QUAR = "asanrooz_contact_quarantine_until_v1";
  const TEN_MIN = 10 * 60 * 1000;
  const ONE_HOUR = 60 * 60 * 1000;

  // ======================
  // Helpers
  // ======================
  const now = () => Date.now();

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

  async function fetchJson(url, payload, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort("TIMEOUT"), timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });

      const text = await res.text().catch(() => "");
      const data = safeJsonParse(text);

      return { ok: res.ok, status: res.status, data, text };
    } finally {
      clearTimeout(t);
    }
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

  function openModal(title, text, focusEl, afterClose) {
    if (!modal || !modalTitle || !modalText || !modalOk) {
      alert(`${title}\n\n${text}`);
      return;
    }

    modalTitle.textContent = title || "پیام";
    modalText.textContent = text || "";
    afterCloseFocusEl = focusEl || null;
    pendingAfterCloseAction = typeof afterClose === "function" ? afterClose : null;

    modal.classList.remove("is-closing");
    modal.classList.add("is-open");

    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";

    try {
      modalOk.focus({ preventScroll: true });
    } catch (_) {
      modalOk.focus();
    }
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
        try {
          afterCloseFocusEl.focus({ preventScroll: true });
        } catch (_) {
          afterCloseFocusEl.focus();
        }
        // روی همان بخش بمان
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

  document.addEventListener("keydown", (e) => {
    if (modal && modal.classList.contains("is-open") && (e.key === "Escape" || e.key === "Esc")) {
      e.preventDefault(); // فقط با تایید بسته شود
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

    const tok = captchaToken();
    if (!tok) {
      openModal("خطا", "لطفا تایید کنید که ربات نیستید!", null);
      return false;
    }

    return true;
  }

  // ======================
  // Worker response helpers
  // ======================
  function isCaptchaPositive(data) {
    if (!data) return false;

    // حالت‌های رایج:
    // { ok:true, success:true } یا { success:true } یا { human:true }
    if (data.ok === true || data.success === true || data.human === true || data.valid === true) return true;

    // اگر worker جزئیات گوگل را هم بدهد:
    if (data.details && data.details.success === true) return true;

    return false;
  }

  function isMessageSuccess(data) {
    if (!data) return false;
    return data.success === true || data.ok === true;
  }

  // ======================
  // Network calls
  // ======================
  async function verifyCaptchaOnWorker(token) {
    // تلاش اصلی: /api/check-captcha
    const primary = await fetchJson(
      CAPTCHA_VERIFY_ENDPOINT,
      { captchaToken: token, page: location.href },
      CAPTCHA_TIMEOUT_MS
    );

    // اگر مسیر اشتباه بود، fallback: خود روت worker
    if (!primary.ok && (primary.status === 404 || primary.status === 405)) {
      const fallback = await fetchJson(
        WORKER_BASE,
        { captchaToken: token, page: location.href },
        CAPTCHA_TIMEOUT_MS
      );
      return fallback;
    }

    return primary;
  }

  async function sendMessageToWorker(payload) {
    const primary = await fetchJson(MESSAGE_ENDPOINT, payload, MESSAGE_TIMEOUT_MS);

    // fallback: اگر endpoint جدا نبود
    if (!primary.ok && (primary.status === 404 || primary.status === 405)) {
      const fallback = await fetchJson(`${WORKER_BASE}/api/contact`, payload, MESSAGE_TIMEOUT_MS);
      return fallback;
    }

    return primary;
  }

  // ======================
  // Submit flow
  // ======================
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    // روی همان بخش بمان
    if (contactSection) {
      try {
        contactSection.scrollIntoView({ behavior: "auto", block: "start" });
      } catch (_) {}
    }

    // قرنطینه؟
    if (isQuarantined()) {
      openModal("خطا", quarantineMessage(minutesLeft(getQuarantineUntil())), null);
      return;
    }

    // Validation
    if (!validateInputsOnly()) return;

    const prevDisabled = sendBtn?.disabled;
    if (sendBtn) sendBtn.disabled = true;

    try {
      const token = captchaToken();

      // 1) Verify captcha
      const capRes = await verifyCaptchaOnWorker(token);

      if (!capRes.ok || !isCaptchaPositive(capRes.data)) {
        resetCaptcha();
        openModal("خطا", "لطفا تایید کنید که ربات نیستید!", null);
        return;
      }

      // 2) Send message (to Worker)
      const payload = {
        name: normalizeSpaces(nameEl.value),
        email: String(emailEl.value || "").trim(),
        message: String(msgEl.value || "").trim(),
        captchaToken: token,
        page: location.href,
        source: "asanrooz-landing",
        userAgent: navigator.userAgent || "",
        ts: new Date().toISOString(),
      };

      const sendRes = await sendMessageToWorker(payload);

      if (!sendRes.ok || !isMessageSuccess(sendRes.data)) {
        // اگر worker پیغام خطای خاص داد، همینجا می‌تونی نمایش بدی
        openModal("خطا", "مشکلی در روند ارسال پیام رخ داد! لطفا بعدا دوباره امتحان کنید.", null);
        return;
      }

      // ✅ success: ثبت موفقیت برای قرنطینه
      registerSuccessfulSend();

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
    } catch (err) {
      openModal("خطا", "مشکلی در روند ارسال پیام رخ داد! لطفا بعدا دوباره امتحان کنید.", null);
    } finally {
      if (sendBtn) sendBtn.disabled = prevDisabled || false;
    }
  });

  // Optional: Debug in console (helps)
  console.info("[asanrooz] Worker base:", WORKER_BASE);
  console.info("[asanrooz] captcha endpoint:", CAPTCHA_VERIFY_ENDPOINT);
  console.info("[asanrooz] message endpoint:", MESSAGE_ENDPOINT);
})();
