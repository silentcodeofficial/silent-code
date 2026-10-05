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
export const deleteCode = (code) => callBridge({ action: "code_delete", code });

/* ---------------- مطابقة منتج الموقع مع منتج البرنامج ---------------- */

// "No. 07" و "07" و "7" و "no07" كلها تنطبق على بعض
export function normCode(s) {
  let v = String(s ?? "").toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, "");
  v = v.replace(/^no/, "");
  if (/^\d+$/.test(v)) v = String(Number(v));
  return v;
}

function findProductForItem(item, products, webProductMap) {
  // 1) مطابقة محفوظة مسبقًا (اخترتها يدويًا قبل)
  const mappedId = webProductMap && item.product_id != null ? webProductMap[String(item.product_id)] : null;
  if (mappedId && products.some((p) => p.id === mappedId)) return mappedId;
  // 2) بالكود
  const c = normCode(item.code);
  if (c) {
    const byCode = products.filter((p) => normCode(p.code) === c);
    if (byCode.length === 1) return byCode[0].id;
  }
  // 3) بالاسم الإنجليزي
  const n = String(item.name ?? "").trim().toLowerCase();
  if (n) {
    const byName = products.filter((p) => String(p.nameEn ?? "").trim().toLowerCase() === n);
    if (byName.length === 1) return byName[0].id;
  }
  return null;
}

// يرجع لكل صنف بالطلب: { item, productId (أو null لو ما لقينا مطابق) }
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
    paymentMethod: WEB_PAYMENT_METHOD,
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
