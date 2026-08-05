/* =========================================================
   طفّيها — script.js
   منطق الواجهة، الاتصال بالـ API، واختيار الموقع الجغرافي.
   ========================================================= */

"use strict";

/* ---------------------------------------------------------
   0. إعداد عام
   --------------------------------------------------------- */

// عنوان الـ API — يجب استبداله بعنوان الخادم الفعلي عند النشر. PROD
const API_BASE = "https://teffiha.onrender.com";

/* ---------------------------------------------------------
   1. بيانات الولايات والبلديات (58 ولاية)
   ملاحظة: القائمة أدناه تغطي أهم بلديات كل ولاية لتشغيل
   القوائم المنسدلة. يُنصح باستكمالها ببيانات رسمية كاملة
   (1541 بلدية) من وزارة الداخلية عند التوسع في المشروع.
   --------------------------------------------------------- */
let WILAYAS_DATA = [];

const SEVERITY_TO_LEVEL = {
  "حريق صغير": "low",
  "بدأ يخرج عن السيطرة": "mid",
  "خارج عن السيطرة": "high",
};

/* ---------------------------------------------------------
   2. أدوات مساعدة عامة
   --------------------------------------------------------- */

function qs(selector, scope = document) {
  return scope.querySelector(selector);
}

function qsa(selector, scope = document) {
  return Array.from(scope.querySelectorAll(selector));
}

function formatDate(value) {
  try {
    const date = new Date(value);
    return new Intl.DateTimeFormat("ar-DZ", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch (err) {
    return value;
  }
}

async function loadWilayasData() {
  try {
    const response = await fetch("./data/algeria.json");

    if (!response.ok)
      throw new Error("Failed to load wilaya data.");

    const data = await response.json();

    // Group communes by wilaya
    const grouped = {};

    data.forEach(item => {
      if (!grouped[item.wilaya_code]) {
        grouped[item.wilaya_code] = {
          code: item.wilaya_code,
          name: item.wilaya_name,
          communes: []
        };
      }

      grouped[item.wilaya_code].communes.push(item.commune_name);
    });

    // Remove duplicate communes and sort by code
    WILAYAS_DATA = Object.values(grouped)
      .map(w => ({
        ...w,
        communes: [...new Set(w.communes)]
      }))
      .sort((a, b) => Number(a.code) - Number(b.code));

  } catch (err) {
    console.error("Could not load wilayas:", err);
  }
}

function fillWilayaSelect(selectEl, placeholder) {
  if (!selectEl) return;
  const fragment = document.createDocumentFragment();
  const placeholderOption = document.createElement("option");
  placeholderOption.value = "";
  placeholderOption.textContent = placeholder;
  fragment.appendChild(placeholderOption);

  WILAYAS_DATA.forEach((wilaya) => {
    const option = document.createElement("option");
    // incidents.wilaya is a smallint in the database, so the option value is the
    // numeric code ("16"), not the Arabic name — the name is only for display.
    option.value = wilaya.code;
    option.textContent = `${wilaya.code} - ${wilaya.name}`;
    fragment.appendChild(option);
  });

  selectEl.innerHTML = "";
  selectEl.appendChild(fragment);
}

function fillCommuneSelect(selectEl, wilayaCode, options = {}) {
  if (!selectEl) return;
  const { allowAll = false } = options;

  selectEl.innerHTML = "";

  if (!wilayaCode) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "اختر الولاية أولاً";
    selectEl.appendChild(placeholder);
    selectEl.disabled = true;
    return;
  }

  const wilaya = WILAYAS_DATA.find((w) => w.code === wilayaCode);
  const fragment = document.createDocumentFragment();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = allowAll ? "كل البلديات" : "اختر البلدية";
  fragment.appendChild(placeholder);

  (wilaya ? wilaya.communes : []).forEach((commune) => {
    const option = document.createElement("option");
    option.value = commune;
    option.textContent = commune;
    fragment.appendChild(option);
  });

  selectEl.appendChild(fragment);
  selectEl.disabled = false;
}

// The API returns wilaya as a plain number (e.g. 16). Map it back to the
// Arabic name for display using the same WILAYAS_DATA list used for the dropdowns.
function getWilayaName(wilayaCode) {
  const paddedCode = String(wilayaCode).padStart(2, "0");
  const wilaya = WILAYAS_DATA.find((w) => w.code === paddedCode);
  return wilaya ? wilaya.name : `ولاية ${wilayaCode}`;
}

/* ---------------------------------------------------------
   3. القائمة المنسدلة على الجوال
   --------------------------------------------------------- */

function initMobileNav() {
  const toggle = qs("#navToggle");
  const nav = qs("#mainNav");
  if (!toggle || !nav) return;

  toggle.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(isOpen));
  });

  qsa("a", nav).forEach((link) => {
    link.addEventListener("click", () => {
      nav.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });
}

/* ---------------------------------------------------------
   4. صفحة الرئيسية: التصفية، البلاغات، الإحصائيات
   --------------------------------------------------------- */

function initHomePage() {
  const grid = qs("#incidentGrid");
  if (!grid) return; // ليست صفحة الرئيسية

  const filterWilaya = qs("#filterWilaya");
  const filterCommune = qs("#filterCommune");
  const filtersForm = qs("#filtersForm");
  const resultCount = qs("#resultCount");

  fillWilayaSelect(filterWilaya, "كل الولايات");

  filterWilaya.addEventListener("change", () => {
    fillCommuneSelect(filterCommune, filterWilaya.value, { allowAll: true });
  });

  filtersForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const params = {
      wilaya: filterWilaya.value,
      commune: filterCommune.value,
      severity: qs("#filterSeverity").value,
      service: qs("#filterService").value,
    };
    loadIncidents(params);
  });

  initDetailsModal();
  loadIncidents({});
}

async function loadIncidents(filters) {
  const grid = qs("#incidentGrid");
  const resultCount = qs("#resultCount");

  grid.innerHTML = `
    <div class="skeleton"></div>
    <div class="skeleton"></div>
    <div class="skeleton"></div>
  `;
  resultCount.textContent = "جارٍ تحميل البلاغات...";

  const query = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value) query.set(key, value);
  });

  try {
    const response = await fetch(`${API_BASE}/incidents?${query.toString()}`);
    if (!response.ok) throw new Error("تعذر الاتصال بالخادم");
    const incidents = await response.json();
    renderIncidents(Array.isArray(incidents) ? incidents : incidents.data || []);
    updateStatistics(Array.isArray(incidents) ? incidents : incidents.data || []);
  } catch (error) {
    grid.innerHTML = `
      <div class="state-message">
        <strong>تعذّر تحميل البلاغات</strong>
        يرجى التأكد من اتصالك بالإنترنت أو المحاولة لاحقًا. (${escapeHtml(error.message)})
      </div>
    `;
    resultCount.textContent = "—";
    updateStatistics([]);
  }
}

function renderIncidents(incidents) {
  const grid = qs("#incidentGrid");
  const resultCount = qs("#resultCount");

  if (!incidents || incidents.length === 0) {
    grid.innerHTML = `
      <div class="state-message">
        <strong>لا توجد بلاغات مطابقة</strong>
        جرّب تعديل معايير التصفية أو أعد المحاولة لاحقًا.
      </div>
    `;
    resultCount.textContent = "0 بلاغ";
    return;
  }

  resultCount.textContent = `${incidents.length} بلاغ`;

  grid.innerHTML = incidents
    .map((incident, index) => {
      const level = SEVERITY_TO_LEVEL[incident.severity] || "low";
      const services = Array.isArray(incident.services) ? incident.services : [];
      return `
        <article class="incident-card" data-severity="${level}">
          <div class="incident-card-top">
            <span class="badge badge--${level}">${escapeHtml(incident.severity || "غير محدد")}</span>
            <span class="incident-date">${formatDate(incident.createdAt || incident.date || Date.now())}</span>
          </div>
          <div class="incident-card-location">
            <h3>${escapeHtml(getWilayaName(incident.wilaya))}</h3>
            <span>${escapeHtml(incident.commune || "")}</span>
          </div>
          <div class="incident-services">
            ${services.map((service) => `<span class="chip">${escapeHtml(service)}</span>`).join("") || `<span class="chip">لا توجد خدمات محددة</span>`}
          </div>
          <div class="incident-card-footer">
            <button type="button" class="btn btn-outline btn-sm" data-incident-index="${index}">عرض التفاصيل</button>
          </div>
        </article>
      `;
    })
    .join("");

  grid.dataset.incidents = JSON.stringify(incidents);

  qsa("[data-incident-index]", grid).forEach((button) => {
    button.addEventListener("click", () => {
      const all = JSON.parse(grid.dataset.incidents || "[]");
      const incident = all[Number(button.dataset.incidentIndex)];
      openDetailsModal(incident);
    });
  });
}

function updateStatistics(incidents) {
  const statTotal = qs("#statTotal");
  const statToday = qs("#statToday");
  const statCritical = qs("#statCritical");
  if (!statTotal) return;

  const today = new Date().toDateString();

  const total = incidents.length;
  const todayCount = incidents.filter((incident) => {
    const date = incident.createdAt || incident.date;
    return date && new Date(date).toDateString() === today;
  }).length;
  const criticalCount = incidents.filter((incident) => incident.severity === "خارج عن السيطرة").length;

  statTotal.textContent = total.toLocaleString("ar-DZ");
  statToday.textContent = todayCount.toLocaleString("ar-DZ");
  statCritical.textContent = criticalCount.toLocaleString("ar-DZ");
}

function initDetailsModal() {
  const modal = qs("#detailsModal");
  if (!modal) return;
  bindModalCloseEvents(modal);
}

function openDetailsModal(incident) {
  const modal = qs("#detailsModal");
  const body = qs("#detailsModalBody");
  if (!modal || !body || !incident) return;

  const services = Array.isArray(incident.services) ? incident.services.join("، ") : "—";

  body.innerHTML = `
    <div class="detail-row"><span>الولاية</span><span>${escapeHtml(getWilayaName(incident.wilaya))}</span></div>
    <div class="detail-row"><span>البلدية</span><span>${escapeHtml(incident.commune || "—")}</span></div>
    <div class="detail-row"><span>درجة الخطورة</span><span>${escapeHtml(incident.severity || "—")}</span></div>
    <div class="detail-row"><span>الخدمات المطلوبة</span><span>${escapeHtml(services)}</span></div>
    <div class="detail-row">
    <span>الموقع الجغرافي</span>
    <span>
        ${
          incident.latitude && incident.longitude
            ? `<a href="https://www.google.com/maps?q=${incident.latitude},${incident.longitude}"
                 target="_blank"
                 rel="noopener noreferrer"
                 style="color: blue">
                 عرض على خرائط Google
               </a>`
            : "غير متوفر"
        }
    </span>
</div>
    <div class="detail-row"><span>تاريخ البلاغ</span><span>${formatDate(incident.createdAt || incident.date || Date.now())}</span></div>
    ${incident.notes ? `<div class="detail-row"><span>ملاحظات</span><span>${escapeHtml(incident.notes)}</span></div>` : ""}
  `;

  modal.classList.add("is-open");
}

function bindModalCloseEvents(modal) {
  qsa("[data-close-modal]", modal).forEach((el) => {
    el.addEventListener("click", () => modal.classList.remove("is-open"));
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.classList.remove("is-open");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") modal.classList.remove("is-open");
  });
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

/* ---------------------------------------------------------
   4.1 نافذة إشعار صغيرة منبثقة (Toast) — بدون أي مكتبات خارجية
   تُستخدم لإعلام المستخدم بنجاح إرسال البلاغ أو بحدوث خطأ.
   التنسيقات مُضمّنة هنا مباشرة عبر <style> بحيث لا حاجة لتعديل style.css.
   --------------------------------------------------------- */
function ensureToastContainer() {
  let container = document.getElementById("toastContainer");
  if (container) return container;

  if (!document.getElementById("toastStyles")) {
    const style = document.createElement("style");
    style.id = "toastStyles";
    style.textContent = `
      #toastContainer {
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 9999;
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: min(92vw, 380px);
        pointer-events: none;
      }
      #toastContainer .toast {
        pointer-events: auto;
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 14px 16px;
        border-radius: 8px;
        font-family: inherit;
        font-size: 0.92rem;
        line-height: 1.5;
        color: #fff;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
        animation: toast-in 0.25s ease-out;
        direction: rtl;
        text-align: right;
      }
      #toastContainer .toast--success { background: #1f9d55; }
      #toastContainer .toast--error { background: #d64545; }
      #toastContainer .toast.is-leaving { animation: toast-out 0.2s ease-in forwards; }
      #toastContainer .toast-close {
        margin-inline-start: auto;
        background: none;
        border: none;
        color: inherit;
        font-size: 1rem;
        line-height: 1;
        cursor: pointer;
        opacity: 0.85;
        padding: 0;
      }
      #toastContainer .toast-close:hover { opacity: 1; }
      @keyframes toast-in {
        from { opacity: 0; transform: translateY(-10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes toast-out {
        from { opacity: 1; transform: translateY(0); }
        to { opacity: 0; transform: translateY(-10px); }
      }
    `;
    document.head.appendChild(style);
  }

  container = document.createElement("div");
  container.id = "toastContainer";
  container.setAttribute("aria-live", "polite");
  document.body.appendChild(container);
  return container;
}

function showToast(message, type = "success", duration = 5000) {
  const container = ensureToastContainer();

  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");

  const text = document.createElement("span");
  text.textContent = message;
  toast.appendChild(text);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "toast-close";
  closeBtn.setAttribute("aria-label", "إغلاق الإشعار");
  closeBtn.textContent = "✕";
  toast.appendChild(closeBtn);

  let timer;
  const remove = () => {
    clearTimeout(timer);
    toast.classList.add("is-leaving");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  };

  closeBtn.addEventListener("click", remove);
  timer = setTimeout(remove, duration);

  container.appendChild(toast);
}

/* ---------------------------------------------------------
   5. صفحة الإبلاغ عن حادث
   --------------------------------------------------------- */

function initReportPage() {
  const form = qs("#incidentForm");
  if (!form) return; // ليست صفحة الإبلاغ

  const wilayaSelect = qs("#wilaya");
  const communeSelect = qs("#commune");

  fillWilayaSelect(wilayaSelect, "اختر الولاية");
  wilayaSelect.addEventListener("change", () => {
    fillCommuneSelect(communeSelect, wilayaSelect.value);
  });

  const state = {
    latitude: null,
    longitude: null,
  };

  initLocationControls(state);
  initFormSubmit(form, state);
}

/* --- 5.1 الموقع الجغرافي --- */

function initLocationControls(state) {
  const useCurrentBtn = qs("#useCurrentLocationBtn");
  const chooseOnMapBtn = qs("#chooseOnMapBtn");
  const locationResult = qs("#locationResult");
  const locationError = qs("#locationError");
  const locationSpinner = qs("#locationSpinner");

  useCurrentBtn.addEventListener("click", () => {
    locationError.textContent = "";

    if (!("geolocation" in navigator)) {
      locationError.textContent = "المتصفح لا يدعم تحديد الموقع الجغرافي.";
      return;
    }

    locationSpinner.hidden = false;
    useCurrentBtn.disabled = true;

    navigator.geolocation.getCurrentPosition(
      (position) => {
        state.latitude = position.coords.latitude;
        state.longitude = position.coords.longitude;
        showLocationResult(state);
        locationSpinner.hidden = true;
        useCurrentBtn.disabled = false;
      },
      (error) => {
        locationSpinner.hidden = true;
        useCurrentBtn.disabled = false;
        if (error.code === error.PERMISSION_DENIED) {
          locationError.textContent = "تم رفض إذن الوصول إلى الموقع. يمكنك اختيار الموقع يدويًا من الخريطة.";
        } else {
          locationError.textContent = "تعذّر تحديد الموقع الحالي. حاول مجددًا أو اختر الموقع من الخريطة.";
        }
      }
    );
  });

  chooseOnMapBtn.addEventListener("click", () => {
    openMapPicker(state);
  });

  function showLocationResult(s) {
    locationResult.textContent = `تم تحديد الموقع: ${s.latitude.toFixed(5)}, ${s.longitude.toFixed(5)}`;
    locationResult.classList.add("is-visible");
  }

  // نجعل الدالة متاحة لاستخدامها من مكان اختيار الخريطة أيضًا
  state.showLocationResult = showLocationResult;
}

let leafletMapInstance = null;
let leafletMarkerInstance = null;

function openMapPicker(state) {
  const modal = qs("#mapModal");
  const coordsLabel = qs("#mapCoordsLabel");
  modal.classList.add("is-open");
  bindModalCloseEvents(modal);

  // تهيئة الخريطة مرة واحدة فقط
  if (!leafletMapInstance && window.L) {
    leafletMapInstance = L.map("map-picker").setView([28.0339, 1.6596], 5); // مركز الجزائر تقريبًا

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
      maxZoom: 18,
    }).addTo(leafletMapInstance);

    leafletMapInstance.on("click", (event) => {
      const { lat, lng } = event.latlng;
      placeMarker(lat, lng);
    });
  } else if (leafletMapInstance) {
    // إعادة ضبط حجم الخريطة عند إعادة فتحها داخل نافذة منبثقة
    setTimeout(() => leafletMapInstance.invalidateSize(), 50);
  }

  function placeMarker(lat, lng) {
    if (leafletMarkerInstance) {
      leafletMarkerInstance.setLatLng([lat, lng]);
    } else {
      leafletMarkerInstance = L.marker([lat, lng]).addTo(leafletMapInstance);
    }
    coordsLabel.textContent = `الإحداثيات المختارة: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    coordsLabel.dataset.lat = lat;
    coordsLabel.dataset.lng = lng;
  }

  const confirmBtn = qs("#confirmMapLocation");
  confirmBtn.onclick = () => {
    if (coordsLabel.dataset.lat && coordsLabel.dataset.lng) {
      state.latitude = parseFloat(coordsLabel.dataset.lat);
      state.longitude = parseFloat(coordsLabel.dataset.lng);
      state.showLocationResult(state);
      modal.classList.remove("is-open");
    } else {
      coordsLabel.textContent = "يرجى الضغط على الخريطة أولاً لتحديد الموقع.";
    }
  };
}

/* --- 5.2 إرسال النموذج --- */

function initFormSubmit(form, state) {
  const submitBtn = qs("#submitBtn");
  const submitSpinner = qs("#submitSpinner");
  const submitLabel = qs("#submitLabel");
  const formMessage = qs("#formMessage");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearErrors();

    const isValid = validateForm();
    if (!isValid) {
      showToast("يرجى تصحيح الأخطاء في النموذج قبل الإرسال.", "error");
      return;
    }

    setSubmitting(true);
    formMessage.className = "form-message";
    formMessage.textContent = "";

    console.log('submitted')
    try {
      const payload = buildPayload();
      console.log('api base is ' + API_BASE);
      const response = await fetch(`${API_BASE}/incidents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) throw new Error("رفض الخادم الطلب، حاول مجددًا لاحقًا");

      formMessage.textContent = "تم إرسال البلاغ بنجاح. شكرًا لمساهمتك في حماية المجتمع.";
      formMessage.classList.add("success", "is-visible");
      showToast("تم إرسال البلاغ بنجاح. شكرًا لمساهمتك في حماية المجتمع.", "success");
      form.reset();
      fillCommuneSelect(qs("#commune"), "");
      state.latitude = null;
      state.longitude = null;
      qs("#locationResult").classList.remove("is-visible");
    } catch (error) {
      formMessage.textContent = `تعذّر إرسال البلاغ: ${escapeHtml(error.message)}. يرجى التحقق من الاتصال والمحاولة مجددًا.`;
      formMessage.classList.add("error", "is-visible");
      showToast(`تعذّر إرسال البلاغ: ${error.message}`, "error");
    } finally {
      setSubmitting(false);
    }
  });

  function setSubmitting(isSubmitting) {
    submitBtn.disabled = isSubmitting;
    submitSpinner.hidden = !isSubmitting;
    submitLabel.textContent = isSubmitting ? "جارٍ الإرسال..." : "إرسال البلاغ";
  }

  function clearErrors() {
    qsa(".error-text", form).forEach((el) => (el.textContent = ""));
  }

  function validateForm() {
    let valid = true;

    const wilaya = qs("#wilaya");
    const commune = qs("#commune");
    const severity = qs("#severity");
    const services = qsa('input[name="services"]:checked', form);

    if (!wilaya.value) {
      qs("#wilayaError").textContent = "يرجى اختيار الولاية.";
      valid = false;
    }
    if (!commune.value) {
      qs("#communeError").textContent = "يرجى اختيار البلدية.";
      valid = false;
    }
    if (!severity.value) {
      qs("#severityError").textContent = "يرجى تحديد درجة الخطورة.";
      valid = false;
    }
    if (services.length === 0) {
      qs("#servicesError").textContent = "يرجى اختيار خدمة واحدة على الأقل.";
      valid = false;
    }
    // if (state.latitude === null || state.longitude === null) {
    //   qs("#locationError").textContent = "يرجى تحديد الموقع الجغرافي للحادثة.";
    //   valid = false;
    // }

    return valid;
  }

  function buildPayload() {
    const services = qsa('input[name="services"]:checked', form).map((input) => input.value);

    return {
      // wilaya must be a number, matching the "short Wilaya" field on IncidentRequest
      // (the <select> value is the wilaya code as a string, e.g. "16").
      wilaya: parseInt(qs("#wilaya").value, 10),
      commune: qs("#commune").value,
      severity: qs("#severity").value,
      notes: qs("#notes").value || null,
      latitude: state.latitude,
      longitude: state.longitude,
      services,
    };
  }
}

/* ---------------------------------------------------------
   6. نقطة الانطلاق
   --------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", async () => {
  await loadWilayasData();
  
  initMobileNav();
  initHomePage();
  initReportPage();
});