// ربط برنامج المحاسبة بموقع المتجر (Supabase).
// البرنامج يسأل دالة accounting-orders عن الطلبات المدفوعة الجديدة، ويحوّلها لفواتير بيع.
// ما فيه أي مفتاح سري هنا: رابط Supabase والمفتاح العام (anon) قيم عامة بطبيعتها (نفس اللي بكود الموقع)،
// والحماية الفعلية من توكن Firebase اللي يتحقق منه السيرفر + قائمة الإيميلات المسموحة.

import { auth } from "./firebase";

const SUPABASE_URL = "https://giwxseeyklmnzifrvnyn.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdpd3hzZWV5a2xtbnppZnJ2bnluIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0OTIwNjcsImV4cCI6MjEwNTA2ODA2N30.5OFcMwdKCJQgxyz2DNg9qr63FBWgAMJ6RsjI59YZXZo";

export const WEB_PAYMENT_METHOD = "بوابة دفع إلكتروني";

async function callBridge(body) {
  const user = auth.currentUser;
  if (!user) throw new Error("not_signed_in");
  const token = await user.getIdToken();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/accounting-orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "x-firebase-token": token,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `http_${res.status}`);
  return json;
}

export async function pullWebOrders() {
  const json = await callBridge({ action: "pull" });
  return Array.isArray(json.orders) ? json.orders : [];
}

export async function ackWebOrders(refs) {
  if (!refs || refs.length === 0) return 0;
  const json = await callBridge({ action: "ack", refs });
  return json.acked || 0;
}

// متابعة التجهيز: كل الطلبات المدفوعة (الأحدث أولًا) + تغيير حالتها. "تم الشحن" يرسل للعميل إيميل تلقائيًا.
export async function listWebOrders() {
  const json = await callBridge({ action: "orders_list" });
  return Array.isArray(json.orders) ? json.orders : [];
}
export const BANK_TRANSFER_METHOD = "تحويل بنكي - صحار";
export async function listTransfers() {
  const json = await callBridge({ action: "transfers_list" });
  return Array.isArray(json.orders) ? json.orders : [];
}
export async function confirmTransfer(ref) { await callBridge({ action: "transfer_confirm", ref }); }
export async function cancelTransfer(ref) { await callBridge({ action: "transfer_cancel", ref }); }
export async function setWebOrderStatus(ref, status, note, notify = true) {
  const json = await callBridge({ action: "order_set_status", ref, status, note, notify });
  return json.order;
}

export const FULFILLMENT_STATUSES = [
  { id: "new", label: "جديد", cls: "amber" },
  { id: "preparing", label: "قيد التجهيز", cls: "blue" },
  { id: "shipped", label: "تم الشحن", cls: "blue" },
  { id: "delivered", label: "تم التسليم", cls: "green" },
  { id: "cancelled", label: "ملغي", cls: "" },
];

// يرسل "المتاح للبيع" لكل منتج للموقع، فيتحدّث مخزون الموقع (0 = تظهر "نفذت الكمية" للعملاء)
export async function pushWebStock(products) {
  const json = await callBridge({ action: "stock", products });
  return json;
}

// إدارة العروض وأكواد الخصم (تُحفظ بالموقع، والسيرفر هو اللي يطبّقها)
export const listOffers = () => callBridge({ action: "offers_list" });
export const saveOffer = (offer) => callBridge({ action: "offer_save", offer });
export const deleteOffer = (id) => callBridge({ action: "offer_delete", id });
export const saveCode = (code) => callBridge({ action: "code_save", code });
export const listWebProducts = () => callBridge({ action: "web_products" });
export const marketerReport = (month, opts) => callBridge({ action: "marketer_report", month, ...(opts || {}) });
export const deleteCode = (code) => callBridge({ action: "code_delete", code });

/* ---------------- مطابقة منتج الموقع مع منتج البرنامج ---------------- */

// "No. 07" و "07" و "7" و "no07" كلها تنطبق على بعض
export function normCode(s) {
  let v = String(s ?? "").toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, "");
  v = v.replace(/^no/, "");
  if (/^\d+$/.test(v)) v = String(Number(v));
  return v;
}

// تطبيع الأسماء للمقارنة: حروف صغيرة، بدون مسافات/تشكيل/علامات، وألف موحّدة
function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[^a-z0-9\u0600-\u06FF]/g, "");
}

function findProductForItem(item, products, webProductMap) {
  // 1) ربط محفوظ مسبقًا (تلقائي أو يدوي)
  const mappedId = webProductMap && item.product_id != null ? webProductMap[String(item.product_id)] : null;
  if (mappedId && products.some((p) => p.id === mappedId)) return mappedId;
  // 2) بالكود (نفس الكود تمامًا بعد التطبيع)
  for (const code of [item.code, item.web_code]) {
    const c = normCode(code);
    if (c) {
      const byCode = products.filter((p) => normCode(p.code) === c);
      if (byCode.length === 1) return byCode[0].id;
    }
  }
  // 3) بالاسم: إنجليزي أو عربي، مقارنة مطبّعة
  const webNames = [item.name, item.web_name_en, item.web_name_ar].map(normName).filter(Boolean);
  if (webNames.length) {
    const byName = products.filter((p) => [p.nameEn, p.name].map(normName).some((n) => n && webNames.includes(n)));
    if (byName.length === 1) return byName[0].id;
  }
  return null;
}

// ننشئ منتج في البرنامج من منتج الموقع لما ما نلقى له مقابل (عشان ما تحتاج تطابق يدويًا)
export function productFromWebItem(item, products, makeId) {
  const codes = new Set((products || []).map((p) => normCode(p.code)));
  let code = String(item.web_code ?? item.code ?? "").trim();
  if (!code || codes.has(normCode(code))) code = `WEB-${String(item.product_id ?? "").slice(0, 6) || Date.now().toString(36)}`;
  const nameAr = String(item.web_name_ar ?? "").trim();
  const nameEn = String(item.web_name_en ?? item.name ?? "").trim();
  const price = item.web_price != null ? Number(item.web_price) : (Number(item.original_unit_amount) || Number(item.unit_amount) || 0) / 1000;
  return {
    id: makeId("prod"), code, name: nameAr || nameEn || code, nameEn, category: "عطر", type: "manufactured",
    sellingPrice: Number.isFinite(price) ? price : 0, batchYield: 1, recipe: [], autoFromWeb: true,
  };
}

// ربط مؤكَّد فقط (من جدول الربط المحفوظ) — هذا اللي يسمح بالاستيراد التلقائي
export function matchWebItemsStrict(order, products, webProductMap) {
  return (order.items || []).map((item) => {
    const id = webProductMap && item.product_id != null ? webProductMap[String(item.product_id)] : null;
    return { item, productId: id && (products || []).some((p) => p.id === id) ? id : null };
  });
}

// اقتراح ربط منتج برنامج مع منتج موقع (بالكود أو الاسم) — للعرض فقط، ما ينحفظ إلا بتأكيد المستخدم
export function suggestWebProduct(prod, webProducts) {
  const c = normCode(prod.code);
  if (c) {
    const hit = (webProducts || []).filter((w) => normCode(w.code) === c);
    if (hit.length === 1) return hit[0].id;
  }
  const names = [prod.nameEn, prod.name].map(normName).filter(Boolean);
  const hit = (webProducts || []).filter((w) => [w.name_en, w.name_ar].map(normName).some((n) => n && names.includes(n)));
  return hit.length === 1 ? hit[0].id : "";
}

export function matchWebItems(order, products, webProductMap) {
  return (order.items || []).map((item) => ({
    item,
    productId: findProductForItem(item, products || [], webProductMap || {}),
  }));
}

/* ---------------- تحويل الطلب لفاتورة بيع ---------------- */

export function muscatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Muscat" }); // YYYY-MM-DD
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

// matches: [{ item, productId }] — كلها لازم يكون لها productId
export function buildInvoiceFromWebOrder(order, matches, nextNo, makeId) {
  const discountAmount = Number(order.discount_amount) || 0;
  const noteParts = [`طلب من الموقع ${order.client_reference_id}`];
  if (order.discount_code) noteParts.push(`كود خصم ${order.discount_code}`);
  const offerNames = [...new Set((order.items || []).map((i) => i.offer_name).filter(Boolean))];
  if (offerNames.length) noteParts.push(`عرض: ${offerNames.join("، ")}`);
  return {
    id: makeId("inv"),
    number: nextNo,
    date: muscatDate(order.created_at),
    customerName: order.customer_name || "",
    customerPhone: order.phone || "",
    customerEmail: order.email || "",
    customerCountry: order.country_code || "",
    discountCode: order.discount_code || "",
    // لقطة عمولة المسوّق وقت البيع (ما تتغير لو غيّرت نسبة الكود بعدين)
    marketer: order.marketer && order.marketer.name
      ? { code: order.marketer.code || order.discount_code || "", name: order.marketer.name, type: order.marketer.type === "fixed" ? "fixed" : "percent", percent: Number(order.marketer.percent) || 0, fixed: Number(order.marketer.fixed) || 0 }
      : null,
    webInvoiceNumber: order.invoice_number || "", // رقم الفاتورة اللي وصل للعميل بالإيميل (SC-00001)
    invoiceLang: order.lang === "en" ? "en" : "ar",
    paymentMethod: order.payment_method === "bank_transfer" ? BANK_TRANSFER_METHOD : WEB_PAYMENT_METHOD,
    shippingFee: (Number(order.shipping_fee) || 0) / 1000, // بيسة → ريال (تمرير لشركة الشحن)
    note: noteParts.join(" — "),
    discountType: "fixed",
    discountValue: discountAmount > 0 ? discountAmount : "",
    deliveryType: "delivery",
    deliveryAddress: order.delivery_address || "",
    overheadUsage: [],
    items: matches.map((m) => {
      const qty = Number(m.item.quantity) || 0;
      const paid = Number(m.item.unit_amount) || 0;
      const orig = Number(m.item.original_unit_amount) || 0;
      // لو الصنف عليه عرض: نسجّل السعر الأصلي وخصم العرض كخصم على السطر، فتبان قيمة الخصم بالفاتورة
      const hasOffer = orig > paid;
      return {
        id: makeId("it"),
        productId: m.productId,
        qty,
        unitPrice: (hasOffer ? orig : paid) / 1000, // بيسة → ريال عماني
        discount: hasOffer ? Math.round((orig - paid) * qty) / 1000 : "",
        free: false,
      };
    }),
    source: "website",
    webOrderRef: order.client_reference_id,
    createdBy: "الموقع الإلكتروني",
  };
}
