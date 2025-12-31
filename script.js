/* script.js — AsanRooz Contact Form (Frontend Only + Backend Connect Ready) */
(function () {
  "use strict";

  // ======================
  // Config
  // ======================
  // اگر API روی همین دامنه است، همین مقدار مناسب است:
  const CONTACT_API_URL = window.ASANROOZ_CONTACT_API_URL || "/api/contact";

  // ورکر چک کپچا (طبق چیزی که گفتی)
  const CAPTCHA_VERIFY_URL =
    window.ASANROOZ_CAPTCHA_VERIFY_URL ||
    "https://asanrooz-check-captcha.mr-rahimi-kiasari.workers.dev";

  // تایم‌اوت‌ها
  const CAPTCHA_TIMEOUT_MS = 12000;
  const CONTACT_TIMEOUT_MS = 15000;

  // حداقل امتیاز انسان بودن (اگر بک‌اندت v3 score برگرداند)
  const MIN_HUMAN_SCORE = 0.5;

  // ======================
  // DOM
  // ======================
  const form = document.getElementById("contactForm");
  const sendBtn = document.getElementById("sendBtn");

  const nameEl = document.getElementById("name");
  const emailEl = document.getElementById("email");
  const msgEl = document.getElementById("message");

  const contactLink = document.getElementById("contactLink");
  const contactSection = document.getElementById("contact");

  const brandLink = document.getElementById("brandLink");
  const brandFrame = document.getElementById("brandFrame");

  // Modal
  const modal = document.getElementById("modal");
  const modalTitle = document.getElementById("modalTitle");
  const modalText = document.getElementById("modalText");
  const modalOk = document.getElementById("modalOk");

  if (!form || !sendBtn || !modal || !modalOk) {
    // اگر ساختار HTML حاضر نبود، بی‌صدا خارج شو
    return;
  }

  // ======================
  // UX / Security-ish
  // ======================
  // Disable right click
  document.addEventListener(
    "contextmenu",
    (e) => e.preventDefault(),
    { capture: true }
  );

  // Prevent selecting/dragging on brand area (images already pointer-events:none in CSS)
  [brandLink, brandFrame].filter(Boolean).forEach((el) => {
    el.addEventListener("dragstart", (e) => e.preventDefault());
    el.addEventListener("selectstart", (e) => e.preventDefault());
  });

  // Smooth scroll to contact (button/link in notice)
  if (contactLink && contactSection) {
    contactLink.addEventListener("click", function (e) {
      e.preventDefault();
      try {
        contactSection.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (_) {
        location.hash = "#contact";
      }
    });
  }

  // ======================
  // Modal logic (with animation classes already in CSS)
  // ======================
  let afterCloseFocusEl = null;
  let pendingAfterCloseAction = null;

  function openModal(title, text, focusEl, afterClose) {
    modalTitle.textContent = title || "پیام";
    modalText.textContent = text || "";
    afterCloseFocusEl = focusEl || null;
    pendingAfterCloseAction = typeof afterClose === "function" ? afterClose : null;

    modal.classList.remove("is-closing");
    modal.classList.add("is-open");

    // focus ok button (does not scroll)
    try {
      modalOk.focus({ preventScroll: true });
    } catch (_) {
      modalOk.focus();
    }

    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    modal.classList.add("is-closing");

    // مدت زمان باید با CSS هماهنگ باشد
    setTimeout(() => {
      modal.classList.remove("is-open", "is-closing");

      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";

      if (pendingAfterCloseAction) {
        const fn = pendingAfterCloseAction;
        pendingAfterCloseAction = null;
        fn();
      } else if (afterCloseFocusEl && typeof afterCloseFocusEl.focus === "function") {
        // برای اینکه صفحه "نپرد" بالای سایت، از preventScroll استفاده می‌کنیم
        try {
          afterCloseFocusEl.focus({ preventScroll: true });
        } catch (_) {
          afterCloseFocusEl.focus();
        }

        // اگر کاربر خطا گرفته، بهتره همان حوالی تماس بماند
        try {
          contactSection?.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (_) {}
      }

      afterCloseFocusEl = null;
    }, 460);
  }

  modalOk.addEventListener("click", closeModal);

  // Esc را بلاک می‌کنیم که فقط با تایید بسته شود
  document.addEventListener("keydown", function (e) {
    if (modal.classList.contains("is-open") && (e.key === "Escape" || e.key === "Esc")) {
      e.preventDefault();
    }
  });

  // ======================
  // Anti-spam / Quarantine (Front-only)
  // ======================
  const LS_SENDS = "asanrooz_contact_sends_v1";
  const LS_QUAR = "asanrooz_contact_quarantine_until_v1";

  const TEN_MIN = 10 * 60 * 1000;
  const ONE_HOUR = 60 * 60 * 1000;

  function now() {
    return Date.now();
  }

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

  function checkAndHandleQuarantine() {
    const until = getQuarantineUntil();
    if (until && until > now()) {
      openModal("خطا", quarantineMessage(minutesLeft(until)), null);
      return true;
    }
    return false;
  }

  function registerSuccessfulSend() {
    const t = now();
    let sends = getSends().filter((x) => t - x <= 2 * ONE_HOUR);
    sends.push(t);
    setSends(sends);

    const last10 = sends.filter((x) => t - x <= TEN_MIN);
    if (last10.length >= 3) {
      setQuarantineUntil(t + ONE_HOUR);
    }
  }

  // ======================
  // Validation Helpers
  // ======================
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

  function validateAndGetPayload() {
    const nameRaw = String(nameEl?.value || "");
    const name = normalizeSpaces(nameRaw);

    const emailRaw = String(emailEl?.value || "");
    const email = emailRaw.trim();

    const messageRaw = String(msgEl?.value || "");
    const messageTrim = messageRaw.trim();

    if (!name) {
      openModal("خطا", "لطفاً نام خود را وارد کنید.", nameEl);
      return null;
    }
    if (!onlyPersianChars(name)) {
      openModal("خطا", "لطفا نام خود را به فارسی وارد کنید.", nameEl);
      return null;
    }
    if (countPersianLetters(name) < 3) {
      openModal("خطا", "نام وارد شده صحیح نیست.", nameEl);
      return null;
    }

    if (!email) {
      openModal("خطا", "ایمیل خود را وارد کنید.", emailEl);
      return null;
    }
    if (!isValidEmailByRules(email)) {
      openModal("خطا", "ایمیل وارد شده صحیح نیست.", emailEl);
      return null;
    }

    if (!messageTrim) {
      openModal("خطا", "پیام خود را وارد کنید.", msgEl);
      return null;
    }
    if (messageTrim.length < 30) {
      openModal("خطا", "متن پیام باید حداقل ۳۰ کاراکتر باشد.", msgEl);
      return null;
    }

    // اسپم: فقط فاصله/سفید
    const messageNoWhitespace = String(messageRaw || "").replace(/\s+/g, "");
    if (messageNoWhitespace.length === 0) {
      openModal("خطا", "لطفا پیام خود را بصورت صحیح بنویسید.", msgEl);
      return null;
    }

    // Captcha must be checked (checkbox token)
    const tok = captchaToken();
    if (!tok) {
      openModal("خطا", "لطفا تایید کنید که ربات نیستید!", null);
      return null;
    }

    return { name, email, message: messageTrim, captchaToken: tok };
  }

  // ======================
  // Network Helpers
  // ======================
  async function fetchJson(url, options, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.max(2000, timeoutMs || 10000));

    try {
      const res = await fetch(url, {
        ...options,
        signal: ctrl.signal,
      });

      const text = await res.text().catch(() => "");
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {
        data = null;
      }

      return { ok: res.ok, status: res.status, data, rawText: text };
    } finally {
      clearTimeout(t);
    }
  }

  function isCaptchaPositive(responseData) {
    // حالت‌های مختلف پاسخ را پوشش می‌دهیم:
    // 1) { success:true }
    // 2) { ok:true }
    // 3) { success:true, score:0.9 }
    // 4) { success:true, human:true/false }
    const d = responseData || {};
    const success = d.success === true || d.ok === true;

    if (!success) return false;

    if (d.human === false) return false;

    if (typeof d.score === "number" && Number.isFinite(d.score)) {
      return d.score >= MIN_HUMAN_SCORE;
    }

    return true;
  }

  async function verifyCaptchaOnWorker(token) {
    // طبق درخواست: "درخواست حاوی دیتای کپچا" ارسال شود
    // تلاش می‌کنیم هم "token" و هم "g-recaptcha-response" را بفرستیم تا با هر بک‌اندی سازگار باشد.
    const body = {
      token,
      "g-recaptcha-response": token,
      page: location.href,
    };

    const r = await fetchJson(
      CAPTCHA_VERIFY_URL,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      CAPTCHA_TIMEOUT_MS
    );

    if (!r.ok) return { ok: false, reason: "network_or_http", detail: r };
    if (!isCaptchaPositive(r.data)) return { ok: false, reason: "not_human", detail: r };

    return { ok: true, detail: r };
  }

  async function sendContactMessage(payload) {
    const body = {
      name: payload.name,
      email: payload.email,
      message: payload.message,
      page: location.href,
      captcha: payload.captchaToken, // برای بک‌اند
    };

    const r = await fetchJson(
      CONTACT_API_URL,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      CONTACT_TIMEOUT_MS
    );

    // انتظار داریم بک‌اند چیزی شبیه { success:true } یا { ok:true } برگرداند
    const d = r.data || {};
    const success = (r.ok && (d.success === true || d.ok === true)) || false;

    return { success, detail: r };
  }

  // ======================
  // Submit Handler
  // ======================
  let isSubmitting = false;

  form.addEventListener("submit", async function (e) {
    e.preventDefault();

    // اگر کاربر خطا داشت، صفحه نباید به بالای سایت بپرد.
    // فقط اگر لازم شد، خیلی ملایم در همان محدوده تماس بماند:
    try {
      contactSection?.scrollIntoView({ behavior: "auto", block: "start" });
    } catch (_) {}

    if (isSubmitting) return;
    if (checkAndHandleQuarantine()) return;

    const payload = validateAndGetPayload();
    if (!payload) return;

    isSubmitting = true;
    sendBtn.disabled = true;

    try {
      // 1) Verify captcha with worker
      const cap = await verifyCaptchaOnWorker(payload.captchaToken);
      if (!cap.ok) {
        // اگر کپچا معتبر نبود/انسان نبود
        resetCaptcha();
        openModal("خطا", "لطفا تایید کنید که ربات نیستید!", null);
        return;
      }

      // 2) Send message to backend (worker)
      const sent = await sendContactMessage(payload);

      if (sent.success) {
        registerSuccessfulSend();

        openModal(
          "توجه",
          "پیام شما را دریافت کردیم و به زودی از طریق ایمیل ثبت شده به آن پاسخ خواهیم داد.",
          null,
          function () {
            // فقط در موفقیت: ریست فرم + ریست کپچا + اسکرول به بالا
            form.reset();
            resetCaptcha();

            try {
              window.scrollTo({ top: 0, behavior: "smooth" });
            } catch (_) {
              window.scrollTo(0, 0);
            }
          }
        );
      } else {
        // عدم موفقیت => فیلدها ریست نشوند
        // اگر بک‌اند پیام فارسی فرستاد و خواستی نمایش بدی، اینجا قابل اضافه کردنه.
        openModal(
          "خطا",
          "مشکلی در روند ارسال پیام رخ داد! لطفا بعدا دوباره امتحان کنید.",
          null
        );
      }
    } catch (_) {
      // خطای شبکه/timeout => فیلدها ریست نشوند
      openModal(
        "خطا",
        "مشکلی در روند ارسال پیام رخ داد! لطفا بعدا دوباره امتحان کنید.",
        null
      );
    } finally {
      sendBtn.disabled = false;
      isSubmitting = false;
    }
  });
})();
