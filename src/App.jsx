import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  LayoutDashboard, Boxes, Factory, Package, Receipt, Megaphone, AlertTriangle,
  Building2, Settings as SettingsIcon, Plus, Trash2, Printer, X, TrendingUp,
  TrendingDown, Loader2, ChevronLeft, Users, PackageX, Sparkles, AlertCircle,
  ShoppingCart, Wallet, Pencil, Wrench, FileText, Globe, RefreshCw, PackageCheck, ShieldCheck
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, Legend
} from "recharts";
import { loadAppData, saveAppData, defaultAppData, watchAuth, signIn, signOutUser, resetPassword, ensureDailyBackup, listBackupDates, loadBackup } from "./firebase";
import { uploadToGoogleDrive, deleteFromGoogleDrive } from "./googleDrive";
import { pullWebOrders, ackWebOrders, pushWebStock, matchWebItems, matchWebItemsStrict, suggestWebProduct, listWebProducts, buildInvoiceFromWebOrder, muscatDate, listOffers, saveOffer, deleteOffer, saveCode, deleteCode, marketerReport, listWebOrders, setWebOrderStatus, listTransfers, confirmTransfer, cancelTransfer, FULFILLMENT_STATUSES } from "./webOrders";

/* ============================== helpers ============================== */

const uid = (p = "id") => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const fmt = (n) => {
  const v = Number(n) || 0;
  return v.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
};
const pct = (n) => `${(Number(n) || 0).toFixed(1)}%`;
const todayStr = () => new Date().toISOString().slice(0, 10);

const UNITS = ["مل", "جرام", "قطعة"];
const AED_RATE = 0.105; // 1000 AED = 105 OMR

/* ---- purchase invoice attachments: compress images and wrap them into a
   single-page PDF client-side before uploading, so Google Drive only
   ever receives small, consistent PDF files regardless of the original
   photo's size. Existing PDFs are uploaded as-is. ---- */

async function imageFileToCompressedPdfBlob(file) {
  const { jsPDF } = await import("jspdf");
  const imgBitmap = await createImageBitmap(file);
  const maxDim = 1600;
  let { width, height } = imgBitmap;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  width = Math.round(width * scale);
  height = Math.round(height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(imgBitmap, 0, 0, width, height);
  const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.6);
  const orientation = width >= height ? "l" : "p";
  const pdf = new jsPDF({ orientation, unit: "px", format: [width, height] });
  pdf.addImage(jpegDataUrl, "JPEG", 0, 0, width, height);
  return pdf.output("blob");
}

async function prepareInvoiceFileForUpload(file) {
  if (file.type === "application/pdf") return file;
  if (file.type.startsWith("image/")) return imageFileToCompressedPdfBlob(file);
  return file; // unknown type, upload as-is
}

function sanitizeForFileName(s) {
  return String(s || "").replace(/[^\w\u0600-\u06FF-]+/g, "_").slice(0, 60);
}

function buildPurchaseFileName(purchase, materials, label) {
  const num = purchase.number || "بدون_رقم";
  const date = purchase.date || todayStr();
  const matNames = (purchase.lines || [])
    .filter((l) => l.materialId)
    .map((l) => materials.find((m) => m.id === l.materialId)?.name)
    .filter(Boolean)
    .slice(0, 3)
    .join("-");
  const details = label || matNames || "شراء";
  const unique = uid("att");
  return `شراء-${sanitizeForFileName(num)}-${sanitizeForFileName(date)}-${sanitizeForFileName(details)}-${unique}.pdf`;
}
const toOMR = (amount, currency) => (currency === "AED" ? (Number(amount) || 0) * AED_RATE : Number(amount) || 0);

/* ---- cost engine ---- */

function allocatePurchaseLines(lines, extraCosts) {
  const totalExtra = extraCosts.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const totalBase = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0);
  return lines.map((l) => {
    const base = (Number(l.qty) || 0) * (Number(l.unitCost) || 0);
    const share = totalBase > 0 ? (base / totalBase) * totalExtra : totalExtra / (lines.length || 1);
    const landedTotal = base + share;
    const qty = Number(l.qty) || 0;
    return { ...l, landedTotal, landedUnitCost: qty > 0 ? landedTotal / qty : 0 };
  });
}

/* ---- material ledger: دقة تعديل/حذف المشتريات ----
   المخزون ومتوسط التكلفة لكل مادة = نتيجة تسلسل أحداث بالترتيب الزمني (شراء يزيد، استهلاك ينقص).
   عند تعديل شراء: نرجع للحالة الأساسية قبل كل الأحداث (من الحالة الحالية)، ونعيد تشغيل الأحداث كلها بنسخة الشراء الجديدة. */
const LEDGER_EPS = 1e-9;
function ledgerRound(n) { return Number((Number(n) || 0).toFixed(6)); }

function applyBuy(stock, avg, qty, unit) {
  const w = Math.max(stock, 0);
  const total = w + qty;
  return { stock: stock + qty, avg: total > 0 ? (w * avg + qty * unit) / total : avg };
}

function materialEvents(data, materialId) {
  const ev = [];
  let n = 0;
  (data.purchases || []).forEach((p) => {
    (p.lines || []).forEach((l) => {
      const qty = Number(l.qty) || 0;
      if (l.materialId === materialId && qty > 0) ev.push({ kind: "buy", date: p.date || "", ord: 0, n: n++, qty, unit: Number(l.landedUnitCost) || 0 });
    });
  });
  (data.batches || []).forEach((b) => {
    (b.lines || []).forEach((l) => {
      const qty = Number(l.qty) || 0;
      if (l.materialId === materialId && qty > 0) ev.push({ kind: "use", date: b.date || "", ord: 1, n: n++, qty });
    });
  });
  (data.invoices || []).forEach((inv) => {
    (inv.overheadUsage || []).forEach((u) => {
      const qty = Number(u.qty) || 0;
      if (u.materialId === materialId && qty > 0) ev.push({ kind: "use", date: inv.date || "", ord: 1, n: n++, qty });
    });
  });
  return ev.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ord - b.ord || a.n - b.n));
}

function deriveBaseState(events, curStock, curAvg) {
  let stock = curStock, avg = curAvg;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "use") { stock += e.qty; continue; }
    const before = stock - e.qty;
    const w = Math.max(before, 0);
    let prevAvg = avg;
    if (w > 0) {
      const a = ((w + e.qty) * avg - e.qty * e.unit) / w;
      if (Number.isFinite(a) && a >= 0) prevAvg = a;
    }
    stock = before;
    avg = prevAvg;
  }
  return { stock, avg };
}

function replayEvents(events, baseStock, baseAvg) {
  let stock = baseStock, avg = baseAvg, min = baseStock;
  events.forEach((e) => {
    if (e.kind === "use") stock -= e.qty;
    else { const r = applyBuy(stock, avg, e.qty, e.unit); stock = r.stock; avg = r.avg; }
    if (stock < min) min = stock;
  });
  return { stock, avg, min };
}

// newPur = null يعني حذف الشراء. يرجع { materials } أو { error }
function recomputeMaterialsForPurchaseChange(data, oldPur, newPur) {
  const affected = new Set();
  [oldPur, newPur].forEach((p) => (p?.lines || []).forEach((l) => l.materialId && affected.add(l.materialId)));
  const dataAfter = {
    ...data,
    purchases: newPur ? data.purchases.map((p) => (p.id === newPur.id ? newPur : p)) : data.purchases.filter((p) => p.id !== oldPur.id),
  };
  const problems = [];
  const materials = data.materials.map((m) => {
    if (!affected.has(m.id)) return m;
    const curStock = Number(m.stock) || 0;
    const curAvg = Number(m.avgCost) || 0;
    const evOld = materialEvents(data, m.id);
    const base = deriveBaseState(evOld, curStock, curAvg);
    const oldRes = replayEvents(evOld, base.stock, base.avg);
    const newRes = replayEvents(materialEvents(dataAfter, m.id), base.stock, base.avg);
    const dipsNew = newRes.min < -LEDGER_EPS && newRes.min < oldRes.min - LEDGER_EPS;
    const finalNeg = newRes.stock < -LEDGER_EPS && newRes.stock < curStock - LEDGER_EPS;
    if (dipsNew || finalNeg) {
      const shortage = Math.abs(Math.min(newRes.min, newRes.stock));
      problems.push(`«${m.name}» بتصير بالسالب (ناقص ${ledgerRound(shortage)} ${m.unit || ""})`);
    }
    return { ...m, stock: ledgerRound(newRes.stock), avgCost: ledgerRound(newRes.avg) };
  });
  if (problems.length) {
    return { error: "ما قدرت أحفظ — لأن جزء من هذي المواد انستهلك بدفعات إنتاج أو فواتير بعد هذا الشراء، والتعديل بيخلي المخزون ناقص: " + problems.join("، ") + ". عدّل الكمية أو التاريخ بحيث تغطي اللي انستهلك." };
  }
  return { materials };
}

function convertLinesToOMR(lines) {
  return lines.map((l) => ({ ...l, unitCostOriginal: l.unitCost, currency: l.currency || "OMR", unitCost: toOMR(l.unitCost, l.currency) }));
}
function convertExtrasToOMR(extras) {
  return extras.map((e) => ({ ...e, amountOriginal: e.amount, currency: e.currency || "OMR", amount: toOMR(e.amount, e.currency) }));
}

function recipeLineCost(line, materials) {
  const mat = materials.find((m) => m.id === line.materialId);
  return mat ? (Number(line.qty) || 0) * (Number(mat.avgCost) || 0) : 0;
}

function productLiveEstimate(product, materials) {
  const total = (product.recipe || []).reduce((s, l) => s + recipeLineCost(l, materials), 0);
  const y = Number(product.batchYield) || 1;
  return { total, perUnit: total / y };
}

function productReferenceCost(data, productId) {
  const batches = data.batches.filter((b) => b.productId === productId);
  if (batches.length) {
    const totalUnits = batches.reduce((s, b) => s + (Number(b.unitsProduced) || 0), 0);
    const totalCost = batches.reduce((s, b) => s + (Number(b.totalCost) || 0), 0);
    return { unitCost: totalUnits > 0 ? totalCost / totalUnits : 0, source: "batches" };
  }
  const product = data.products.find((p) => p.id === productId);
  if (!product) return { unitCost: 0, source: "none" };
  const est = productLiveEstimate(product, data.materials);
  return { unitCost: est.perUnit, source: "estimate" };
}

/* ---- finished-goods stock available to sell ---- */

function producedQty(data, productId) {
  return data.batches.filter((b) => b.productId === productId).reduce((s, b) => s + (Number(b.unitsProduced) || 0), 0);
}
function soldQtyExcludingInvoice(data, productId, excludeInvoiceId) {
  let qty = 0;
  data.invoices.forEach((inv) => {
    if (inv.id === excludeInvoiceId) return;
    (inv.items || []).forEach((it) => { if (it.productId === productId) qty += Number(it.qty) || 0; });
  });
  return qty;
}
function sampledQty(data, productId) {
  return data.marketing.filter((m) => m.type === "sample" && m.productId === productId).reduce((s, m) => s + (Number(m.qty) || 0), 0);
}
function lostQty(data, productId) {
  return data.losses.filter((l) => l.productId === productId).reduce((s, l) => s + (Number(l.qty) || 0), 0);
}
// المنتج "متتبَّع" لما يكون له إنتاج أو تسوية جرد. غير كذا ما نرسل مخزونه للموقع (عشان ما نصفّره بالغلط).
function isStockTracked(data, productId) {
  return producedQty(data, productId) !== 0 || adjustedQty(data, productId) !== 0;
}
function adjustedQty(data, productId) {
  return (data.stockAdjustments || []).filter((a) => a.productId === productId).reduce((s, a) => s + (Number(a.qty) || 0), 0);
}
function availableToSell(data, productId, excludeInvoiceId) {
  return producedQty(data, productId) + adjustedQty(data, productId) - soldQtyExcludingInvoice(data, productId, excludeInvoiceId) - sampledQty(data, productId) - lostQty(data, productId);
}

function invoiceComputed(inv) {
  const items = (inv.items || []).map((it) => {
    const qty = Number(it.qty) || 0;
    const price = Number(it.unitPrice) || 0;
    const gross = qty * price;
    const lineDiscount = Math.min(Number(it.discount) || 0, gross);
    const afterLineDiscount = gross - lineDiscount;
    return { ...it, qty, price, gross, lineDiscount, afterLineDiscount };
  });
  const subtotal = items.reduce((s, it) => s + it.afterLineDiscount, 0);
  let invoiceDiscountAmount = 0;
  if (inv.discountType === "percent") invoiceDiscountAmount = subtotal * ((Number(inv.discountValue) || 0) / 100);
  else invoiceDiscountAmount = Math.min(Number(inv.discountValue) || 0, subtotal);
  const grandTotal = subtotal - invoiceDiscountAmount;
  const itemsWithNet = items.map((it) => {
    const share = subtotal > 0 ? it.afterLineDiscount / subtotal : 0;
    return { ...it, netRevenue: it.afterLineDiscount - invoiceDiscountAmount * share };
  });
  // الشحن: مبلغ يدفعه العميل لشركة الشحن (تمرير) — ما يدخل الإيراد ولا الضريبة ولا الربح، لكنه يدخل المبلغ المدفوع والحسابات
  const shipping = Math.max(0, Number(inv.shippingFee) || 0);
  return { items: itemsWithNet, subtotal, invoiceDiscountAmount, grandTotal, shipping, totalPaid: grandTotal + shipping };
}

/* ---- printing: fully isolated popup window, independent of the app's own CSS/layout ---- */

const PRINT_LABELS = {
  ar: {
    dir: "rtl", htmlLang: "ar", fontFamily: "'Cairo','Segoe UI',Tahoma,Arial,sans-serif",
    docTitle: "فاتورة بيع", tagline: "صناعة وتغليف العطور",
    customerInfo: "معلومات العميل", delivery: "التسليم", pickup: "استلام من المصنع", deliveryType: "توصيل",
    item: "الصنف", qty: "الكمية", unitPrice: "سعر الوحدة", discount: "خصم", total: "الإجمالي",
    subtotal: "المجموع", shipping: "الشحن", invoiceDiscount: "خصم الفاتورة", grandTotal: "الإجمالي الكلي",
    notes: "ملاحظات", thanks: "شكرًا لثقتكم بنا 🤍", gift: "🎁 هدية", currency: "ر.ع",
    periodTagline: "كشف حساب فترة (للاستخدام الداخلي)", from: "من", to: "إلى",
    invoiceNo: "رقم الفاتورة", customer: "العميل", paymentMethod: "طريقة الدفع", orderRef: "رقم الطلب", paid: "مدفوعة", email: "الإيميل", country: "الدولة",
    byMethod: "التوزيع حسب طريقة الدفع", invoiceCount: "عدد الفواتير",
    invoiceWord: "فاتورة", dateLabel: "التاريخ", billedTo: "الفاتورة إلى", phone: "الجوال", address: "العنوان", grandTotalPaid: "الإجمالي المدفوع",
    thanksBrand: "شكرًا لثقتك بـ Silent Code", footNote: "هذه فاتورة إلكترونية ولا تحتاج توقيعًا. الأسعار بالريال العُماني.",
    legalLine: "أصيل الفخامة ش.م.م · سجل تجاري 1648344 · شناص، سلطنة عُمان",
  },
  en: {
    dir: "ltr", htmlLang: "en", fontFamily: "'Segoe UI',Tahoma,Arial,sans-serif",
    docTitle: "Sales Invoice", tagline: "Perfume Manufacturing & Packaging",
    customerInfo: "Customer Info", delivery: "Delivery", pickup: "Factory Pickup", deliveryType: "Delivery",
    item: "Item", qty: "Qty", unitPrice: "Unit Price", discount: "Discount", total: "Total",
    subtotal: "Subtotal", shipping: "Shipping", invoiceDiscount: "Invoice Discount", grandTotal: "Grand Total",
    notes: "Notes", thanks: "Thank you for your trust 🤍", gift: "🎁 Gift", currency: "OMR",
    periodTagline: "Period Statement (internal use)", from: "From", to: "To",
    invoiceNo: "Invoice No.", customer: "Customer", paymentMethod: "Payment Method", orderRef: "Order", paid: "PAID", email: "Email", country: "Country",
    byMethod: "Breakdown by Payment Method", invoiceCount: "Invoice Count",
    invoiceWord: "Invoice", dateLabel: "Date", billedTo: "Billed to", phone: "Phone", address: "Address", grandTotalPaid: "Total paid",
    thanksBrand: "Thank you for choosing Silent Code", footNote: "This is an electronically generated invoice and needs no signature. Prices in Omani Rial.",
    legalLine: "Pure Luxe LLC · CR 1648344 · Shinas, Sultanate of Oman",
  },
};

// الطباعة تكتب HTML بنافذة جديدة، فأي نص كتبه عميل أو موظف (اسم، عنوان، ملاحظة) لازم يتعقّم قبل ما ينحط فيها
const escHtml = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const PRINT_COUNTRIES = {
  OM: { ar: "عُمان", en: "Oman" }, AE: { ar: "الإمارات", en: "United Arab Emirates" }, SA: { ar: "السعودية", en: "Saudi Arabia" },
  KW: { ar: "الكويت", en: "Kuwait" }, QA: { ar: "قطر", en: "Qatar" }, BH: { ar: "البحرين", en: "Bahrain" },
};
const PRINT_METHOD_EN = { "بوابة دفع إلكتروني": "Online payment (Thawani)", "نقدًا": "Cash", "نقدي": "Cash", "كاش": "Cash", "تحويل بنكي": "Bank transfer" };

function printStyles(lang) {
  const L = PRINT_LABELS[lang];
  const start = lang === "ar" ? "right" : "left";
  const end = lang === "ar" ? "left" : "right";
  return `
  * { box-sizing: border-box; }
  body { font-family: ${L.fontFamily}; direction: ${L.dir}; margin: 0; color: #22302B; background: #fff; }
  .sheet { max-width: 780px; margin: 0 auto; padding: 0 36px 36px; }
  .accent-bar { height: 8px; background: linear-gradient(90deg, #34090e 0 72%, #C79B58 72% 100%); }
  .print-head { padding-top: 26px; padding-bottom: 18px; border-bottom: 1px solid #E3D9C4; margin-bottom: 20px; overflow: hidden; }
  .head-col { display: inline-block; vertical-align: top; width: 48%; }
  .head-brand { text-align: ${start}; }
  .head-meta { text-align: ${end}; float: ${end}; }
  .print-brand { font-weight: 800; font-size: 24px; letter-spacing: 1px; color: #34090e; }
  .print-tagline { font-size: 11px; color: #8A9490; margin-top: 2px; }
  .biz-info { font-size: 11px; color: #6B7770; margin-top: 8px; line-height: 1.8; }
  .biz-info div { margin-bottom: 2px; }
  .doc-title { font-size: 13px; font-weight: 700; color: #6B7770; margin-bottom: 6px; letter-spacing: .5px; }
  .invoice-badge { display: inline-block; background: #34090e; color: #fff; font-weight: 800; font-size: 15px; padding: 5px 14px; border-radius: 999px; margin-bottom: 8px; }
  .print-meta-line { font-size: 12px; color: #444; line-height: 1.9; }
  .info-grid { overflow: hidden; margin-bottom: 20px; }
  .info-box { box-sizing: border-box; display: inline-block; vertical-align: top; width: 48%; background: #F5F0E4; border: 1px solid #E3D9C4; border-radius: 10px; padding: 12px 14px; }
  .info-box.first { float: ${start}; }
  .info-box.second { float: ${end}; }
  .info-box-title { font-size: 10.5px; font-weight: 700; color: #34090e; margin-bottom: 6px; letter-spacing: .3px; }
  .info-box div.row { font-size: 12.5px; color: #333; line-height: 1.8; }
  table.items { width: 100%; border-collapse: collapse; margin-bottom: 18px; clear: both; }
  table.items thead th { background: #34090e; color: #fff; font-size: 11.5px; font-weight: 700; padding: 10px; text-align: ${start}; }
  table.items thead th:first-child { border-radius: ${lang === "ar" ? "8px 0 0 0" : "0 8px 0 0"}; }
  table.items thead th:last-child { border-radius: ${lang === "ar" ? "0 8px 0 0" : "8px 0 0 0"}; }
  table.items tbody td { padding: 9px 10px; font-size: 12.5px; border-bottom: 1px solid #EBE3D0; text-align: ${start}; }
  table.items tbody tr:nth-child(even) { background: #F5F0E4; }
  .totals-wrap { overflow: hidden; margin-bottom: 20px; }
  .totals { box-sizing: border-box; display: inline-block; min-width: 260px; font-size: 12.5px; float: ${end}; }
  .totals-row { overflow: hidden; padding: 5px 0; color: #555; }
  .totals-row span:first-child { float: ${start}; }
  .totals-row span:last-child { float: ${end}; }
  .grand-total { overflow: hidden; background: #34090e; color: #fff; padding: 10px 14px; border-radius: 9px; font-weight: 800; font-size: 15px; margin-top: 6px; }
  .grand-total span:first-child { float: ${start}; }
  .grand-total span:last-child { float: ${end}; }
  .note { clear: both; margin-top: 10px; font-size: 12px; color: #444; background: #F5F0E4; border-radius: 8px; padding: 10px 12px; }
  .foot { clear: both; margin-top: 34px; text-align: center; border-top: 1px solid #E3D9C4; padding-top: 16px; }
  .foot-thanks { font-size: 13.5px; font-weight: 700; color: #34090e; margin-bottom: 4px; }
  .foot-note { font-size: 11px; color: #8A9490; }
  .stamp { display: inline-block; border: 2px solid #34090e; color: #34090e; font-weight: 800; font-size: 11px; letter-spacing: 1px; padding: 2px 10px; margin-top: 6px; }
  .row-sub { font-size: 10.5px; color: #8A9490; }
  @media print { .sheet { padding-bottom: 0; } table.items tr { page-break-inside: avoid; } }
  bdi { unicode-bidi: isolate; }
`;
}


// نفس شكل الفاتورة الصادرة من الموقع (نفس الألوان والترتيب) عشان تكون كل فواتير SILENT CODE موحّدة
function invoiceStyles(lang) {
  const L = PRINT_LABELS[lang];
  const start = lang === "ar" ? "right" : "left";
  const end = lang === "ar" ? "left" : "right";
  return `
  * { box-sizing: border-box; }
  body { font-family: ${lang === "ar" ? "'Cairo','Segoe UI',Tahoma,Arial,sans-serif" : "'Segoe UI',Helvetica,Arial,sans-serif"}; direction: ${L.dir}; margin: 0; color: #1b1412; background: #fff; }
  .inv-band { background: #34090e; padding: 26px 28px; text-align: center; }
  .inv-logo { color: #EAE2D0; font-size: 22px; letter-spacing: .34em; font-weight: 600; font-family: 'Archivo','Segoe UI',Arial,sans-serif; direction: ltr; }
  .inv-rule { height: 2px; width: 46px; background: #C79B58; margin: 12px auto 0; }
  .sheet { max-width: 720px; margin: 0 auto; padding: 30px 28px 34px; }
  table { border-collapse: collapse; width: 100%; }
  .top { margin-bottom: 22px; }
  td.top-start { text-align: ${start}; vertical-align: top; }
  td.top-end { text-align: ${end}; vertical-align: top; }
  .eyebrow { font-size: 12px; letter-spacing: .14em; color: #C79B58; text-transform: uppercase; }
  .eyebrow.small { font-size: 12px; margin-bottom: 4px; }
  .inv-no { font-size: 26px; font-weight: 700; color: #34090e; margin-top: 4px; direction: ltr; text-align: ${start}; }
  .paid-stamp { display: inline-block; border: 2px solid #34090e; color: #34090e; padding: 4px 14px; font-weight: 700; letter-spacing: .1em; font-size: 13px; }
  .meta { margin-bottom: 22px; font-size: 14px; color: #5b4f45; }
  .meta span { color: #1b1412; }
  .billed { background: #F5F0E4; padding: 14px 16px; margin-bottom: 24px; font-size: 14px; line-height: 1.8; color: #1b1412; text-align: ${start}; }
  table.items th { padding: 0 0 8px; font-size: 12px; color: #8a7f6d; font-weight: 500; border-bottom: 2px solid #34090e; text-align: ${start}; }
  table.items td { padding: 12px 0; border-bottom: 1px solid #e3d9c4; font-size: 15px; text-align: ${start}; vertical-align: top; }
  table.items .c-qty { text-align: center; padding-inline: 8px; }
  table.items .c-num { text-align: ${end}; white-space: nowrap; }
  table.items th.c-qty { text-align: center; }
  table.items th.c-num { text-align: ${end}; }
  .sub { font-size: 12px; color: #C79B58; margin-top: 2px; }
  table.sumwrap { margin-top: 16px; }
  table.sumwrap td.sp { width: 45%; }
  table.sums td { padding: 6px 0; font-size: 14px; color: #5b4f45; text-align: ${start}; }
  table.sums td.c-num { text-align: ${end}; color: #1b1412; white-space: nowrap; }
  table.sums tr.sum-strong td { font-size: 17px; font-weight: 700; color: #34090e; }
  table.sums tr.sum-strong td.c-num { font-size: 19px; color: #34090e; }
  td.sum-rule { border-top: 2px solid #34090e; height: 6px; padding: 0; }
  .pay { margin-top: 18px; font-size: 12px; color: #8a7f6d; text-align: ${start}; }
  .note { margin-top: 14px; font-size: 13px; color: #444; background: #F5F0E4; padding: 10px 12px; text-align: ${start}; }
  .foot { margin-top: 34px; text-align: center; border-top: 1px solid #efe7d6; padding-top: 16px; }
  .foot-thanks { font-size: 14px; font-weight: 700; color: #34090e; margin-bottom: 4px; }
  .foot-note { font-size: 12px; color: #8a7f6d; line-height: 1.7; }
  .foot-site { font-size: 12px; color: #34090e; margin-top: 8px; letter-spacing: .08em; direction: ltr; }
  .foot-legal { font-size: 11px; color: #8a7f6d; margin-top: 6px; }
  bdi { unicode-bidi: isolate; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } table.items tr { page-break-inside: avoid; } }
`;
}

function openPrintWindow(lang, bodyHTML, styles) {
  const win = window.open("", "_blank", "width=850,height=1000");
  if (!win) {
    alert("المتصفح منع فتح نافذة الطباعة. فعّل النوافذ المنبثقة (Popups) لهذا الموقع وحاول مرة ثانية. / Popup blocked — please allow popups for this site.");
    return;
  }
  const L = PRINT_LABELS[lang];
  win.document.open();
  win.document.write(`<!doctype html><html dir="${L.dir}" lang="${L.htmlLang}"><head><meta charset="utf-8" /><title>${L.docTitle}</title><style>${styles || printStyles(lang)}</style></head><body>${bodyHTML}</body></html>`);
  win.document.close();
  win.onload = () => { win.focus(); win.print(); };
  setTimeout(() => { try { win.focus(); win.print(); } catch (e) {} }, 400);
}

function printInvoiceNow(invoice, data, lang = "ar") {
  const L = PRINT_LABELS[lang];
  const computed = invoiceComputed(invoice);
  const biz = data.settings.businessInfo || {};
  const rows = computed.items
    .filter((it) => it.productId)
    .map((it) => {
      const prod = data.products.find((p) => p.id === it.productId);
      const name = lang === "en" ? (prod?.nameEn || prod?.name || "—") : (prod?.name || "—");
      return `<tr>
        <td>${escHtml(name)}${it.free ? ` ${L.gift}` : ""}</td>
        <td><bdi>${it.qty}</bdi></td>
        <td><bdi>${fmt(it.price)}</bdi></td>
        <td><bdi>${it.lineDiscount ? fmt(it.lineDiscount) : "—"}</bdi></td>
        <td><bdi>${fmt(it.afterLineDiscount)}</bdi></td>
      </tr>`;
    })
    .join("");

  const bizLines = [
    biz.phone && `<div>${escHtml(biz.phone)}</div>`,
    biz.address && `<div>${escHtml(biz.address)}</div>`,
    biz.instagram && `<div>${escHtml(biz.instagram)}</div>`,
  ].filter(Boolean).join("");

  const deliveryLine = invoice.deliveryType === "delivery"
    ? `${L.deliveryType}${invoice.deliveryAddress ? `<div class="row">${escHtml(invoice.deliveryAddress)}</div>` : ""}`
    : L.pickup;

  const OX = "#34090e", BRASS = "#C79B58", INK = "#1b1412";
  const alignStart = lang === "ar" ? "right" : "left";
  const alignEnd = lang === "ar" ? "left" : "right";
  const isWeb = invoice.source === "website";
  const itemRows = computed.items
    .filter((it) => it.productId)
    .map((it) => {
      const prod = data.products.find((p) => p.id === it.productId);
      const name = lang === "en" ? (prod?.nameEn || prod?.name || "—") : (prod?.name || "—");
      return `<tr>
        <td class="c-item">${escHtml(name)}${it.free ? ` ${L.gift}` : ""}${it.lineDiscount ? `<div class="sub">${L.discount}: −${fmt(it.lineDiscount)} ${L.currency}</div>` : ""}</td>
        <td class="c-qty"><bdi>${it.qty}</bdi></td>
        <td class="c-num"><bdi>${fmt(it.price)}</bdi></td>
        <td class="c-num"><bdi>${fmt(it.afterLineDiscount)}</bdi></td>
      </tr>`;
    })
    .join("");
  const pay = invoice.paymentMethod ? escHtml(lang === "en" ? (PRINT_METHOD_EN[invoice.paymentMethod] || invoice.paymentMethod) : invoice.paymentMethod) : "";
  const addressLine = invoice.deliveryType === "delivery"
    ? (invoice.deliveryAddress ? escHtml(invoice.deliveryAddress) : L.deliveryType)
    : L.pickup;
  const sumRow = (label, val, strong) => `<tr class="${strong ? "sum-strong" : "sum"}"><td>${label}</td><td class="c-num"><bdi>${val}</bdi></td></tr>`;
  const html = `
    <div class="inv-band"><div class="inv-logo">SILENT CODE</div><div class="inv-rule"></div></div>
    <div class="sheet">
      <table class="top"><tr>
        <td class="top-start">
          <div class="eyebrow">${L.invoiceWord}</div>
          <div class="inv-no"><bdi>${escHtml(invoice.webInvoiceNumber || "#" + invoice.number)}</bdi></div>
        </td>
        <td class="top-end">${isWeb ? `<span class="paid-stamp">${L.paid}</span>` : ""}</td>
      </tr></table>
      <table class="meta"><tr>
        <td class="top-start">${L.dateLabel}: <span><bdi>${escHtml(invoice.date)}</bdi></span></td>
        <td class="top-end">${invoice.webOrderRef ? `${L.orderRef}: <span><bdi>${escHtml(invoice.webOrderRef)}</bdi></span>` : ""}</td>
      </tr></table>
      <div class="billed">
        <div class="eyebrow small">${L.billedTo}</div>
        <b>${escHtml(invoice.customerName || "—")}</b><br>
        ${invoice.customerPhone ? `${L.phone}: <bdi>${escHtml(invoice.customerPhone)}</bdi><br>` : ""}
        ${invoice.customerEmail ? `<bdi>${escHtml(invoice.customerEmail)}</bdi><br>` : ""}
        ${L.address}: ${addressLine}${invoice.deliveryType === "delivery" && invoice.customerCountry ? ` — ${escHtml(PRINT_COUNTRIES[invoice.customerCountry]?.[lang] || invoice.customerCountry)}` : ""}
      </div>
      <table class="items">
        <thead><tr><th class="c-item">${L.item}</th><th class="c-qty">${L.qty}</th><th class="c-num">${L.unitPrice}</th><th class="c-num">${L.total}</th></tr></thead>
        <tbody>${itemRows}</tbody>
      </table>
      <table class="sumwrap"><tr><td class="sp"></td><td>
        <table class="sums">
          ${computed.invoiceDiscountAmount > 0 || computed.shipping > 0 ? sumRow(L.subtotal, `${fmt(computed.subtotal)} ${L.currency}`) : ""}
          ${computed.invoiceDiscountAmount > 0 ? sumRow(L.invoiceDiscount, `− ${fmt(computed.invoiceDiscountAmount)} ${L.currency}`) : ""}
          ${computed.shipping > 0 ? sumRow(L.shipping, `${fmt(computed.shipping)} ${L.currency}`) : ""}
          <tr><td colspan="2" class="sum-rule"></td></tr>
          ${sumRow(isWeb ? L.grandTotalPaid : L.grandTotal, `${fmt(computed.totalPaid)} ${L.currency}`, true)}
        </table>
      </td></tr></table>
      ${pay ? `<div class="pay">${pay}</div>` : ""}
      ${invoice.note ? `<div class="note">${L.notes}: ${escHtml(invoice.note)}</div>` : ""}
      <div class="foot">
        <div class="foot-thanks">${L.thanksBrand}</div>
        <div class="foot-note">${L.footNote}</div>
        <div class="foot-site">silentcodeofficial.com</div>
        <div class="foot-legal">${L.legalLine}</div>
      </div>
    </div>
  `;
  openPrintWindow(lang, html, invoiceStyles(lang));
}

function printPeriodNow(period, data, lang = "ar") {
  const L = PRINT_LABELS[lang];
  const { dateFrom, dateTo, invoices, total, byMethod } = period;
  const rows = [...invoices]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((inv) => `<tr>
      <td><bdi>#${inv.number}</bdi></td>
      <td><bdi>${inv.date}</bdi></td>
      <td>${escHtml(inv.customerName || "—")}</td>
      <td>${escHtml(inv.paymentMethod || "—")}</td>
      <td><bdi>${fmt(invoiceComputed(inv).totalPaid)}</bdi></td>
    </tr>`)
    .join("");
  const methodRows = Object.entries(byMethod).map(([method, amt]) => `<div class="totals-row"><span>${method}</span><span><bdi>${fmt(amt)} ${L.currency}</bdi></span></div>`).join("");
  const html = `
    <div class="accent-bar"></div>
    <div class="sheet">
      <div class="print-head">
        <div class="head-col head-brand">
          <div class="print-brand">SILENT CODE</div>
          <div class="print-tagline">${L.periodTagline}</div>
        </div>
        <div class="head-col head-meta">
          <div class="print-meta-line">
            <div>${L.from}: <bdi>${dateFrom || "—"}</bdi></div>
            <div>${L.to}: <bdi>${dateTo || "—"}</bdi></div>
          </div>
        </div>
      </div>
      <table class="items">
        <thead><tr><th>${L.invoiceNo}</th><th>${lang === "ar" ? "التاريخ" : "Date"}</th><th>${L.customer}</th><th>${L.paymentMethod}</th><th>${L.total}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="totals-wrap">
        <div class="totals">
          <div class="info-box-title" style="margin-bottom:8px;">${L.byMethod}</div>
          ${methodRows}
          <div class="grand-total"><span>${L.grandTotal}</span><span><bdi>${fmt(total)} ${L.currency}</bdi></span></div>
        </div>
      </div>
      <div class="foot"><div class="foot-note">${L.invoiceCount}: ${invoices.length}</div></div>
    </div>
  `;
  openPrintWindow(lang, html);
}

/* ---- ضريبة القيمة المضافة (الأسعار شاملة الضريبة) وعمولة المسوّق ---- */
const VAT_RATE = 5; // %
// الضريبة المستخرجة من مبلغ شامل: المبلغ × 5 ÷ 105
const vatOf = (grossInclusive) => (Number(grossInclusive) || 0) * VAT_RATE / (100 + VAT_RATE);
// عمولة سطر واحد حسب ما انحفظ على الفاتورة وقت البيع: نسبة من صافي بيع المنتج، أو مبلغ ثابت لكل وحدة مباعة (الهدية ما تنحسب)
function itemCommission(inv, it) {
  const mk = inv.marketer;
  if (!mk) return 0;
  if (mk.type === "fixed") return it.free ? 0 : (Number(it.qty) || 0) * (Number(mk.fixed) || 0);
  return (Number(it.netRevenue) || 0) * (Number(mk.percent) || 0) / 100;
}
function invoiceCommission(inv) {
  return invoiceComputed(inv).items.reduce((s, it) => s + itemCommission(inv, it), 0);
}

function productRevenueQty(data, productId) {
  let qty = 0, revenue = 0, commission = 0, vat = 0;
  data.invoices.forEach((inv) => {
    const computed = invoiceComputed(inv);
    computed.items.forEach((it) => {
      if (it.productId === productId) {
        qty += it.qty;
        revenue += it.netRevenue;
        commission += itemCommission(inv, it);
        vat += vatOf(it.netRevenue);
      }
    });
  });
  return { qty, revenue, commission, vat };
}

function computeAllProductAgg(data) {
  const totalRevenue = data.products.reduce((s, p) => s + productRevenueQty(data, p.id).revenue, 0);
  const totalGeneralMarketing = data.marketing.filter((m) => !m.productId).reduce((s, m) => s + (Number(m.cost) || 0), 0);
  return data.products.map((p) => {
    const { qty, revenue, commission, vat } = productRevenueQty(data, p.id);
    const ref = productReferenceCost(data, p.id);
    const cogs = qty * ref.unitCost;
    const direct = data.marketing.filter((m) => m.productId === p.id).reduce((s, m) => s + (Number(m.cost) || 0), 0);
    const allocatedGeneral = totalRevenue > 0 ? totalGeneralMarketing * (revenue / totalRevenue) : 0;
    const marketingTotal = direct + allocatedGeneral;
    const lossesTotal = data.losses.filter((l) => l.productId === p.id).reduce((s, l) => s + (Number(l.costTotal) || 0), 0);
    const grossProfit = revenue - cogs;
    const netProfit = grossProfit - marketingTotal - lossesTotal - commission - vat;
    return { product: p, qty, revenue, unitCost: ref.unitCost, costSource: ref.source, cogs, marketingTotal, lossesTotal, commission, vat, grossProfit, netProfit };
  });
}

const PIE_COLORS = ["#0E6E5B", "#B9702E", "#3D6B8C", "#8C6B3D", "#B3452F", "#6B4C8C"];

function nextCode(list, prefix) {
  let max = 0;
  list.forEach((x) => {
    const m = String(x.code || "").match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}
const materialLabel = (m) => (m ? `${m.code ? m.code + " · " : ""}${m.name}` : "");
const productLabel = (p) => (p ? `${p.code ? p.code + " · " : ""}${p.name}` : "");

function customerStats(invoices) {
  const map = new Map();
  invoices.forEach((inv) => {
    const name = (inv.customerName || "").trim();
    if (!name) return;
    const key = name.toLowerCase();
    const total = invoiceComputed(inv).grandTotal; // الصافي بعد خصم السطر والفاتورة (نفس اللي دفعه العميل)
    if (!map.has(key)) map.set(key, { name, phone: inv.customerPhone || "", email: "", country: "", count: 0, total: 0, lastDate: inv.date, invoices: [] });
    const c = map.get(key);
    c.count += 1;
    c.total += total;
    if (inv.customerPhone) c.phone = inv.customerPhone;
    if (inv.customerEmail) c.email = inv.customerEmail;
    if (inv.customerCountry) c.country = inv.customerCountry;
    if (!c.lastDate || inv.date > c.lastDate) c.lastDate = inv.date;
    c.invoices.push(inv);
  });
  return [...map.values()].sort((a, b) => b.total - a.total);
}

/* ============================== الإلغاء / الإقفال / سجل التعديلات ============================== */

// الفاتورة الملغاة (مرتجع): ما تدخل الإيراد ولا الضريبة ولا العمولة ولا المخزون، لكن تبقى محفوظة بالسجل.
// وإذا انرد مبلغ للعميل (refundAmount) يبقى دخول المبلغ وخروج المرتجع ظاهرين بالحسابات.
const isVoid = (inv) => !!(inv && inv.void);
const voidRefund = (inv) => (isVoid(inv) ? Math.max(0, Number(inv.void.refundAmount) || 0) : 0);
const countsInAccounts = (inv) => !isVoid(inv) || voidRefund(inv) > 0;
function activeData(d) { return d && d.invoices.some(isVoid) ? { ...d, invoices: d.invoices.filter((i) => !isVoid(i)) } : d; }
const lockDate = (d) => (d && d.settings && d.settings.lockedUntil) || "";
const isLocked = (d, date) => { const l = lockDate(d); return !!l && !!date && String(date) <= l; };
const lockMsg = (d) => `الفترة مقفلة لين ${lockDate(d)} — ما تقدر تضيف أو تعدّل أو تحذف شي بهالتاريخ. لو لازم، افتح الإقفال من الإعدادات.`;

// إجمالي عملية شراء بالريال (شامل التكاليف الإضافية)
function purchaseTotal(p) {
  return (p.lines || []).reduce((s, l) => s + (Number(l.landedTotal) || (Number(l.qty) || 0) * (Number(l.unitCost) || 0)), 0);
}
const PAY_ACCOUNTS = [{ id: "sohar", name: "بنك صحار" }, { id: "cash", name: "الكاش" }];
function PaidFromField({ value, onChange }) {
  return (
    <Field label="مدفوع من حساب" hint="يتخصم من رصيد الحساب تلقائيًا">
      <select value={value || ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">غير مربوط (لا يتخصم)</option>
        {PAY_ACCOUNTS.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
    </Field>
  );
}
function VatPaidField({ value, onChange }) {
  return (
    <Field label="منها ضريبة 5% مدفوعة (اختياري)" hint="لو الفاتورة من مورّد مسجّل بالضريبة — تنخصم من ضريبتك المستحقة">
      <input type="number" min="0" step="0.001" value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

// المبالغ المرتبطة بحسابات من التبويبات الأخرى (مشتريات، حملات تسويق، معدات، تأسيس)
function linkedOutflows(data) {
  const out = [];
  (data.purchases || []).forEach((p) => { if (p.paidFrom) out.push({ id: p.id, kind: "شراء مواد", title: `شراء #${p.number}${p.note ? " — " + p.note : ""}`, date: p.date, amount: purchaseTotal(p), account: p.paidFrom }); });
  (data.marketing || []).forEach((m) => { if (m.paidFrom && m.type !== "sample") out.push({ id: m.id, kind: "تسويق", title: m.title, date: m.date, amount: Number(m.cost) || 0, account: m.paidFrom }); });
  (data.equipment || []).forEach((e) => { if (e.paidFrom) out.push({ id: e.id, kind: "معدات", title: e.title, date: e.date, amount: Number(e.cost) || 0, account: e.paidFrom }); });
  (data.branding || []).forEach((b) => { if (b.paidFrom) out.push({ id: b.id, kind: "تأسيس", title: b.title, date: b.date, amount: Number(b.cost) || 0, account: b.paidFrom }); });
  return out;
}

// ضريبة المشتريات (المدخلات) — مبالغ ضريبة مدفوعة مسجلة بالمشتريات والمصروفات والتسويق والمعدات والتأسيس
function inputVatItems(data) {
  const out = [];
  (data.purchases || []).forEach((p) => { const v = Number(p.vatPaid) || 0; if (v > 0) out.push({ date: p.date, amount: v, title: `شراء #${p.number}` }); });
  (data.expenses || []).forEach((x) => { const v = Number(x.vat) || 0; if (v > 0) out.push({ date: x.date, amount: v, title: x.title }); });
  (data.marketing || []).forEach((m) => { const v = Number(m.vat) || 0; if (v > 0) out.push({ date: m.date, amount: v, title: m.title }); });
  (data.equipment || []).forEach((e) => { const v = Number(e.vat) || 0; if (v > 0) out.push({ date: e.date, amount: v, title: e.title }); });
  (data.branding || []).forEach((b) => { const v = Number(b.vat) || 0; if (v > 0) out.push({ date: b.date, amount: v, title: b.title }); });
  return out;
}

// الإهلاك الشهري الثابت للمعدات (اختياري: عمر الاستخدام بالشهور)
function monthsBetween(d1, d2) {
  const a = String(d1 || ""), b = String(d2 || "");
  if (a.length < 10 || b.length < 10) return 0;
  const m = (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7))) - (Number(b.slice(8, 10)) < Number(a.slice(8, 10)) ? 1 : 0);
  return Math.max(0, m);
}
function depreciationUpTo(e, dateStr) {
  const life = Number(e.lifeMonths) || 0, cost = Number(e.cost) || 0;
  if (!(life > 0) || !(cost > 0) || !dateStr) return 0;
  return Math.min(cost, (cost / life) * monthsBetween(e.date, dateStr));
}
function depreciationInPeriod(equipment, from, to) {
  const end = to || todayStr();
  return (equipment || []).reduce((s, e) => {
    const upTo = depreciationUpTo(e, end);
    let before = 0;
    if (from) { const d = new Date(from + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 1); before = depreciationUpTo(e, d.toISOString().slice(0, 10)); }
    return s + Math.max(0, upTo - before);
  }, 0);
}

// تصفية بيانات الفترة للوحة التحكم (الدفعات والوصفات تبقى كاملة لأن تكلفة الوحدة تعتمد عليها)
function dataForPeriod(data, from, to) {
  if (!from && !to) return data;
  const inR = (d) => (!from || String(d || "") >= from) && (!to || String(d || "") <= to);
  return {
    ...data,
    invoices: data.invoices.filter((i) => inR(i.date)),
    marketing: data.marketing.filter((m) => inR(m.date)),
    losses: data.losses.filter((l) => inR(l.date)),
    branding: data.branding.filter((b) => inR(b.date)),
    equipment: data.equipment.filter((e) => inR(e.date)),
    expenses: (data.expenses || []).filter((x) => inR(x.date)),
    purchases: data.purchases.filter((p) => inR(p.date)),
    bankTxns: (data.bankTxns || []).filter((t) => t.kind === "opening" || inR(t.date)),
  };
}

const AUDIT_AREAS = {
  invoices: { label: "فاتورة بيع", name: (x) => `#${x.number} ${x.customerName || ""}`.trim(), amount: (x) => invoiceComputed(x).totalPaid },
  purchases: { label: "شراء مواد", name: (x) => `#${x.number}${x.note ? " " + x.note : ""}`, amount: (x) => purchaseTotal(x) },
  batches: { label: "دفعة إنتاج", name: (x) => String(x.code || x.number || x.date || x.id) },
  marketing: { label: "تسويق", name: (x) => x.title, amount: (x) => Number(x.cost) || 0 },
  losses: { label: "خسارة تصنيع", name: (x) => x.note || x.date, amount: (x) => Number(x.costTotal) || 0 },
  branding: { label: "تأسيس", name: (x) => x.title, amount: (x) => Number(x.cost) || 0 },
  equipment: { label: "معدات", name: (x) => x.title, amount: (x) => Number(x.cost) || 0 },
  expenses: { label: "مصروف", name: (x) => x.title, amount: (x) => Number(x.amount) || 0 },
  bankTxns: { label: "حركة حساب", name: (x) => `${x.kind}${x.note ? " — " + x.note : ""}`, amount: (x) => Number(x.amount) || Number(x.gross) || 0 },
  materials: { label: "مادة", name: (x) => x.name, addDelOnly: true },
  products: { label: "منتج", name: (x) => x.name, addDelOnly: true },
};
function buildAudit(prev, next, actor) {
  if (!prev) return [];
  const at = new Date().toISOString();
  const out = [];
  Object.entries(AUDIT_AREAS).forEach(([key, cfg]) => {
    const a = prev[key] || [], b = next[key] || [];
    if (a === b) return;
    const am = new Map(a.map((x) => [x.id, x])), bm = new Map(b.map((x) => [x.id, x]));
    const safe = (fn, x) => { try { return fn ? fn(x) : undefined; } catch (e) { return undefined; } };
    b.forEach((x) => {
      const o = am.get(x.id);
      if (!o) { out.push({ id: uid("au"), at, by: actor, kind: "add", area: cfg.label, ref: safe(cfg.name, x), amount: safe(cfg.amount, x) }); return; }
      if (cfg.addDelOnly || JSON.stringify(o) === JSON.stringify(x)) return;
      const kind = key === "invoices" && x.void && !o.void ? "void" : key === "invoices" && !x.void && o.void ? "unvoid" : "edit";
      out.push({ id: uid("au"), at, by: actor, kind, area: cfg.label, ref: safe(cfg.name, x), amount: safe(cfg.amount, x) });
    });
    a.forEach((x) => { if (!bm.has(x.id)) out.push({ id: uid("au"), at, by: actor, kind: "delete", area: cfg.label, ref: safe(cfg.name, x), amount: safe(cfg.amount, x) }); });
  });
  const pl = (prev.settings || {}).lockedUntil || "", nl = (next.settings || {}).lockedUntil || "";
  if (pl !== nl) out.push({ id: uid("au"), at, by: actor, kind: "lock", area: "إقفال الفترة", ref: nl ? `إقفال لين ${nl}` : "فتح الإقفال" });
  return out;
}

/* ============================== primitives ============================== */

function ConfirmModal({ state, onCancel }) {
  if (!state) return null;
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-body" style={{ textAlign: "center", padding: "26px 20px 20px" }}>
          <AlertTriangle size={26} style={{ color: "var(--danger)", marginBottom: 10 }} />
          <p style={{ margin: "0 0 18px", fontSize: 13.5 }}>{state.message}</p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            {state.info ? (
              <button className="btn-primary" onClick={onCancel}>حسنًا، فهمت</button>
            ) : (
              <>
                <button className="btn-ghost" onClick={onCancel}>إلغاء</button>
                <button className="btn-primary" style={{ background: "var(--danger)" }} onClick={() => { state.onConfirm(); onCancel(); }}>
                  تأكيد الحذف
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}
function Empty({ icon: Icon, title, sub }) {
  return (
    <div className="empty-state">
      <Icon size={30} strokeWidth={1.5} />
      <p className="empty-title">{title}</p>
      <p className="empty-sub">{sub}</p>
    </div>
  );
}
function PageHead({ eyebrow, title, desc, action }) {
  return (
    <div className="page-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h2>{title}</h2>
        {desc && <p className="page-desc">{desc}</p>}
      </div>
      {action}
    </div>
  );
}

/* ---- تسجيل خروج تلقائي عند الخمول ---- */
const IDLE_LIMIT_MIN = 30; // دقائق بدون أي حركة قبل تسجيل الخروج التلقائي
const ACTIVITY_KEY = "silentcode_last_activity";
function touchActivity() { try { localStorage.setItem(ACTIVITY_KEY, String(Date.now())); } catch (e) {} }
function readActivity() { try { return Number(localStorage.getItem(ACTIVITY_KEY)) || 0; } catch (e) { return 0; } }
function clearActivity() { try { localStorage.removeItem(ACTIVITY_KEY); } catch (e) {} }

function LoginScreen({ onSignedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetMsg, setResetMsg] = useState("");

  async function submit() {
    if (!email || !password) return;
    setBusy(true);
    setError("");
    setResetMsg("");
    try {
      touchActivity(); // نسجل وقت الدخول قبل ما يشتغل فحص الخمول
      const user = await signIn(email, password);
      onSignedIn(user);
    } catch (e) {
      setError("الإيميل أو كلمة المرور غلط. تأكد منهم وحاول مرة ثانية.");
    }
    setBusy(false);
  }

  async function forgotPassword() {
    if (!email) {
      setError("اكتب إيميلك فوق أولاً، وبعدها اضغط نسيت كلمة المرور.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await resetPassword(email);
      setResetMsg("أرسلنا رابط تعيين كلمة مرور جديدة لإيميلك. شيّك صندوق الوارد، وإذا ما لقيته شوف مجلد الرسائل غير المرغوبة (Spam).");
    } catch (e) {
      setError("ما قدرنا نرسل رابط الاستعادة. تأكد إن الإيميل صحيح.");
    }
    setBusy(false);
  }

  return (
    <div className="login-screen" dir="rtl">
      <Style />
      <div className="login-card">
        <div className="brand-mark" style={{ margin: "0 auto 14px" }}>م</div>
        <h2>SILENT CODE</h2>
        <p className="login-brand-sub">نظام محاسبة التصنيع والتغليف</p>
        <p className="login-sub">سجّل دخولك بإيميلك وكلمة المرور</p>

        <div className="login-form">
          <input
            type="email" placeholder="الإيميل" value={email}
            onChange={(e) => { setEmail(e.target.value); setError(""); setResetMsg(""); }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            autoFocus
          />
          <input
            type="password" placeholder="كلمة المرور" value={password}
            onChange={(e) => { setPassword(e.target.value); setError(""); setResetMsg(""); }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button className="btn-primary" onClick={submit} disabled={!email || !password || busy}>
            {busy ? "..." : "دخول"}
          </button>
          <button type="button" className="link-btn" style={{ justifyContent: "center", marginTop: 4 }} onClick={forgotPassword} disabled={busy}>
            نسيت كلمة المرور؟ اضغط هنا لإرسال رابط استعادة
          </button>
        </div>

        {error && <p className="login-error">{error}</p>}
        {resetMsg && <p className="login-reset-msg">{resetMsg}</p>}
      </div>
    </div>
  );
}

/* ============================== app ============================== */

export default function CostingApp() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("dashboard");
  const [authUser, setAuthUser] = useState(undefined); // undefined = not checked yet, null = signed out, object = signed in
  const dataRef = useRef(null); // آخر نسخة من البيانات (للاستيراد التلقائي الخلفي بدون مشكلة نسخة قديمة)
  dataRef.current = data;
  const syncingRef = useRef(false);
  const syncRef = useRef(null);
  const [fulfil, setFulfil] = useState({ orders: [], loading: false, error: "" });
  const [transfers, setTransfers] = useState({ list: [], loading: false, error: "" });
  const [webState, setWebState] = useState({ pending: [], warnings: [], lastCheck: null, busy: false, error: "", importedNow: 0, stockSyncedAt: null, stockError: "" });
  const lastStockRef = useRef("");
  const pushStockRef = useRef(null);

  useEffect(() => {
    const unsub = watchAuth((user) => setAuthUser(user || null));
    return unsub;
  }, []);

  useEffect(() => {
    if (!authUser) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const loaded = await loadAppData();
        if (!cancelled) setData(loaded);
        ensureDailyBackup(loaded); // fire-and-forget, runs in the background
      } catch (e) {
        console.error("load error", e);
        if (!cancelled) setData(defaultAppData());
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [authUser]);

  const savingRef = useRef(0);
  const dirtyRef = useRef(false);
  function actorName(d) {
    const em = (authUser?.email || "").trim().toLowerCase();
    const m = ((d && d.settings && d.settings.partners) || []).find((p) => (p.email || "").trim().toLowerCase() === em);
    return m ? m.name : (authUser?.email || "—");
  }
  // opts.replace: استبدال كامل (استعادة نسخة) — opts.actor: اسم المنفذ بسجل التعديلات — opts.noAudit
  async function persist(next, opts = {}) {
    const prev = dataRef.current ?? data;
    if (!opts.noAudit && !opts.replace) {
      const entries = buildAudit(prev, next, opts.actor || actorName(prev));
      if (entries.length) next = { ...next, auditLog: [...(next.auditLog || prev.auditLog || []), ...entries].slice(-1500) };
    }
    dataRef.current = next;
    setData(next);
    savingRef.current += 1;
    try {
      const merged = await saveAppData(prev, next, { replace: !!opts.replace });
      dirtyRef.current = false;
      // لو الشريك الثاني غيّر شي بنفس الوقت، نعرضه عندنا (بشرط ما صار تعديل أحدث محليًا)
      if (dataRef.current === next && JSON.stringify(merged) !== JSON.stringify(next)) { dataRef.current = merged; setData(merged); }
      return true;
    } catch (e) {
      console.error("save error", e);
      dirtyRef.current = true;
      return false;
    } finally {
      savingRef.current -= 1;
    }
  }

  // تحديث تلقائي لتعديلات الشريك الثاني (كل دقيقتين، ولما ترجع للنافذة) — فقط لو ما فيه حفظ جاري أو فاشل
  useEffect(() => {
    if (!authUser) return;
    let busy = false;
    const refresh = async () => {
      if (busy || savingRef.current > 0 || dirtyRef.current || !dataRef.current || document.hidden) return;
      busy = true;
      try {
        const fresh = await loadAppData();
        if (savingRef.current === 0 && !dirtyRef.current && JSON.stringify(fresh) !== JSON.stringify(dataRef.current)) {
          dataRef.current = fresh; setData(fresh);
        }
      } catch (e) { /* نحاول بالدورة الجاية */ }
      busy = false;
    };
    const timer = setInterval(refresh, 120000);
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [authUser]);

  /* ---- استيراد طلبات الموقع المدفوعة كفواتير بيع ---- */
  function stockWarningsFor(nextData, orders) {
    const out = [];
    orders.forEach((o) => {
      (o.items || []).forEach((it) => {
        const prodId = it.productId;
        if (!prodId) return;
        const avail = availableToSell(nextData, prodId);
        if (avail < 0 && isStockTracked(nextData, prodId)) {
          const p = nextData.products.find((x) => x.id === prodId);
          out.push(`⚠️ مخزون «${p ? p.name : prodId}» صار بالسالب (${avail}) بعد طلب الموقع — سجّل دفعة إنتاج أو راجع الكمية.`);
        }
      });
    });
    return [...new Set(out)];
  }

  async function syncWebOrders() {
    if (syncingRef.current || !dataRef.current) return;
    syncingRef.current = true;
    setWebState((s) => ({ ...s, busy: true, error: "" }));
    try {
      const orders = await pullWebOrders();
      let cur = dataRef.current;
      const already = new Set(cur.invoices.map((i) => i.webOrderRef).filter(Boolean));
      const ackRefs = orders.filter((o) => already.has(o.client_reference_id)).map((o) => o.client_reference_id);
      const fresh = orders.filter((o) => !already.has(o.client_reference_id));

      const auto = [];
      const manual = [];
      // الاستيراد التلقائي فقط للأصناف المربوطة ربطًا مؤكَّدًا (تبويب «المخزون الجاهز للبيع» ← ربط المنتجات بالموقع، أو أول مطابقة يدوية).
      // أي صنف غير مربوط يوقف الطلب في «طلبات الموقع» لين تختار له المنتج مرة وحدة، وبعدها يتذكره للأبد.
      const working = cur;
      fresh.forEach((o) => {
        const m = matchWebItemsStrict(o, working.products, working.settings.webProductMap);
        (m.length > 0 && m.every((x) => x.productId) ? auto : manual).push(o);
      });

      let warnings = [];
      const amountWarnings = [];
      if (auto.length > 0) {
        let next = working;
        const importedItems = [];
        auto.forEach((o) => {
          const m = matchWebItemsStrict(o, next.products, next.settings.webProductMap);
          const inv = buildInvoiceFromWebOrder(o, m, next.nextInvoiceNo, uid);
          const paidOmr = Number(o.total_amount) / 1000;
          const calcOmr = invoiceComputed(inv).totalPaid;
          if (Number.isFinite(paidOmr) && Math.abs(paidOmr - calcOmr) >= 0.0005) {
            amountWarnings.push(`⚠️ فرق بمبلغ طلب الموقع ${o.client_reference_id}: المدفوع ${fmt(paidOmr)} ر.ع مقابل فاتورة البرنامج ${fmt(calcOmr)} ر.ع — راجع الفاتورة.`);
          }
          next = { ...next, invoices: [...next.invoices, inv], nextInvoiceNo: next.nextInvoiceNo + 1 };
          importedItems.push({ items: inv.items });
        });
        const ok = await persist(next, { actor: "النظام (طلبات الموقع)" });
        if (ok) {
          ackRefs.push(...auto.map((o) => o.client_reference_id));
          warnings = [...stockWarningsFor(activeData(next), importedItems), ...amountWarnings];
        } else {
          manual.push(...auto); // فشل الحفظ: نخليها تظهر بالتبويب ونعيد المحاولة
        }
      }
      if (ackRefs.length > 0) await ackWebOrders(ackRefs);

      setWebState((s) => ({
        ...s,
        pending: manual,
        warnings: [...new Set([...(auto.length ? warnings : s.warnings)])],
        lastCheck: new Date(),
        busy: false,
        error: "",
        importedNow: auto.length,
      }));
      loadFulfillment();
      lastStockRef.current = ""; // بعد كل فحص نعيد إرسال المخزون (يصحّح خصم الطلبات اللي انستوردت للتو)
      if (pushStockRef.current) await pushStockRef.current();
    } catch (e) {
      console.error("web sync error", e);
      setWebState((s) => ({ ...s, busy: false, error: "تعذر الاتصال بالموقع الآن — بنحاول مرة ثانية تلقائيًا." }));
    } finally {
      syncingRef.current = false;
    }
  }
  syncRef.current = syncWebOrders;

  // متابعة تجهيز الطلبات (حالة كل طلب مدفوع بالموقع)
  async function loadTransfers() {
    setTransfers((t) => ({ ...t, loading: true }));
    try { const list = await listTransfers(); setTransfers({ list, loading: false, error: "" }); }
    catch (e) { setTransfers((t) => ({ ...t, loading: false, error: "تعذر تحميل التحويلات الآن." })); }
  }
  async function transferAction(ref, kind) {
    try {
      if (kind === "confirm") await confirmTransfer(ref); else await cancelTransfer(ref);
      await loadTransfers();
      if (kind === "confirm") { await syncWebOrders(); await loadFulfillment(); }
      return "";
    } catch (e) { return "تعذر تنفيذ العملية، حاول مرة ثانية."; }
  }
  async function loadFulfillment() {
    loadTransfers();
    setFulfil((f) => ({ ...f, loading: true }));
    try {
      const orders = await listWebOrders();
      setFulfil({ orders, loading: false, error: "" });
    } catch (e) {
      setFulfil((f) => ({ ...f, loading: false, error: "تعذر تحميل الطلبات الآن." }));
    }
  }
  async function changeFulfillment(ref, status, note) {
    const upd = await setWebOrderStatus(ref, status, note, true);
    setFulfil((f) => ({ ...f, orders: f.orders.map((o) => (o.client_reference_id === ref ? { ...o, ...upd } : o)) }));
  }

  // مزامنة المخزون: نرسل "المتاح للبيع" لكل منتج للموقع (يتحدّث فقط لو تغيّر شي عن آخر مرة)
  async function pushStockNow() {
    const cur = activeData(dataRef.current);
    if (!cur) return;
    const rev = {};
    Object.entries(cur.settings.webProductMap || {}).forEach(([webId, accId]) => { rev[accId] = webId; });
    const snap = cur.products.filter((p) => rev[p.id] && isStockTracked(cur, p.id)).map((p) => ({
      code: p.code || "",
      name_en: p.nameEn || "",
      web_product_id: rev[p.id] || null,
      available: Math.max(0, Math.floor(availableToSell(cur, p.id))),
    }));
    const key = JSON.stringify(snap);
    if (key === lastStockRef.current) return;
    try {
      await pushWebStock(snap);
      lastStockRef.current = key;
      setWebState((s) => ({ ...s, stockSyncedAt: new Date(), stockError: "" }));
    } catch (e) {
      console.error("stock push error", e);
      setWebState((s) => ({ ...s, stockError: "تعذر تحديث مخزون الموقع — بنعيد المحاولة تلقائيًا." }));
    }
  }
  pushStockRef.current = pushStockNow;
  function forcePushStock() { lastStockRef.current = ""; return pushStockNow(); }

  // أي تغيير بالبيانات (فاتورة، دفعة إنتاج، سامبل، خسارة...) ← بعد 4 ثواني نحدّث مخزون الموقع
  useEffect(() => {
    if (!authUser || !data) return;
    const t = setTimeout(() => pushStockRef.current && pushStockRef.current(), 4000);
    return () => clearTimeout(t);
  }, [data, authUser]);

  // استيراد يدوي لطلب فيه أصناف ما انطابقت تلقائيًا (المستخدم يختار المنتج المقابل)
  async function importManualWebOrder(order, selection) {
    const cur = dataRef.current;
    const m = (order.items || []).map((item, idx) => ({ item, productId: selection[idx] }));
    if (m.some((x) => !x.productId)) return false;
    const webProductMap = { ...(cur.settings.webProductMap || {}) };
    m.forEach((x) => { if (x.item.product_id != null) webProductMap[String(x.item.product_id)] = x.productId; });
    const inv = buildInvoiceFromWebOrder(order, m, cur.nextInvoiceNo, uid);
    const next = {
      ...cur,
      invoices: [...cur.invoices, inv],
      nextInvoiceNo: cur.nextInvoiceNo + 1,
      settings: { ...cur.settings, webProductMap },
    };
    const ok = await persist(next);
    if (!ok) return false;
    try { await ackWebOrders([order.client_reference_id]); } catch (e) { /* يتكرر الإشعار بالدورة الجاية */ }
    setWebState((s) => ({
      ...s,
      pending: s.pending.filter((o) => o.client_reference_id !== order.client_reference_id),
      warnings: [...new Set([...s.warnings, ...stockWarningsFor(activeData(next), [{ items: inv.items }])])],
    }));
    return true;
  }

  // فحص الموقع أول ما تنحمّل البيانات، وبعدها كل دقيقة ما دام البرنامج مفتوح
  const dataReady = !!data;
  useEffect(() => {
    if (!authUser || !dataReady) return;
    const t0 = setTimeout(() => syncRef.current && syncRef.current(), 1500);
    const timer = setInterval(() => syncRef.current && syncRef.current(), 60000);
    return () => { clearTimeout(t0); clearInterval(timer); };
  }, [authUser, dataReady]);

  async function handleLogout() {
    clearActivity();
    await signOutUser();
    setData(null);
  }

  async function handleChangePassword() {
    if (!authUser?.email) return;
    if (!window.confirm("نرسل رابط تغيير كلمة المرور لإيميلك (" + authUser.email + ")؟")) return;
    try {
      await resetPassword(authUser.email);
      alert("تم إرسال الرابط لإيميلك. شيّك الوارد أو مجلد Spam.");
    } catch (e) {
      alert("ما قدرنا نرسل الرابط، حاول مرة ثانية.");
    }
  }

  // خروج تلقائي لو ما فيه نشاط (يشمل لو فتح البرنامج بعد غياب طويل)
  useEffect(() => {
    if (!authUser) return;
    const limit = IDLE_LIMIT_MIN * 60 * 1000;
    const stale = () => { const last = readActivity(); return last > 0 && Date.now() - last > limit; };
    if (stale()) { handleLogout(); return; }
    touchActivity();
    let lastWrite = Date.now();
    const onActivity = () => {
      const now = Date.now();
      if (now - lastWrite > 15000) { lastWrite = now; touchActivity(); }
    };
    const check = () => { if (stale()) handleLogout(); };
    const evs = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "click"];
    evs.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    document.addEventListener("visibilitychange", check);
    const timer = setInterval(check, 30000);
    return () => {
      evs.forEach((e) => window.removeEventListener(e, onActivity));
      document.removeEventListener("visibilitychange", check);
      clearInterval(timer);
    };
  }, [authUser]);

  if (authUser === undefined) {
    return (
      <div className="boot-screen">
        <Style />
        <Loader2 className="spin" size={26} />
        <span>...</span>
      </div>
    );
  }

  if (!authUser) {
    return <LoginScreen onSignedIn={() => {}} />;
  }

  if (loading || !data) {
    return (
      <div className="boot-screen">
        <Style />
        <Loader2 className="spin" size={26} />
        <span>جاري تحميل بيانات البزنس...</span>
      </div>
    );
  }

  const currentUser = (() => {
    const match = (data.settings.partners || []).find(
      (p) => (p.email || "").trim().toLowerCase() === (authUser.email || "").trim().toLowerCase()
    );
    return match ? { id: match.id, name: match.name } : { id: authUser.uid, name: authUser.email };
  })();

  const webBadge = transfers.list.length + webState.pending.length + webState.warnings.length + fulfil.orders.filter((o) => (o.fulfillment_status || "new") === "new").length;
  const NAV_GROUPS = [
    { title: "", items: [{ id: "dashboard", label: "الرئيسية", icon: LayoutDashboard }] },
    { title: "المبيعات", items: [
      { id: "invoices", label: "فواتير البيع", icon: Receipt },
      { id: "webOrders", label: "طلبات الموقع", icon: Globe, badge: webBadge },
      { id: "offers", label: "العروض والخصومات", icon: Sparkles },
      { id: "marketers", label: "المسوّقون والعمولات", icon: Users },
      { id: "customers", label: "العملاء", icon: Users },
    ] },
    { title: "الإنتاج والمخزون", items: [
      { id: "materials", label: "المخزون والمواد", icon: Boxes },
      { id: "purchaseLog", label: "سجل المشتريات", icon: FileText },
      { id: "products", label: "المنتجات والوصفات", icon: Package },
      { id: "production", label: "دفعات الإنتاج", icon: Factory },
      { id: "finished", label: "المخزون الجاهز للبيع", icon: PackageCheck },
      { id: "losses", label: "خسائر التصنيع", icon: AlertTriangle },
    ] },
    { title: "المالية", items: [
      { id: "accounts", label: "الحسابات والشركاء", icon: Wallet },
      { id: "expenses", label: "المصروفات", icon: Receipt },
      { id: "marketing", label: "التسويق والسامبلات", icon: Megaphone },
      { id: "equipment", label: "المعدات والأصول", icon: Wrench },
      { id: "branding", label: "تكاليف التأسيس", icon: Building2 },
      { id: "vat", label: "الإقرار الضريبي (5%)", icon: FileText },
    ] },
    { title: "النظام", items: [
      { id: "audit", label: "سجل التعديلات", icon: ShieldCheck },
      { id: "settings", label: "الإعدادات", icon: SettingsIcon },
    ] },
  ];

  // البيانات "الفعّالة" (بدون الفواتير الملغاة) لكل تبويب يحسب إيراد أو مخزون أو ضريبة
  const vd = activeData(data);
  const pv = (next, o) => {
    const vs = (dataRef.current || data).invoices.filter(isVoid);
    return persist(vs.length ? { ...next, invoices: [...next.invoices, ...vs] } : next, o);
  };

  return (
    <div dir="rtl" className="app-shell">
      <Style />
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">م</div>
          <div>
            <div className="brand-title">SILENT CODE</div>
            <div className="brand-sub">تصنيع · تغليف · بيع</div>
          </div>
        </div>
        <nav className="nav">
          {NAV_GROUPS.map((g, gi) => (
            <div className="nav-group" key={gi}>
              {g.title && <div className="nav-group-title">{g.title}</div>}
              {g.items.map((n) => (
                <button key={n.id} className={`nav-item ${tab === n.id ? "active" : ""}`} onClick={() => setTab(n.id)}>
                  <n.icon size={16} strokeWidth={2} />
                  <span>{n.label}</span>
                  {n.badge > 0 && <span className="badge amber" style={{ marginRight: "auto" }}>{n.badge}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-user">
          <div className="sidebar-user-name">{currentUser.name}</div>
          <button className="logout-btn" onClick={handleChangePassword} style={{ marginBottom: 6 }}>تغيير كلمة المرور</button>
          <button className="logout-btn" onClick={handleLogout}>تسجيل خروج</button>
        </div>
        <div className="sidebar-foot">
          <Users size={13} />
          <span>بيانات مشتركة بين كل مستخدمي هذا البرنامج</span>
        </div>
      </aside>

      <main className="content">
        {tab === "dashboard" && <Dashboard data={vd} />}
        {tab === "materials" && <MaterialsTab data={vd} persist={pv} currentUser={currentUser} />}
        {tab === "purchaseLog" && <PurchaseLogTab data={vd} />}
        {tab === "products" && <ProductsTab data={vd} persist={pv} currentUser={currentUser} />}
        {tab === "production" && <ProductionTab data={vd} persist={pv} currentUser={currentUser} />}
        {tab === "finished" && <FinishedStockTab data={vd} persist={pv} currentUser={currentUser} webState={webState} onPush={forcePushStock} />}
        {tab === "invoices" && <InvoicesTab data={data} persist={persist} currentUser={currentUser} />}
        {tab === "webOrders" && <WebOrdersTab data={data} webState={webState} onSync={syncWebOrders} onImport={importManualWebOrder} fulfil={fulfil} onReloadFulfil={loadFulfillment} onChangeStatus={changeFulfillment} transfers={transfers} onTransfer={transferAction} />}
        {tab === "offers" && <OffersTab />}
        {tab === "marketers" && <MarketersTab />}
        {tab === "accounts" && <AccountsTab data={data} persist={persist} currentUser={currentUser} />}
        {tab === "expenses" && <ExpensesTab data={data} persist={persist} currentUser={currentUser} />}
        {tab === "vat" && <VatTab data={vd} />}
        {tab === "customers" && <CustomersTab data={vd} persist={pv} />}
        {tab === "marketing" && <MarketingTab data={vd} persist={pv} currentUser={currentUser} />}
        {tab === "losses" && <LossesTab data={vd} persist={pv} currentUser={currentUser} />}
        {tab === "equipment" && <EquipmentTab data={vd} persist={pv} currentUser={currentUser} />}
        {tab === "branding" && <BrandingTab data={vd} persist={pv} currentUser={currentUser} />}
        {tab === "audit" && <AuditTab data={data} />}
        {tab === "settings" && <SettingsTab data={data} persist={persist} currentUser={currentUser} />}
      </main>


    </div>
  );
}

/* ============================== dashboard ============================== */

function periodRange(kind, today, cFrom, cTo) {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const pad = (n) => String(n).padStart(2, "0");
  const last = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  if (kind === "month") return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last(y, m))}`, label: `${AR_MONTHS[m - 1]} ${y}` };
  if (kind === "prevmonth") { const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y; return { from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${pad(last(py, pm))}`, label: `${AR_MONTHS[pm - 1]} ${py}` }; }
  if (kind === "quarter") { const q = Math.floor((m - 1) / 3), m0 = q * 3 + 1; return { from: `${y}-${pad(m0)}-01`, to: `${y}-${pad(m0 + 2)}-${pad(last(y, m0 + 2))}`, label: `الربع ${q + 1} · ${y}` }; }
  if (kind === "year") return { from: `${y}-01-01`, to: `${y}-12-31`, label: `سنة ${y}` };
  if (kind === "custom") return { from: cFrom || "", to: cTo || "", label: `${cFrom || "…"} → ${cTo || "…"}` };
  return { from: "", to: "", label: "كل الفترات" };
}

function profitTotals(data, fullEquipment, from, to) {
  const agg = computeAllProductAgg(data);
  const totalRevenue = agg.reduce((s, a) => s + a.revenue, 0);
  const totalCOGS = agg.reduce((s, a) => s + a.cogs, 0);
  const totalMarketing = data.marketing.reduce((s, m) => s + (Number(m.cost) || 0), 0);
  const totalLosses = data.losses.reduce((s, l) => s + (Number(l.costTotal) || 0), 0);
  const totalBranding = data.branding.reduce((s, b) => s + (Number(b.cost) || 0), 0);
  const totalEquipmentAssets = data.equipment.reduce((s, e) => s + (Number(e.cost) || 0), 0);
  const totalCommission = agg.reduce((s, a) => s + a.commission, 0);
  const outputVat = agg.reduce((s, a) => s + a.vat, 0);
  const inputVat = inputVatItems(data).reduce((s, x) => s + x.amount, 0);
  const totalVat = outputVat - inputVat; // صافي الضريبة المستحقة (مبيعات − مشتريات)
  const grossProfit = totalRevenue - totalCOGS;
  const totalFees = (data.bankTxns || []).filter((t) => t.kind === "settlement").reduce((a, t) => a + settlementFee(t), 0);
  const totalExpenses = (data.expenses || []).reduce((a, x) => a + (Number(x.amount) || 0), 0);
  const depreciation = depreciationInPeriod(fullEquipment, from, to);
  const depInProfit = !!(data.settings && data.settings.depreciationInProfit);
  const operatingNetProfit = grossProfit - totalMarketing - totalLosses - totalCommission - totalVat - totalFees - totalExpenses - (depInProfit ? depreciation : 0);
  return { agg, totalExpenses, totalFees, totalRevenue, totalCOGS, totalMarketing, totalLosses, totalCommission, outputVat, inputVat, totalVat, totalBranding, totalEquipmentAssets, grossProfit, depreciation, depInProfit, operatingNetProfit };
}

function printPnL(label, t, partnerRows, devPercent, devShare) {
  const row = (name, v, strong) => `<div class="totals-row"${strong ? ' style="font-weight:700"' : ""}><span>${name}</span><span><bdi>${fmt(v)} ر.ع</bdi></span></div>`;
  const html = `
    <div class="accent-bar"></div>
    <div class="sheet">
      <div class="print-head">
        <div class="head-col head-brand"><div class="print-brand">SILENT CODE</div><div class="print-tagline">تقرير الأرباح والخسائر — ${escHtml(label)}</div></div>
        <div class="head-col head-meta"><div class="print-meta-line"><div>أصيل الفخامة ش.م.م — سجل تجاري 1648344</div></div></div>
      </div>
      <div class="totals-wrap"><div class="totals" style="width:100%">
        ${row("إجمالي الإيرادات (قبل الشحن)", t.totalRevenue, true)}
        ${row("− تكلفة البضاعة المباعة", t.totalCOGS)}
        ${row("= الربح الإجمالي", t.grossProfit, true)}
        ${row("− مصاريف التسويق والسامبلات", t.totalMarketing)}
        ${row("− خسائر التصنيع", t.totalLosses)}
        ${row("− عمولات المسوّقين", t.totalCommission)}
        ${row("− رسوم بوابة الدفع", t.totalFees)}
        ${row("− مصروفات أخرى", t.totalExpenses)}
        ${row("− ضريبة القيمة المضافة المستحقة (مبيعات " + fmt(t.outputVat) + " − مشتريات " + fmt(t.inputVat) + ")", t.totalVat)}
        ${t.depInProfit ? row("− إهلاك الأصول الثابتة", t.depreciation) : ""}
        <div class="grand-total"><span>الربح التشغيلي الصافي</span><span><bdi>${fmt(t.operatingNetProfit)} ر.ع</bdi></span></div>
        ${row("نصيب تطوير المشروع (" + devPercent + "%)", devShare)}
        ${partnerRows.map((p) => row(escHtml(p.name) + " — النصيب " + fmt(p.share) + " | المسحوب " + fmt(p.drawn), p.share - p.drawn)).join("")}
      </div></div>
      <div class="foot"><div class="foot-note">تقرير داخلي مستخرج من البرنامج. الشحن مبلغ تمرير ولا يدخل الإيراد ولا الربح. يُراجع مع محاسب قبل أي استخدام رسمي.</div></div>
    </div>`;
  openPrintWindow("ar", html);
}

function Dashboard({ data: full }) {
  const [range, setRange] = useState("all");
  const [cFrom, setCFrom] = useState("");
  const [cTo, setCTo] = useState("");
  const today = muscatDate(new Date().toISOString());
  const { from, to, label } = useMemo(() => periodRange(range, today, cFrom, cTo), [range, today, cFrom, cTo]);
  const data = useMemo(() => dataForPeriod(full, from, to), [full, from, to]);
  const totals = useMemo(() => profitTotals(data, full.equipment, from, to), [data, full.equipment, from, to]);
  const agg = totals.agg;

  const lowStock = data.materials.filter((m) => (Number(m.stock) || 0) <= (Number(m.minThreshold) || 0));

  const devPercent = Number(data.settings.devPercent) || 0;
  const devShare = totals.operatingNetProfit * (devPercent / 100);
  const remaining = totals.operatingNetProfit - devShare;
  const partners = data.settings.partners || [];
  const partnerRows = partners.map((p) => {
    const mine = (data.bankTxns || []).filter((t) => t.partnerId === p.id);
    return {
      id: p.id, name: p.name, percent: p.percent,
      share: remaining * ((Number(p.percent) || 0) / 100),
      drawn: mine.filter((t) => t.kind === "partner_draw").reduce((x, t) => x + (Number(t.amount) || 0), 0),
      capital: mine.filter((t) => t.kind === "capital").reduce((x, t) => x + (Number(t.amount) || 0), 0),
    };
  });

  const profitColor = totals.operatingNetProfit >= 0 ? "var(--success)" : "var(--danger)";
  const groups = [
    { title: "الأداء", items: [
      { label: "إجمالي الإيرادات", value: totals.totalRevenue, color: "var(--teal)", Icon: TrendingUp },
      { label: "تكلفة البضاعة المباعة", value: totals.totalCOGS, color: "var(--copper)", Icon: Package },
      { label: "الربح الإجمالي", value: totals.grossProfit, color: "var(--teal-dark)", Icon: TrendingUp },
    ] },
    { title: "المصاريف والخصومات", items: [
      { label: "مصاريف التسويق", value: totals.totalMarketing, color: "#3D6B8C", Icon: Megaphone },
      { label: "خسائر التصنيع", value: totals.totalLosses, color: "var(--danger)", Icon: AlertTriangle },
      { label: "عمولات المسوّقين", value: totals.totalCommission, color: "#8C6B3D", Icon: Users },
      { label: "رسوم بوابة الدفع (ثواني)", value: totals.totalFees, color: "#8C3D5A", Icon: Wallet },
      { label: "مصروفات أخرى", value: totals.totalExpenses, color: "#8C4B3D", Icon: Receipt },
      ...(totals.depInProfit ? [{ label: "إهلاك الأصول", value: totals.depreciation, color: "#5C6A63", Icon: Wrench }] : []),
    ] },
    { title: "ضريبة القيمة المضافة 5%", items: [
      { label: "ضريبة المبيعات", value: totals.outputVat, color: "#6B4C8C", Icon: Receipt },
      { label: "ضريبة المشتريات (تُخصم)", value: totals.inputVat, color: "#6B4C8C", Icon: Receipt },
      { label: "صافي الضريبة المحجوزة", value: totals.totalVat, color: "#6B4C8C", Icon: Receipt },
    ] },
  ];

  const chartData = data.products.map((p) => {
    const a = agg.find((x) => x.product.id === p.id);
    return {
      name: p.name.length > 10 ? p.name.slice(0, 10) + "…" : p.name,
      الإيراد: Number((a?.revenue || 0).toFixed(3)),
      التكلفة: Number((a?.cogs || 0).toFixed(3)),
    };
  });

  const chips = [["all", "الكل"], ["month", "هذا الشهر"], ["prevmonth", "الشهر الماضي"], ["quarter", "هذا الربع"], ["year", "هذه السنة"], ["custom", "فترة مخصصة"]];

  return (
    <div className="page">
      <PageHead eyebrow="نظرة عامة" title="لوحة التحكم" desc="ملخص أداء البزنس من التصنيع للبيع"
        action={<button className="btn-ghost" onClick={() => printPnL(label, totals, partnerRows, devPercent, devShare)}><Printer size={15} /> تقرير الأرباح والخسائر</button>} />

      <div className="period-bar">
        {chips.map(([k, l]) => <button key={k} className={`chip-btn ${range === k ? "on" : ""}`} onClick={() => setRange(k)}>{l}</button>)}
        {range === "custom" && (
          <>
            <input type="date" value={cFrom} onChange={(e) => setCFrom(e.target.value)} />
            <span className="field-hint">إلى</span>
            <input type="date" value={cTo} onChange={(e) => setCTo(e.target.value)} />
          </>
        )}
        <span className="period-label">الفترة المعروضة: <strong>{label}</strong></span>
      </div>

      <div className="profit-hero" style={{ "--accent": profitColor }}>
        <div>
          <div className="kpi-label">الربح التشغيلي الصافي — {label}</div>
          <div className="profit-value">{fmt(totals.operatingNetProfit)} <span className="unit">ر.ع</span></div>
        </div>
        <div className="profit-note">= الربح الإجمالي − التسويق − الخسائر − العمولات − رسوم البوابة − المصروفات − صافي الضريبة{totals.depInProfit ? " − الإهلاك" : ""}</div>
      </div>

      {groups.map((g) => (
        <div key={g.title} className="kpi-group">
          <div className="kpi-group-title">{g.title}</div>
          <div className="kpi-row">
            {g.items.map((k) => (
              <div className="kpi-card" key={k.label} style={{ "--accent": k.color }}>
                <k.Icon size={16} className="kpi-icon" />
                <div className="kpi-label">{k.label}</div>
                <div className="kpi-value">{fmt(k.value)} <span className="unit">ر.ع</span></div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {lowStock.length > 0 && (
        <div className="alert-banner">
          <AlertCircle size={16} />
          <span>
            فيه {lowStock.length} مادة وصلت للحد الأدنى أو أقل: {lowStock.map((m) => m.name).join("، ")}
          </span>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h3>توزيع الربح التشغيلي على الشراكة</h3>
          <span className="panel-sub">بعد خصم كل المصاريف والضريبة — والمسحوب من سجل «سحوبات الشركاء» في تبويب الحسابات</span>
        </div>
        <div className="split-row">
          <div className="split-card">
            <span>تطوير المشروع ({devPercent}%)</span>
            <strong>{fmt(devShare)} ر.ع</strong>
          </div>
          {partnerRows.map((p) => (
            <div className="split-card" key={p.id}>
              <span>{p.name} ({p.percent}% من الباقي)</span>
              <strong>{fmt(p.share)} ر.ع</strong>
              <small>مسحوب: {fmt(p.drawn)} · المتبقي: {fmt(p.share - p.drawn)}{p.capital > 0 ? ` · رأس مال مودَع: ${fmt(p.capital)}` : ""}</small>
            </div>
          ))}
        </div>
        <div className="branding-note">
          إجمالي استثمار التأسيس/البراند بالفترة: <strong>{fmt(totals.totalBranding)} ر.ع</strong> — وإجمالي المعدات والأصول الثابتة المشتراة بالفترة: <strong>{fmt(totals.totalEquipmentAssets)} ر.ع</strong>. المستلزمات الاستهلاكية المرتبطة بالتصنيع (كمامات، قفازات...) تُضاف كمواد بالمخزون وتدخل ضمن وصفة المنتج فتنعكس على تكلفة الوحدة.
        </div>
      </div>

      {data.products.length === 0 ? (
        <Empty icon={Package} title="ابدأ بإضافة أول مادة ومنتج" sub="روح لتبويب «المخزون والمواد» أول شي، بعدها «المنتجات والوصفات»." />
      ) : (
        <>
          <div className="panel">
            <div className="panel-head"><h3>الإيراد مقابل التكلفة لكل منتج</h3></div>
            <div style={{ width: "100%", height: 300 }}>
              <ResponsiveContainer>
                <BarChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E3DCCB" />
                  <XAxis dataKey="name" tick={{ fontSize: 12, fill: "#5C6A63" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#5C6A63" }} />
                  <Tooltip contentStyle={{ fontFamily: "Cairo", direction: "rtl", borderRadius: 8, borderColor: "#E3DCCB" }} formatter={(v) => `${fmt(v)} ر.ع`} />
                  <Legend wrapperStyle={{ fontFamily: "Cairo", fontSize: 12 }} />
                  <Bar dataKey="الإيراد" fill="#0E6E5B" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="التكلفة" fill="#B9702E" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>نسب كل منتج</h3>
              <span className="panel-sub">هامش الربح ونسبة التسويق (مباشر + موزّع من الحملات العامة)</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>المنتج</th><th>الكمية المباعة</th><th>الإيراد</th><th>تكلفة الوحدة</th>
                    <th>مصدر التكلفة</th><th>الربح الإجمالي</th><th>هامش الربح</th><th>% التسويق</th>
                  </tr>
                </thead>
                <tbody>
                  {agg.map((a) => {
                    const margin = a.revenue > 0 ? (a.grossProfit / a.revenue) * 100 : 0;
                    const mktPct = a.revenue > 0 ? (a.marketingTotal / a.revenue) * 100 : 0;
                    return (
                      <tr key={a.product.id}>
                        <td className="strong">{a.product.name}</td>
                        <td className="num">{a.qty}</td>
                        <td className="num">{fmt(a.revenue)}</td>
                        <td className="num">{fmt(a.unitCost)}</td>
                        <td><span className={`badge ${a.costSource === "batches" ? "green" : "blue"}`}>{a.costSource === "batches" ? "دفعات فعلية" : "تقدير الوصفة"}</span></td>
                        <td className={`num ${a.grossProfit >= 0 ? "pos" : "neg"}`}>{fmt(a.grossProfit)}</td>
                        <td className="num">{pct(margin)}</td>
                        <td className="num">{pct(mktPct)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ============================== materials / inventory ============================== */

function emptyMaterial() {
  return { id: uid("mat"), code: "", name: "", unit: "مل", stock: "", avgCost: "", minThreshold: "" };
}
function emptyPurchase(nextNo) {
  return {
    id: uid("pur"), number: nextNo, date: todayStr(), note: "", paidFrom: "sohar", vatPaid: "",
    lines: [{ id: uid("pl"), materialId: "", qty: "", unitCost: "", currency: "OMR", supplierInvoiceNo: "", supplierName: "", lineNote: "" }],
    extraCosts: [],
    attachments: [],
  };
}

function MaterialsTab({ data, persist, currentUser }) {
  const [editingMat, setEditingMat] = useState(null);
  const [purchase, setPurchase] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmState, setConfirmState] = useState(null);

  function saveMaterial(m) {
    const exists = data.materials.some((x) => x.id === m.id);
    const materials = exists ? data.materials.map((x) => (x.id === m.id ? m : x)) : [...data.materials, { ...m, createdBy: currentUser?.name }];
    persist({ ...data, materials });
    setEditingMat(null);
  }
  function removeMaterial(id) {
    const mat = data.materials.find((m) => m.id === id);
    const usedIn = [];
    if (data.products.some((p) => (p.recipe || []).some((l) => l.materialId === id))) usedIn.push("وصفة منتج");
    if (data.purchases.some((p) => (p.lines || []).some((l) => l.materialId === id))) usedIn.push("سجل مشتريات");
    if (data.batches.some((b) => (b.lines || []).some((l) => l.materialId === id))) usedIn.push("دفعة إنتاج");
    if (data.invoices.some((i) => (i.overheadUsage || []).some((u) => u.materialId === id))) usedIn.push("فاتورة بيع");
    if (usedIn.length) {
      setConfirmState({
        info: true,
        message: `ما تقدر تحذف «${mat?.name || ""}» لأنها مستخدمة في: ${usedIn.join("، ")}. الحذف بيخرّب تكلفة المنتجات والسجلات القديمة. لو ما تبيها بعد، خلّ كميتها صفر.`,
        onConfirm: () => {},
      });
      return;
    }
    setConfirmState({
      message: "تأكيد حذف المادة؟",
      onConfirm: () => persist({ ...data, materials: data.materials.filter((m) => m.id !== id) }),
    });
  }
  function removePurchase(id) {
    const pur = data.purchases.find((p) => p.id === id);
    if (!pur) return;
    if (isLocked(data, pur.date)) { alert(lockMsg(data)); return; }
    const res = recomputeMaterialsForPurchaseChange(data, pur, null);
    if (res.error) { alert(res.error); return; }
    setConfirmState({
      message: "تأكيد حذف سجل الشراء؟ بيرجع المخزون ومتوسط التكلفة للمواد المتأثرة تلقائيًا، وراح يحذف أي مرفقات فاتورة من Google Drive.",
      onConfirm: () => {
        (pur.attachments || []).forEach((att) => { if (att.fileId) deleteFromGoogleDrive(att.fileId); });
        persist({ ...data, materials: res.materials, purchases: data.purchases.filter((p) => p.id !== id) });
      },
    });
  }
  function editPurchase(pur) {
    // نرجّع للمستخدم السعر بعملته الأصلية (مو بعد تحويلها لريال عماني) عشان التعديل يفتح بنفس القيم اللي أدخلها أول مرة
    setPurchase({
      ...pur,
      lines: pur.lines.map((l) => ({ ...l, unitCost: l.unitCostOriginal !== undefined ? l.unitCostOriginal : l.unitCost })),
      extraCosts: (pur.extraCosts || []).map((e) => ({ ...e, amount: e.amountOriginal !== undefined ? e.amountOriginal : e.amount })),
    });
  }
  function savePurchase(pur, pendingDeletes) {
    const oldPur = data.purchases.find((p) => p.id === pur.id);
    const isEdit = !!oldPur;
    if (isLocked(data, pur.date) || (oldPur && isLocked(data, oldPur.date))) { alert(lockMsg(data)); return false; }
    const validLines = convertLinesToOMR(pur.lines.filter((l) => l.materialId && l.qty));
    const extraCosts = convertExtrasToOMR(pur.extraCosts);
    const allocated = allocatePurchaseLines(validLines, extraCosts);

    let materials;
    let purchases;
    if (isEdit) {
      // تعديل: نفس رقم السجل ونفس المكان — ما يتحول لشراء جديد، والمخزون يتصحح بإعادة حساب كامل
      const updated = { ...pur, lines: allocated, extraCosts, createdBy: oldPur.createdBy, editedBy: currentUser?.name, editedAt: new Date().toISOString() };
      const res = recomputeMaterialsForPurchaseChange(data, oldPur, updated);
      if (res.error) { alert(res.error); return false; }
      materials = res.materials;
      purchases = data.purchases.map((p) => (p.id === pur.id ? updated : p));
    } else {
      materials = data.materials.map((m) => {
        let cur = { stock: Number(m.stock) || 0, avg: Number(m.avgCost) || 0 };
        let touched = false;
        allocated.forEach((l) => {
          if (l.materialId !== m.id) return;
          cur = applyBuy(cur.stock, cur.avg, Number(l.qty) || 0, l.landedUnitCost);
          touched = true;
        });
        return touched ? { ...m, stock: ledgerRound(cur.stock), avgCost: ledgerRound(cur.avg) } : m;
      });
      purchases = [...data.purchases, { ...pur, lines: allocated, extraCosts, createdBy: currentUser?.name }];
    }

    const nextPurchaseNo = Math.max(Number(data.nextPurchaseNo) || 1001, (Number(pur.number) || 0) + 1);
    persist({ ...data, materials, purchases, nextPurchaseNo });
    (pendingDeletes || []).forEach((fileId) => deleteFromGoogleDrive(fileId));
    setPurchase(null);
    return true;
  }

  return (
    <div className="page">
      <PageHead
        eyebrow="المخزون"
        title="المخزون والمواد"
        desc="كل مادة أو قطعة تدخل بالمنتج (زيوت، كحول، قوارير، علب، أغطية...) — والتكلفة تتحدث تلقائيًا كمتوسط مرجّح مع كل عملية شراء"
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-ghost" onClick={() => setEditingMat({ ...emptyMaterial(), code: nextCode(data.materials, "M-") })}><Plus size={15} /> مادة جديدة</button>
            <button className="btn-primary" onClick={() => setPurchase(emptyPurchase(data.nextPurchaseNo))} disabled={data.materials.length === 0}>
              <ShoppingCart size={15} /> تسجيل شراء
            </button>
          </div>
        }
      />

      {data.materials.length === 0 ? (
        <Empty icon={Boxes} title="ما فيه مواد بعد" sub="اضغط «مادة جديدة» وسجل أول مادة خام أو علبة أو قارورة." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>الكود</th><th>المادة</th><th>الوحدة</th><th>الكمية المتوفرة</th><th>متوسط التكلفة</th><th>الحد الأدنى</th><th></th></tr>
            </thead>
            <tbody>
              {data.materials.map((m) => {
                const low = (Number(m.stock) || 0) <= (Number(m.minThreshold) || 0);
                return (
                  <tr key={m.id}>
                    <td><span className="badge blue">{m.code || "—"}</span></td>
                    <td className="strong">{m.name}</td>
                    <td>{m.unit}</td>
                    <td className={`num ${low ? "stock-low" : ""}`}>{m.stock || 0} {low && <AlertCircle size={12} style={{ display: "inline", verticalAlign: "-1px" }} />}</td>
                    <td className="num">{fmt(m.avgCost)} ر.ع</td>
                    <td className="num">{m.minThreshold || 0}</td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button className="icon-btn" onClick={() => setEditingMat(m)}><Pencil size={13} /></button>
                        <button className="icon-btn danger" onClick={() => removeMaterial(m.id)}><Trash2 size={13} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <button className="link-btn" onClick={() => setShowHistory((s) => !s)}>
          <ChevronLeft size={14} className={`chev ${showHistory ? "open" : ""}`} />
          {showHistory ? "إخفاء سجل المشتريات" : "عرض سجل المشتريات"}
        </button>
        {showHistory && (
          data.purchases.length === 0 ? (
            <p className="empty-sub" style={{ marginTop: 8 }}>ما فيه عمليات شراء مسجلة بعد.</p>
          ) : (
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>التاريخ</th><th>ملاحظة</th><th>المواد</th><th>تكاليف إضافية</th><th>بواسطة</th><th></th></tr></thead>
                <tbody>
                  {[...data.purchases].reverse().map((pur) => (
                    <tr key={pur.id}>
                      <td>{pur.date}</td>
                      <td>{pur.note || "—"}</td>
                      <td>
                        {pur.lines.map((l) => {
                          const mat = data.materials.find((m) => m.id === l.materialId);
                          const supplierBits = [
                            l.supplierName && `المورد: ${l.supplierName}`,
                            l.supplierInvoiceNo && `فاتورة #${l.supplierInvoiceNo}`,
                            l.lineNote,
                          ].filter(Boolean).join(" · ");
                          return (
                            <div key={l.id} style={{ marginBottom: 4 }}>
                              <div className="num" style={{ fontSize: 11.5 }}>
                                {mat?.name || "—"}: {l.qty} × {fmt(l.landedUnitCost)} ر.ع{l.currency === "AED" ? ` (${fmt(l.unitCostOriginal)} د.إ)` : ""}
                              </div>
                              {supplierBits && <div style={{ fontSize: 10.5, color: "var(--ink-soft)" }}>{supplierBits}</div>}
                            </div>
                          );
                        })}
                      </td>
                      <td className="num">{fmt(pur.extraCosts.reduce((s, e) => s + (Number(e.amount) || 0), 0))} ر.ع</td>
                      <td>{pur.createdBy && <span className="badge blue">{pur.createdBy}</span>}{pur.editedBy && <span className="badge" style={{ marginRight: 4 }}>عُدّل: {pur.editedBy}</span>}</td>
                      <td>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button className="icon-btn" onClick={() => editPurchase(pur)}><Pencil size={13} /></button>
                          <button className="icon-btn danger" onClick={() => removePurchase(pur.id)}><Trash2 size={13} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>

      {editingMat && <MaterialEditor material={editingMat} others={data.materials} onSave={saveMaterial} onClose={() => setEditingMat(null)} />}
      {purchase && (
        <PurchaseEditor
          purchase={purchase}
          materials={data.materials}
          onSave={savePurchase}
          onClose={() => setPurchase(null)}
          isEdit={data.purchases.some((p) => p.id === purchase.id)}
        />
      )}
      <ConfirmModal state={confirmState} onCancel={() => setConfirmState(null)} />
    </div>
  );
}

function MaterialEditor({ material, others = [], onSave, onClose }) {
  const [m, setM] = useState(material);
  const isNew = !material.name;
  function set(f, v) { setM({ ...m, [f]: v }); }
  const code = (m.code || "").trim().toLowerCase();
  const dupCode = !!code && others.some((x) => x.id !== m.id && (x.code || "").trim().toLowerCase() === code);
  const dupName = others.some((x) => x.id !== m.id && (x.name || "").trim().toLowerCase() === m.name.trim().toLowerCase() && m.name.trim());
  const negative = ["stock", "avgCost", "minThreshold"].some((f) => m[f] !== "" && m[f] != null && Number(m[f]) < 0);
  const problem = !m.name.trim() ? "اكتب اسم المادة" : dupCode ? "هذا الكود مستخدم لمادة ثانية" : dupName ? "فيه مادة بنفس الاسم" : negative ? "ما يصير تحط رقم بالسالب" : "";
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>{isNew ? "مادة جديدة" : "تعديل مادة"}</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          <div className="form-row">
            <Field label="كود المادة" hint="يساعدك تلاقيها بسرعة بالقوائم"><input value={m.code} onChange={(e) => set("code", e.target.value)} placeholder="مثال: M-001" /></Field>
            <Field label="اسم المادة"><input value={m.name} onChange={(e) => set("name", e.target.value)} placeholder="مثال: زيت عود عطري" /></Field>
            <Field label="وحدة القياس">
              <select value={m.unit} onChange={(e) => set("unit", e.target.value)}>
                {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </Field>
          </div>
          <div className="form-row">
            <Field label="الحد الأدنى للتنبيه"><input type="number" value={m.minThreshold} onChange={(e) => set("minThreshold", e.target.value)} /></Field>
            <Field label={isNew ? "الكمية الابتدائية (اختياري)" : "الكمية الحالية"}>
              <input type="number" value={m.stock} onChange={(e) => set("stock", e.target.value)} />
            </Field>
            <Field
              label={isNew ? "تكلفة الوحدة الابتدائية (اختياري)" : "متوسط تكلفة الوحدة"}
              hint={isNew ? "" : "يتحدث تلقائيًا مع كل شراء، تقدر تصححه يدويًا لو احتجت"}
            >
              <input type="number" value={m.avgCost} onChange={(e) => set("avgCost", e.target.value)} />
            </Field>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>إلغاء</button>
          {problem && m.name.trim() !== "" && <span className="form-problem">{problem}</span>}
          <button className="btn-primary" disabled={!!problem} onClick={() => onSave({ ...m, name: m.name.trim(), code: (m.code || "").trim() })}>حفظ</button>
        </div>
      </div>
    </div>
  );
}

function PurchaseEditor({ purchase, materials, onSave, onClose, isEdit }) {
  const [pur, setPur] = useState(purchase);
  const [uploadingIds, setUploadingIds] = useState({});
  const [pendingDeletes, setPendingDeletes] = useState([]); // مرفقات قديمة انحذفت من النافذة، ما تنحذف من Drive إلا بعد الحفظ
  const originalAttIds = useRef(new Set((purchase.attachments || []).map((a) => a.id)));
  function handleClose() {
    // لو سكّر بدون حفظ: نحذف من Drive بس المرفقات اللي انرفعت بهذي الجلسة (القديمة تبقى)
    (pur.attachments || []).forEach((a) => { if (a.fileId && !originalAttIds.current.has(a.id)) deleteFromGoogleDrive(a.fileId); });
    onClose();
  }
  function set(f, v) { setPur({ ...pur, [f]: v }); }
  function setLine(id, f, v) { setPur({ ...pur, lines: pur.lines.map((l) => (l.id === id ? { ...l, [f]: v } : l)) }); }
  function addLine() { setPur({ ...pur, lines: [...pur.lines, { id: uid("pl"), materialId: "", qty: "", unitCost: "", currency: "OMR", supplierInvoiceNo: "", supplierName: "", lineNote: "" }] }); }
  function removeLine(id) { setPur({ ...pur, lines: pur.lines.filter((l) => l.id !== id) }); }
  function setExtra(id, f, v) { setPur({ ...pur, extraCosts: pur.extraCosts.map((e) => (e.id === id ? { ...e, [f]: v } : e)) }); }
  function addExtra() { setPur({ ...pur, extraCosts: [...pur.extraCosts, { id: uid("ec"), label: "", amount: "", currency: "OMR" }] }); }
  function removeExtra(id) { setPur({ ...pur, extraCosts: pur.extraCosts.filter((e) => e.id !== id) }); }

  async function handleAttachFile(fileList) {
    const file = fileList?.[0];
    if (!file) return;
    const tempId = uid("att");
    setUploadingIds((u) => ({ ...u, [tempId]: true }));
    try {
      const label = window.prompt("وصف مختصر للمرفق (اختياري، مثلاً: فاتورة شركة الورد)", "") || "";
      const blob = await prepareInvoiceFileForUpload(file);
      const fileName = buildPurchaseFileName(pur, materials, label);
      const { fileId, url } = await uploadToGoogleDrive(fileName, blob);
      setPur((p) => ({ ...p, attachments: [...(p.attachments || []), { id: tempId, label, fileName, url, fileId }] }));
    } catch (e) {
      console.error("attachment upload error", e);
      alert("صار خطأ أثناء رفع المرفق لـ Google Drive، حاول مرة ثانية.");
    }
    setUploadingIds((u) => { const n = { ...u }; delete n[tempId]; return n; });
  }
  function removeAttachment(id) {
    const att = (pur.attachments || []).find((a) => a.id === id);
    setPur({ ...pur, attachments: (pur.attachments || []).filter((a) => a.id !== id) });
    if (!att?.fileId) return;
    if (originalAttIds.current.has(id)) setPendingDeletes((d) => [...d, att.fileId]);
    else deleteFromGoogleDrive(att.fileId);
  }

  const validLines = pur.lines.filter((l) => l.materialId && l.qty);
  const allocated = allocatePurchaseLines(convertLinesToOMR(validLines), convertExtrasToOMR(pur.extraCosts));
  const canSave = validLines.length > 0;
  const hasAED = validLines.some((l) => l.currency === "AED") || pur.extraCosts.some((e) => e.currency === "AED");
  const isUploading = Object.keys(uploadingIds).length > 0;

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>{isEdit ? "تعديل" : "تسجيل"} عملية شراء #{pur.number}</h3><button className="icon-btn" onClick={handleClose}><X size={18} /></button></div>
        <div className="modal-body">
          {isEdit && (
            <p className="field-hint" style={{ marginBottom: 10, background: "var(--panel-soft, #fff7e0)", padding: 8, borderRadius: 8 }}>
              ✔ التعديل يحدّث نفس سجل الشراء (ما يضيف شراء جديد) ويعيد حساب كمية ومتوسط تكلفة المواد المتأثرة بدقة، حسب ترتيب التواريخ وبعد احتساب اللي انستهلك بالإنتاج. لو التعديل بيخلي المخزون ناقص، البرنامج يرفضه ويوضح السبب.
            </p>
          )}
          <div className="form-row">
            <Field label="التاريخ"><input type="date" value={pur.date} onChange={(e) => set("date", e.target.value)} /></Field>
            <Field label="ملاحظة (مثال: رحلة مسقط لجلب المواد)"><input value={pur.note} onChange={(e) => set("note", e.target.value)} /></Field>
          </div>
          <div className="form-row">
            <PaidFromField value={pur.paidFrom} onChange={(v) => set("paidFrom", v)} />
            <VatPaidField value={pur.vatPaid} onChange={(v) => set("vatPaid", v)} />
          </div>

          <div className="sub-head">المواد المشتراة</div>
          <p className="field-hint" style={{ marginBottom: 8 }}>لو اشتريت بالدرهم الإماراتي، اختر "د.إ" جنب السعر وبيتحول تلقائيًا للريال العماني (1000 د.إ = 105 ر.ع). خانات الفاتورة والمورد اختيارية لكل مادة لو تحتاجها.</p>
          <div className="materials-list">
            {pur.lines.map((l) => {
              const mat = materials.find((m) => m.id === l.materialId);
              return (
                <div className="purchase-line-block" key={l.id}>
                  <div className="purchase-line-row">
                    <select value={l.materialId} onChange={(e) => setLine(l.id, "materialId", e.target.value)}>
                      <option value="">اختر مادة</option>
                      {materials.map((m) => <option key={m.id} value={m.id}>{materialLabel(m)}</option>)}
                    </select>
                    <input type="number" placeholder={`الكمية${mat ? " (" + mat.unit + ")" : ""}`} value={l.qty} onChange={(e) => setLine(l.id, "qty", e.target.value)} />
                    <input type="number" placeholder="سعر الوحدة" value={l.unitCost} onChange={(e) => setLine(l.id, "unitCost", e.target.value)} />
                    <select value={l.currency || "OMR"} onChange={(e) => setLine(l.id, "currency", e.target.value)}>
                      <option value="OMR">ر.ع</option>
                      <option value="AED">د.إ</option>
                    </select>
                    <button className="icon-btn danger" onClick={() => removeLine(l.id)}><Trash2 size={14} /></button>
                  </div>
                  <div className="purchase-line-extra">
                    <input placeholder="رقم فاتورة المورد (اختياري)" value={l.supplierInvoiceNo} onChange={(e) => setLine(l.id, "supplierInvoiceNo", e.target.value)} />
                    <input placeholder="اسم المورد (اختياري)" value={l.supplierName} onChange={(e) => setLine(l.id, "supplierName", e.target.value)} />
                    <input placeholder="ملاحظات (اختياري)" value={l.lineNote} onChange={(e) => setLine(l.id, "lineNote", e.target.value)} />
                  </div>
                </div>
              );
            })}
            <button className="link-btn" onClick={addLine}><Plus size={14} /> إضافة مادة</button>
          </div>

          <div className="sub-head">تكاليف إضافية للرحلة (بترول، فندق، مواصلات...)</div>
          <div className="trip-costs">
            {pur.extraCosts.length === 0 && <p className="empty-sub" style={{ margin: 0 }}>ما فيه تكاليف إضافية — اضغط + لو تبي تضيف.</p>}
            {pur.extraCosts.map((e) => (
              <div className="purchase-extra-row" key={e.id}>
                <input placeholder="نوع التكلفة (بترول، فندق...)" value={e.label} onChange={(ev) => setExtra(e.id, "label", ev.target.value)} />
                <input type="number" placeholder="المبلغ" value={e.amount} onChange={(ev) => setExtra(e.id, "amount", ev.target.value)} />
                <select value={e.currency || "OMR"} onChange={(ev) => setExtra(e.id, "currency", ev.target.value)}>
                  <option value="OMR">ر.ع</option>
                  <option value="AED">د.إ</option>
                </select>
                <button className="icon-btn danger" onClick={() => removeExtra(e.id)}><Trash2 size={14} /></button>
              </div>
            ))}
            <button className="link-btn" onClick={addExtra}><Plus size={14} /> إضافة تكلفة</button>
          </div>

          {allocated.length > 0 && (
            <div className="mini-list" style={{ marginTop: 12 }}>
              <div className="mini-list-title">معاينة التكلفة الفعلية بعد توزيع التكاليف الإضافية (بالريال العماني)</div>
              {allocated.map((l) => {
                const mat = materials.find((m) => m.id === l.materialId);
                return (
                  <div className="mini-list-row" key={l.id}>
                    <span>{mat?.name}{l.currency === "AED" ? ` (أدخلت ${fmt(l.unitCostOriginal)} د.إ)` : ""}</span>
                    <span className="num">{fmt(l.landedUnitCost)} ر.ع / {mat?.unit}</span>
                  </div>
                );
              })}
              {hasAED && <p className="field-hint" style={{ marginTop: 6 }}>سعر التحويل المستخدم: 1000 د.إ = 105 ر.ع</p>}
            </div>
          )}

          <div className="sub-head">مرفقات فاتورة الشراء (اختياري)</div>
          <p className="field-hint" style={{ marginBottom: 8 }}>صوّر فاتورة المورد أو ارفع ملف PDF — يتحول تلقائيًا لملف PDF مضغوط ويُرفع لحساب Google Drive الخاص بك (بعيد عن قاعدة البيانات الأساسية). أول مرة، بيطلب منك تسجيل دخول والموافقة.</p>
          <div className="trip-costs">
            {(pur.attachments || []).length === 0 && Object.keys(uploadingIds).length === 0 && (
              <p className="empty-sub" style={{ margin: "0 0 8px" }}>ما فيه مرفقات بعد.</p>
            )}
            {(pur.attachments || []).map((att) => (
              <div className="attachment-row" key={att.id}>
                <span className="num">📎 {att.label ? `${att.label} — ` : ""}{att.fileName}</span>
                <a className="icon-btn" href={att.url} target="_blank" rel="noopener noreferrer">تحميل</a>
                <button className="icon-btn danger" onClick={() => removeAttachment(att.id)}><Trash2 size={14} /></button>
              </div>
            ))}
            {Object.keys(uploadingIds).map((tid) => (
              <div className="attachment-row" key={tid}><span className="num">جاري رفع ومعالجة الملف...</span></div>
            ))}
            <label className="link-btn" style={{ cursor: "pointer" }}>
              <Plus size={14} /> إضافة مرفق
              <input
                type="file" accept="image/*,application/pdf" style={{ display: "none" }}
                onChange={(e) => { handleAttachFile(e.target.files); e.target.value = ""; }}
              />
            </label>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={handleClose}>إلغاء</button>
          <button className="btn-primary" disabled={!canSave || isUploading} onClick={() => onSave(pur, pendingDeletes)}>
            {isUploading ? "بانتظار اكتمال الرفع..." : isEdit ? "حفظ التعديلات" : "حفظ الشراء"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================== purchase log ============================== */

function PurchaseLogTab({ data }) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [openId, setOpenId] = useState(null);

  const filtered = data.purchases.filter((pur) => (!dateFrom || pur.date >= dateFrom) && (!dateTo || pur.date <= dateTo));
  const isFiltering = dateFrom || dateTo;
  const totalSpend = filtered.reduce(
    (s, pur) => s + (pur.lines || []).reduce((ls, l) => ls + (Number(l.landedTotal) || 0), 0),
    0
  );

  return (
    <div className="page">
      <PageHead
        eyebrow="المشتريات"
        title="سجل المشتريات"
        desc="كل عمليات الشراء بالتفصيل، مع مرفقات فواتير الموردين — فلترة حسب التاريخ وتحميل أي فاتورة وقت ما تحتاجها"
      />

      {data.purchases.length === 0 ? (
        <Empty icon={FileText} title="ما فيه مشتريات مسجلة بعد" sub="سجّل أول عملية شراء من تبويب «المخزون والمواد»." />
      ) : (
        <>
          <div className="panel">
            <div className="panel-head"><h3>فلترة حسب التاريخ</h3></div>
            <div className="form-row">
              <Field label="من تاريخ"><input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} /></Field>
              <Field label="إلى تاريخ"><input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} /></Field>
              {isFiltering && (
                <div style={{ display: "flex", alignItems: "flex-end" }}>
                  <button className="btn-ghost" onClick={() => { setDateFrom(""); setDateTo(""); }}>مسح الفلتر</button>
                </div>
              )}
            </div>
            {isFiltering && (
              <div className="calc-summary">
                <div><span>عدد عمليات الشراء</span><strong>{filtered.length}</strong></div>
                <div><span>إجمالي الصرف بالفترة</span><strong>{fmt(totalSpend)} ر.ع</strong></div>
              </div>
            )}
          </div>

          {filtered.length === 0 ? (
            <Empty icon={FileText} title="ما فيه مشتريات بهالفترة" sub="جرب توسّع نطاق التاريخ." />
          ) : (
            <div className="invoice-list">
              {[...filtered].reverse().map((pur) => {
                const open = openId === pur.id;
                const lineTotal = (pur.lines || []).reduce((s, l) => s + (Number(l.landedTotal) || 0), 0);
                const extraTotal = (pur.extraCosts || []).reduce((s, e) => s + (Number(e.amount) || 0), 0);
                return (
                  <div className="ticket" key={pur.id}>
                    <div className="ticket-main">
                      <div className="ticket-top">
                        <span className="ticket-no">شراء #{pur.number || "—"}</span>
                        <span className="ticket-date">{pur.date}</span>
                        {(pur.attachments || []).length > 0 && <span className="badge green">📎 {pur.attachments.length}</span>}
                      </div>
                      {pur.note && <div className="ticket-customer">{pur.note}</div>}
                      <div className="ticket-items">
                        {(pur.lines || []).map((l) => {
                          const mat = data.materials.find((m) => m.id === l.materialId);
                          return <span key={l.id} className="chip">{mat?.name || "—"} × {l.qty}</span>;
                        })}
                      </div>
                    </div>
                    <div className="ticket-side">
                      <div className="ticket-total">{fmt(lineTotal + extraTotal)} ر.ع</div>
                      <div className="ticket-actions">
                        <button className="link-btn" onClick={() => setOpenId(open ? null : pur.id)}>
                          <ChevronLeft size={13} className={`chev ${open ? "open" : ""}`} /> {open ? "إخفاء" : "التفاصيل"}
                        </button>
                      </div>
                    </div>
                    {open && (
                      <div className="product-detail" style={{ width: "100%" }}>
                        <div className="detail-list">
                          {(pur.lines || []).map((l) => {
                            const mat = data.materials.find((m) => m.id === l.materialId);
                            const supplierBits = [l.supplierName, l.supplierInvoiceNo && `فاتورة #${l.supplierInvoiceNo}`, l.lineNote].filter(Boolean).join(" · ");
                            return (
                              <div className="detail-row" key={l.id}>
                                <span>{mat?.name} ({l.qty} {mat?.unit}){supplierBits ? ` — ${supplierBits}` : ""}</span>
                                <span className="num">{fmt(l.landedUnitCost)} ر.ع / وحدة</span>
                              </div>
                            );
                          })}
                          {extraTotal > 0 && (
                            <div className="detail-row"><span>تكاليف إضافية (نقل، بترول...)</span><span className="num">{fmt(extraTotal)} ر.ع</span></div>
                          )}
                        </div>
                        {(pur.attachments || []).length > 0 && (
                          <div className="mini-list" style={{ marginTop: 10 }}>
                            <div className="mini-list-title">مرفقات فاتورة الشراء</div>
                            {pur.attachments.map((att) => (
                              <div className="mini-list-row" key={att.id}>
                                <span>📎 {att.label ? `${att.label} — ` : ""}{att.fileName}</span>
                                <a href={att.url} target="_blank" rel="noopener noreferrer" className="link-btn">تحميل</a>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ============================== products ============================== */

function emptyProduct() {
  return {
    id: uid("prod"), code: "", name: "", nameEn: "", category: "", type: "manufactured",
    sellingPrice: "", batchYield: 1,
    recipe: [{ id: uid("rl"), materialId: "", qty: "" }],
  };
}

function ProductsTab({ data, persist, currentUser }) {
  const [editing, setEditing] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [confirmState, setConfirmState] = useState(null);

  function save(p) {
    const exists = data.products.some((x) => x.id === p.id);
    const products = exists ? data.products.map((x) => (x.id === p.id ? p : x)) : [...data.products, { ...p, createdBy: currentUser?.name }];
    persist({ ...data, products });
    setEditing(null);
  }
  function remove(id) {
    const prod = data.products.find((p) => p.id === id);
    const usedIn = [];
    if (data.invoices.some((i) => (i.items || []).some((it) => it.productId === id))) usedIn.push("فواتير بيع");
    if (data.batches.some((b) => b.productId === id)) usedIn.push("دفعات إنتاج");
    if (data.marketing.some((m) => m.productId === id)) usedIn.push("سامبلات/تسويق");
    if (data.losses.some((l) => l.productId === id)) usedIn.push("خسائر");
    if (usedIn.length) {
      setConfirmState({
        info: true,
        message: `ما تقدر تحذف «${prod?.name || ""}» لأنه مسجّل في: ${usedIn.join("، ")}. حذفه بيخرّب التقارير والمخزون. تقدر تعدّله بدل الحذف.`,
        onConfirm: () => {},
      });
      return;
    }
    setConfirmState({
      message: "تأكيد حذف المنتج؟",
      onConfirm: () => persist({ ...data, products: data.products.filter((p) => p.id !== id) }),
    });
  }

  return (
    <div className="page">
      <PageHead
        eyebrow="التصنيع والتغليف"
        title="المنتجات والوصفات"
        desc="كل منتج يتكون من وصفة مواد (زيوت، كحول، قوارير، تغليف...) — أو منتج جاهز تشترونه وتغلفونه بس"
        action={
          <button className="btn-primary" onClick={() => setEditing({ ...emptyProduct(), code: nextCode(data.products, "P-") })} disabled={data.materials.length === 0}>
            <Plus size={16} /> منتج جديد
          </button>
        }
      />

      {data.materials.length === 0 ? (
        <Empty icon={Boxes} title="أضف مواد أولاً" sub="لازم تسجل مادة وحدة على الأقل بتبويب «المخزون والمواد» قبل ما تسوي منتج." />
      ) : data.products.length === 0 ? (
        <Empty icon={Package} title="ما فيه منتجات بعد" sub="اضغط «منتج جديد» وابني أول وصفة." />
      ) : (
        <div className="cards-grid">
          {data.products.map((p) => {
            const est = productLiveEstimate(p, data.materials);
            const ref = productReferenceCost(data, p.id);
            const price = Number(p.sellingPrice) || 0;
            const profit = price - ref.unitCost;
            const margin = price > 0 ? (profit / price) * 100 : 0;
            const open = openId === p.id;
            const pie = (p.recipe || [])
              .filter((l) => l.materialId && Number(l.qty) > 0)
              .map((l) => {
                const mat = data.materials.find((m) => m.id === l.materialId);
                return { name: mat?.name || "—", value: recipeLineCost(l, data.materials) };
              })
              .filter((x) => x.value > 0);

            return (
              <div className="product-card" key={p.id}>
                <div className="product-card-top">
                  <div>
                    <div className="product-name">{p.code && <span className="badge blue" style={{ marginLeft: 6 }}>{p.code}</span>}{p.name || "بدون اسم"}</div>
                    <div className="product-cat">
                      {p.category && <span>{p.category} · </span>}
                      <span className={`badge ${p.type === "ready" ? "amber" : "blue"}`}>{p.type === "ready" ? "منتج جاهز يُغلَّف" : "تصنيع كامل"}</span>
                    </div>
                  </div>
                  <div className="product-actions">
                    <button className="icon-btn" onClick={() => setEditing(JSON.parse(JSON.stringify(p)))}>تعديل</button>
                    <button className="icon-btn danger" onClick={() => remove(p.id)}><Trash2 size={15} /></button>
                  </div>
                </div>

                <div className="product-stats">
                  <div><div className="stat-label">تكلفة الوحدة</div><div className="stat-value">{fmt(ref.unitCost)} ر.ع</div></div>
                  <div><div className="stat-label">سعر البيع</div><div className="stat-value">{price ? fmt(price) + " ر.ع" : "—"}</div></div>
                  <div><div className="stat-label">هامش الربح</div><div className={`stat-value ${profit >= 0 ? "pos" : "neg"}`}>{price ? pct(margin) : "—"}</div></div>
                </div>
                <span className={`badge ${ref.source === "batches" ? "green" : "blue"}`} style={{ marginTop: 8, display: "inline-block" }}>
                  {ref.source === "batches" ? "التكلفة من دفعات إنتاج فعلية" : "تقدير حي من الوصفة (ما فيه دفعات بعد)"}
                </span>

                <button className="expand-btn" onClick={() => setOpenId(open ? null : p.id)}>
                  <ChevronLeft size={14} className={`chev ${open ? "open" : ""}`} />
                  {open ? "إخفاء تفاصيل الوصفة" : "عرض تفاصيل الوصفة"}
                </button>

                {open && (
                  <div className="product-detail">
                    <div className="detail-grid">
                      <div className="detail-list">
                        {(p.recipe || []).filter((l) => l.materialId).map((l) => {
                          const mat = data.materials.find((m) => m.id === l.materialId);
                          return (
                            <div className="detail-row" key={l.id}>
                              <span>{mat?.name} ({l.qty} {mat?.unit})</span>
                              <span className="num">{fmt(recipeLineCost(l, data.materials))} ر.ع</span>
                            </div>
                          );
                        })}
                        <div className="detail-row total">
                          <span>إجمالي دفعة {p.batchYield} وحدة</span>
                          <span>{fmt(est.total)} ر.ع</span>
                        </div>
                      </div>
                      {pie.length > 0 && (
                        <div style={{ width: "100%", height: 160 }}>
                          <ResponsiveContainer>
                            <PieChart>
                              <Pie data={pie} dataKey="value" nameKey="name" innerRadius={38} outerRadius={62} paddingAngle={2}>
                                {pie.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                              </Pie>
                              <Tooltip formatter={(v) => `${fmt(v)} ر.ع`} contentStyle={{ fontFamily: "Cairo", direction: "rtl" }} />
                            </PieChart>
                          </ResponsiveContainer>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editing && <ProductEditor product={editing} others={data.products} materials={data.materials} onSave={save} onClose={() => setEditing(null)} />}
      <ConfirmModal state={confirmState} onCancel={() => setConfirmState(null)} />
    </div>
  );
}

function ProductEditor({ product, materials, others = [], onSave, onClose }) {
  const [p, setP] = useState(product);
  const est = productLiveEstimate(p, materials);
  const price = Number(p.sellingPrice) || 0;
  const margin = price > 0 ? ((price - est.perUnit) / price) * 100 : null;

  const pcode = (p.code || "").trim().toLowerCase();
  const dupCode = !!pcode && others.some((x) => x.id !== p.id && (x.code || "").trim().toLowerCase() === pcode);
  const filledLines = (p.recipe || []).filter((l) => l.materialId);
  const usedMats = filledLines.map((l) => l.materialId);
  const dupMat = usedMats.length !== new Set(usedMats).size;
  const badQty = filledLines.some((l) => !(Number(l.qty) > 0));
  const badYield = !(Number(p.batchYield) > 0);
  const badPrice = p.sellingPrice !== "" && p.sellingPrice != null && Number(p.sellingPrice) < 0;
  const problem = !p.name.trim() ? "اكتب اسم المنتج" : dupCode ? "هذا الكود مستخدم لمنتج ثاني"
    : filledLines.length === 0 ? "أضف مادة وحدة على الأقل للوصفة" : dupMat ? "نفس المادة مكررة بالوصفة"
    : badQty ? "كل مادة بالوصفة لازم تكون كميتها أكبر من صفر" : badYield ? "عدد القطع الناتجة لازم يكون أكبر من صفر"
    : badPrice ? "سعر البيع ما يصير بالسالب" : "";
  function set(f, v) { setP({ ...p, [f]: v }); }
  function setLine(id, f, v) { setP({ ...p, recipe: p.recipe.map((l) => (l.id === id ? { ...l, [f]: v } : l)) }); }
  function addLine() { setP({ ...p, recipe: [...p.recipe, { id: uid("rl"), materialId: "", qty: "" }] }); }
  function removeLine(id) { setP({ ...p, recipe: p.recipe.filter((l) => l.id !== id) }); }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>{product.name ? "تعديل منتج" : "منتج جديد"}</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          <div className="sub-head">نوع المنتج</div>
          <div className="type-toggle">
            <button className={p.type === "manufactured" ? "active" : ""} onClick={() => set("type", "manufactured")}>تصنيع كامل من مواد خام</button>
            <button className={p.type === "ready" ? "active" : ""} onClick={() => set("type", "ready")}>منتج جاهز نشتريه ونغلفه</button>
          </div>

          <div className="form-row" style={{ marginTop: 14 }}>
            <Field label="كود المنتج"><input value={p.code} onChange={(e) => set("code", e.target.value)} placeholder="مثال: P-001" /></Field>
            <Field label="اسم المنتج"><input value={p.name} onChange={(e) => set("name", e.target.value)} placeholder="مثال: عطر ورد عماني 50مل" /></Field>
            <Field label="الاسم بالإنجليزي (اختياري)" hint="يظهر بالفاتورة الإنجليزية للعملاء الأجانب">
              <input value={p.nameEn} onChange={(e) => set("nameEn", e.target.value)} placeholder="e.g. Omani Rose Perfume 50ml" />
            </Field>
            <Field label="التصنيف (اختياري)"><input value={p.category} onChange={(e) => set("category", e.target.value)} /></Field>
          </div>

          <div className="sub-head">{p.type === "ready" ? "مكونات التغليف (والمنتج الجاهز نفسه كمادة)" : "مواد الوصفة"}</div>
          {p.type === "ready" && <p className="field-hint" style={{ marginBottom: 8 }}>أضف أول سطر للمنتج الجاهز نفسه (لازم تكون مسجلته كمادة بالمخزون)، وبعده أي مواد تغليف زي العلبة والملصق والغطاء.</p>}
          <div className="materials-list">
            {p.recipe.map((l) => {
              const mat = materials.find((m) => m.id === l.materialId);
              return (
                <div className="material-row" key={l.id}>
                  <select value={l.materialId} onChange={(e) => setLine(l.id, "materialId", e.target.value)}>
                    <option value="">اختر مادة</option>
                    {materials.map((m) => <option key={m.id} value={m.id}>{materialLabel(m)}</option>)}
                  </select>
                  <input type="number" placeholder={`الكمية${mat ? " (" + mat.unit + ")" : ""}`} value={l.qty} onChange={(e) => setLine(l.id, "qty", e.target.value)} />
                  <button className="icon-btn danger" onClick={() => removeLine(l.id)}><Trash2 size={14} /></button>
                </div>
              );
            })}
            <button className="link-btn" onClick={addLine}><Plus size={14} /> إضافة مادة</button>
          </div>

          <div className="form-row" style={{ marginTop: 10 }}>
            <Field label={p.type === "ready" ? "عدد القطع بكل عملية تغليف" : "عدد القطع الناتجة من الوصفة"}>
              <input type="number" value={p.batchYield} onChange={(e) => set("batchYield", e.target.value)} />
            </Field>
            <Field label="سعر البيع للوحدة (ر.ع)" hint="يستخدم كسعر افتراضي بالفواتير">
              <input type="number" value={p.sellingPrice} onChange={(e) => set("sellingPrice", e.target.value)} />
            </Field>
          </div>

          <div className="calc-summary">
            <div><span>تكلفة الوحدة (تقدير حي)</span><strong>{fmt(est.perUnit)} ر.ع</strong></div>
            <div><span>هامش الربح</span><strong className={margin !== null && margin >= 0 ? "pos" : "neg"}>{margin !== null ? pct(margin) : "—"}</strong></div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>إلغاء</button>
          {problem && p.name.trim() !== "" && <span className="form-problem">{problem}</span>}
          <button className="btn-primary" disabled={!!problem} onClick={() => onSave({ ...p, name: p.name.trim(), code: (p.code || "").trim(), recipe: filledLines })}>حفظ المنتج</button>
        </div>
      </div>
    </div>
  );
}

/* ============================== production batches ============================== */

function ProductionTab({ data, persist, currentUser }) {
  const [form, setForm] = useState(null);
  const [confirmState, setConfirmState] = useState(null);

  function startNew() {
    if (data.products.length === 0) return;
    const product = data.products[0];
    setForm(buildBatchForm(product, data.materials));
  }
  function buildBatchForm(product, materials) {
    const y = Number(product.batchYield) || 1;
    return {
      id: uid("batch"), date: todayStr(), productId: product.id, unitsProduced: y, note: "",
      lines: (product.recipe || []).filter((l) => l.materialId).map((l) => {
        const mat = materials.find((m) => m.id === l.materialId);
        return { materialId: l.materialId, qty: Number(l.qty) || 0, unitCost: mat ? Number(mat.avgCost) || 0 : 0 };
      }),
    };
  }
  function changeProduct(productId) {
    const product = data.products.find((p) => p.id === productId);
    if (product) setForm(buildBatchForm(product, data.materials));
  }
  function changeUnits(units) {
    const product = data.products.find((p) => p.id === form.productId);
    const y = Number(product?.batchYield) || 1;
    const ratio = (Number(units) || 0) / y;
    setForm({
      ...form, unitsProduced: units,
      lines: (product.recipe || []).filter((l) => l.materialId).map((l) => {
        const mat = data.materials.find((m) => m.id === l.materialId);
        return { materialId: l.materialId, qty: Number((Number(l.qty) * ratio).toFixed(4)), unitCost: mat ? Number(mat.avgCost) || 0 : 0 };
      }),
    });
  }
  function setLine(idx, field, val) {
    const lines = [...form.lines];
    lines[idx] = { ...lines[idx], [field]: val };
    setForm({ ...form, lines });
  }

  function save() {
    if (shortages.length > 0) return;
    const totalCost = form.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0);
    const unitsProduced = Number(form.unitsProduced) || 0;
    const batch = { ...form, totalCost, unitCost: unitsProduced > 0 ? totalCost / unitsProduced : 0, unitsProduced, createdBy: currentUser?.name };
    let materials = [...data.materials];
    form.lines.forEach((l) => {
      materials = materials.map((m) => (m.id === l.materialId ? { ...m, stock: (Number(m.stock) || 0) - (Number(l.qty) || 0) } : m));
    });
    persist({ ...data, materials, batches: [...data.batches, batch] });
    setForm(null);
  }
  function removeBatch(id) {
    setConfirmState({
      message: "تأكيد حذف سجل الدفعة؟ (لن يرجع المخزون تلقائيًا)",
      onConfirm: () => persist({ ...data, batches: data.batches.filter((b) => b.id !== id) }),
    });
  }

  // المطلوب لكل مادة (مجمّع لو تكررت) مقابل المتوفر — لو ما يكفي ما ينحفظ
  const shortages = (() => {
    if (!form) return [];
    const need = {};
    form.lines.forEach((l) => { if (l.materialId) need[l.materialId] = (need[l.materialId] || 0) + (Number(l.qty) || 0); });
    return Object.keys(need).map((id) => {
      const mat = data.materials.find((m) => m.id === id);
      const have = Number(mat?.stock) || 0;
      return mat && need[id] > have + 1e-9 ? { name: mat.name, unit: mat.unit, need: need[id], have } : null;
    }).filter(Boolean);
  })();

  return (
    <div className="page">
      <PageHead
        eyebrow="التصنيع"
        title="دفعات الإنتاج"
        desc="سجل كل دفعة تصنّعها فعليًا — يخصم المواد من المخزون تلقائيًا ويحفظ التكلفة الفعلية لتلك الدفعة"
        action={
          <button className="btn-primary" onClick={startNew} disabled={data.products.length === 0}>
            <Plus size={16} /> تسجيل دفعة
          </button>
        }
      />

      {data.products.length === 0 ? (
        <Empty icon={Package} title="أضف منتج أولاً" sub="لازم يكون فيه منتج ووصفة قبل تسجيل دفعة إنتاج." />
      ) : data.batches.length === 0 ? (
        <Empty icon={Factory} title="ما فيه دفعات مسجلة بعد" sub="اضغط «تسجيل دفعة» عشان تبدأ." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>التاريخ</th><th>المنتج</th><th>الكمية المنتَجة</th><th>التكلفة الإجمالية</th><th>تكلفة الوحدة</th><th>بواسطة</th><th></th></tr></thead>
            <tbody>
              {[...data.batches].reverse().map((b) => {
                const product = data.products.find((p) => p.id === b.productId);
                return (
                  <tr key={b.id}>
                    <td>{b.date}</td>
                    <td className="strong">{product?.name || "—"}</td>
                    <td className="num">{b.unitsProduced}</td>
                    <td className="num">{fmt(b.totalCost)} ر.ع</td>
                    <td className="num">{fmt(b.unitCost)} ر.ع</td>
                    <td>{b.createdBy && <span className="badge blue">{b.createdBy}</span>}</td>
                    <td><button className="icon-btn danger" onClick={() => removeBatch(b.id)}><Trash2 size={13} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {form && (
        <div className="modal-overlay" onClick={() => setForm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>تسجيل دفعة إنتاج</h3><button className="icon-btn" onClick={() => setForm(null)}><X size={18} /></button></div>
            <div className="modal-body">
              <div className="form-row">
                <Field label="المنتج">
                  <select value={form.productId} onChange={(e) => changeProduct(e.target.value)}>
                    {data.products.map((p) => <option key={p.id} value={p.id}>{productLabel(p)}</option>)}
                  </select>
                </Field>
                <Field label="عدد القطع الناتجة فعليًا"><input type="number" value={form.unitsProduced} onChange={(e) => changeUnits(e.target.value)} /></Field>
                <Field label="التاريخ"><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
              </div>

              <div className="sub-head">المواد المستهلكة (مقترحة تلقائيًا، تقدر تعدلها)</div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>المادة</th><th>الكمية المستهلكة</th><th>تكلفة الوحدة وقتها</th><th>المتوفر بالمخزون</th></tr></thead>
                  <tbody>
                    {form.lines.map((l, idx) => {
                      const mat = data.materials.find((m) => m.id === l.materialId);
                      const low = mat && (Number(mat.stock) || 0) < (Number(l.qty) || 0);
                      return (
                        <tr key={idx}>
                          <td>{mat?.name}</td>
                          <td><input type="number" style={{ width: 90 }} value={l.qty} onChange={(e) => setLine(idx, "qty", e.target.value)} /></td>
                          <td><input type="number" style={{ width: 90 }} value={l.unitCost} onChange={(e) => setLine(idx, "unitCost", e.target.value)} /></td>
                          <td className={low ? "stock-low" : ""}>{mat?.stock || 0} {mat?.unit}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {shortages.length > 0 && (
                <div className="alert-banner" style={{ marginTop: 10, flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 700 }}><AlertCircle size={15} /> ما تقدر تسجل الدفعة — المخزون ما يكفي:</div>
                  {shortages.map((x) => (
                    <div key={x.name}>• {x.name}: المطلوب {fmt(x.need)} {x.unit} والمتوفر {fmt(x.have)} {x.unit} (ناقص {fmt(x.need - x.have)})</div>
                  ))}
                  <div>سجّل شراء للمادة أول، أو قلّل الكمية.</div>
                </div>
              )}

              <Field label="ملاحظات (اختياري)"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>

              <div className="calc-summary">
                <div><span>التكلفة الإجمالية للدفعة</span><strong>{fmt(form.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0))} ر.ع</strong></div>
                <div><span>تكلفة الوحدة</span><strong>{fmt((form.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0)) / (Number(form.unitsProduced) || 1))} ر.ع</strong></div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn-ghost" onClick={() => setForm(null)}>إلغاء</button>
              <button className="btn-primary" onClick={save} disabled={shortages.length > 0}>حفظ الدفعة</button>
            </div>
          </div>
        </div>
      )}
      <ConfirmModal state={confirmState} onCancel={() => setConfirmState(null)} />
    </div>
  );
}

/* ============================== invoices ============================== */

function emptyInvoice(nextNo, defaultMethod) {
  return {
    id: uid("inv"), number: nextNo, date: todayStr(), customerName: "", customerPhone: "",
    paymentMethod: defaultMethod || "", note: "",
    discountType: "fixed", discountValue: "",
    deliveryType: "pickup", deliveryAddress: "",
    overheadUsage: [],
    items: [{ id: uid("it"), productId: "", qty: 1, unitPrice: "", discount: "", free: false }],
  };
}

function InvoicesTab({ data, persist, currentUser }) {
  const [editing, setEditing] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [q, setQ] = useState("");
  const [voiding, setVoiding] = useState(null);
  const [showVoided, setShowVoided] = useState(true);
  const methods = data.settings.paymentMethods || [];
  const guard = (date) => { if (isLocked(data, date)) { alert(lockMsg(data)); return true; } return false; };

  function startNew() { if (guard(todayStr())) return; setEditing(emptyInvoice(data.nextInvoiceNo, methods[0])); }

  function applyOverheadStockDelta(materials, oldUsage, newUsage) {
    // add back old quantities, then deduct new quantities
    let result = materials;
    (oldUsage || []).forEach((u) => {
      result = result.map((m) => (m.id === u.materialId ? { ...m, stock: (Number(m.stock) || 0) + (Number(u.qty) || 0) } : m));
    });
    (newUsage || []).forEach((u) => {
      result = result.map((m) => (m.id === u.materialId ? { ...m, stock: (Number(m.stock) || 0) - (Number(u.qty) || 0) } : m));
    });
    return result;
  }

  function save(inv) {
    const existing = data.invoices.find((x) => x.id === inv.id);
    const exists = !!existing;
    if (guard(inv.date) || (existing && guard(existing.date))) return;
    const invoices = exists ? data.invoices.map((x) => (x.id === inv.id ? inv : x)) : [...data.invoices, { ...inv, createdBy: currentUser?.name }];
    const nextInvoiceNo = exists ? data.nextInvoiceNo : data.nextInvoiceNo + 1;
    const materials = applyOverheadStockDelta(data.materials, existing?.overheadUsage, inv.overheadUsage);
    persist({ ...data, invoices, nextInvoiceNo, materials });
    setEditing(null);
  }
  function remove(id) {
    const inv = data.invoices.find((x) => x.id === id);
    if (inv && guard(inv.date)) return;
    setConfirmState({
      message: "تأكيد حذف الفاتورة نهائيًا؟ (الأفضل تستخدم «إلغاء / مرتجع» عشان يبقى لها أثر بالسجل. الحذف النهائي للأخطاء فقط.)",
      onConfirm: () => {
        const materials = isVoid(inv) ? data.materials : applyOverheadStockDelta(data.materials, inv?.overheadUsage, []);
        persist({ ...data, invoices: data.invoices.filter((i) => i.id !== id), materials });
      },
    });
  }
  function startVoid(inv) { if (guard(inv.date)) return; setVoiding(inv); }
  function confirmVoid(inv, v) {
    const materials = applyOverheadStockDelta(data.materials, inv.overheadUsage, []);
    persist({ ...data, materials, invoices: data.invoices.map((i) => (i.id === inv.id ? { ...i, void: { ...v, by: currentUser?.name, at: new Date().toISOString() } } : i)) });
    setVoiding(null);
  }
  function unvoid(inv) {
    if (guard(inv.date)) return;
    setConfirmState({
      message: "إعادة تفعيل الفاتورة؟ بترجع تدخل الإيراد والمخزون من جديد، وينشال تسجيل المرتجع من الحسابات.",
      onConfirm: () => {
        const materials = applyOverheadStockDelta(data.materials, [], inv.overheadUsage);
        persist({ ...data, materials, invoices: data.invoices.map((i) => { if (i.id !== inv.id) return i; const { void: _v, ...rest } = i; return rest; }) });
      },
    });
  }
  function invoiceTotal(inv) { return invoiceComputed(inv).totalPaid; }

  const qn = q.trim().toLowerCase();
  const filtered = data.invoices.filter((inv) => (showVoided || !isVoid(inv)) && (!dateFrom || inv.date >= dateFrom) && (!dateTo || inv.date <= dateTo)
    && (!qn || String(inv.number).includes(qn) || (inv.customerName || "").toLowerCase().includes(qn) || (inv.customerPhone || "").includes(qn)));
  const isFiltering = dateFrom || dateTo;
  const liveFiltered = filtered.filter((inv) => !isVoid(inv));
  const voidedCount = data.invoices.filter(isVoid).length;
  const periodTotal = liveFiltered.reduce((s, inv) => s + invoiceTotal(inv), 0);
  const byMethod = {};
  liveFiltered.forEach((inv) => {
    const m = inv.paymentMethod || "بدون طريقة دفع";
    byMethod[m] = (byMethod[m] || 0) + invoiceTotal(inv);
  });

  return (
    <div className="page">
      <PageHead
        eyebrow="المبيعات"
        title="فواتير البيع"
        desc="سجل فواتير البيع بطريقة الدفع، واطبعها، وتنعكس تلقائيًا على تقارير المنتجات"
        action={data.products.length > 0 && <button className="btn-primary" onClick={startNew}><Plus size={16} /> فاتورة جديدة</button>}
      />

      {data.invoices.length > 0 && (
        <div className="panel">
          <div className="panel-head"><h3>بحث وفلترة</h3><span className="panel-sub">التاريخ يفيد في التسوية البنكية</span></div>
          <div className="form-row">
            <Field label="بحث (اسم العميل / رقم الفاتورة / الهاتف)"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث..." /></Field>
            <Field label="من تاريخ"><input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} /></Field>
            <Field label="إلى تاريخ"><input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} /></Field>
            {(isFiltering || qn) && (
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <button className="btn-ghost" onClick={() => { setDateFrom(""); setDateTo(""); setQ(""); }}>مسح الفلتر</button>
              </div>
            )}
            {voidedCount > 0 && (
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <label className="check-inline"><input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} /> إظهار الملغاة ({voidedCount})</label>
              </div>
            )}
          </div>

          {isFiltering && (
            <>
              <div className="calc-summary">
                <div><span>عدد الفواتير بالفترة (بدون الملغاة)</span><strong>{liveFiltered.length}</strong></div>
                <div><span>إجمالي الفترة</span><strong>{fmt(periodTotal)} ر.ع</strong></div>
              </div>
              <div className="mini-list" style={{ marginTop: 12 }}>
                <div className="mini-list-title">توزيع حسب طريقة الدفع (لمطابقة كل حساب بنكي لحاله)</div>
                {Object.entries(byMethod).map(([method, total]) => (
                  <div className="mini-list-row" key={method}>
                    <span>{method}</span>
                    <span className="num">{fmt(total)} ر.ع</span>
                  </div>
                ))}
              </div>
              <button className="btn-ghost" style={{ marginTop: 12 }} onClick={() => printPeriodNow({ dateFrom, dateTo, invoices: liveFiltered, total: periodTotal, byMethod }, data)}>
                <Printer size={15} /> طباعة كشف الفترة
              </button>
            </>
          )}
        </div>
      )}

      {data.products.length === 0 ? (
        <Empty icon={Package} title="أضف منتج أولاً" sub="لازم منتج واحد على الأقل قبل ما تسوي فاتورة بيع." />
      ) : data.invoices.length === 0 ? (
        <Empty icon={Receipt} title="ما فيه فواتير بعد" sub="اضغط «فاتورة جديدة» عشان تسجل أول عملية بيع." />
      ) : filtered.length === 0 ? (
        <Empty icon={Receipt} title="ما فيه فواتير بهالفترة" sub="جرب توسّع نطاق التاريخ." />
      ) : (
        <div className="invoice-list">
          {[...filtered].reverse().map((inv) => (
            <div className={`ticket ${isVoid(inv) ? "ticket-void" : ""}`} key={inv.id}>
              <div className="ticket-main">
                <div className="ticket-top">
                  <span className="ticket-no">فاتورة #{inv.number}</span>
                  {isVoid(inv) && <span className="badge red">ملغاة / مرتجع</span>}
                  <span className="ticket-date">{inv.date}</span>
                  {inv.paymentMethod && <span className="badge blue">{inv.paymentMethod}</span>}
                  {inv.deliveryType === "delivery" && <span className="badge amber">توصيل</span>}
                  {inv.createdBy && <span className="badge green">{inv.createdBy}</span>}
                </div>
                <div className="ticket-customer">{inv.customerName || "عميل بدون اسم"}</div>
                <div className="ticket-items">
                  {(inv.items || []).filter((it) => it.productId).map((it) => {
                    const prod = data.products.find((p) => p.id === it.productId);
                    return <span key={it.id} className="chip">{prod?.name || "—"} × {it.qty}{it.free ? " 🎁" : ""}</span>;
                  })}
                </div>
              </div>
              <div className="ticket-side">
                <div className="ticket-total">{fmt(invoiceTotal(inv))} ر.ع</div>
                {isVoid(inv) && <div className="panel-sub">{inv.void.date}{inv.void.reason ? ` — ${inv.void.reason}` : ""}{voidRefund(inv) > 0 ? ` — رُدّ ${fmt(voidRefund(inv))} ر.ع` : ""}</div>}
                <div className="ticket-actions">
                  <button className="icon-btn" onClick={() => printInvoiceNow(inv, data, "ar")} title="طباعة عربي"><Printer size={15} /> AR</button>
                  <button className="icon-btn" onClick={() => printInvoiceNow(inv, data, "en")} title="Print English"><Printer size={15} /> EN</button>
                  {isVoid(inv) ? (
                    <button className="icon-btn" onClick={() => unvoid(inv)}>إعادة تفعيل</button>
                  ) : (
                    <>
                      <button className="icon-btn" onClick={() => { if (!guard(inv.date)) setEditing(inv); }}>تعديل</button>
                      <button className="icon-btn warn" onClick={() => startVoid(inv)}>إلغاء / مرتجع</button>
                    </>
                  )}
                  <button className="icon-btn danger" onClick={() => remove(inv.id)} title="حذف نهائي"><Trash2 size={15} /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && <InvoiceEditor invoice={editing} data={activeData(data)} products={data.products} methods={methods} allInvoices={data.invoices} onSave={save} onClose={() => setEditing(null)} />}
      {voiding && <VoidModal invoice={voiding} data={data} onCancel={() => setVoiding(null)} onConfirm={(v) => confirmVoid(voiding, v)} />}
      <ConfirmModal state={confirmState} onCancel={() => setConfirmState(null)} />
    </div>
  );
}

function VoidModal({ invoice, data, onCancel, onConfirm }) {
  const total = invoiceComputed(invoice).totalPaid;
  const defAcc = methodAccount(data.settings, invoice.paymentMethod);
  const [reason, setReason] = useState("");
  const [refunded, setRefunded] = useState(!!defAcc);
  const [amount, setAmount] = useState(String(Number(total.toFixed(3))));
  const [account, setAccount] = useState(defAcc && defAcc !== "thawani" ? defAcc : (defAcc === "thawani" ? "thawani" : "sohar"));
  const [date, setDate] = useState(muscatDate(new Date().toISOString()));
  const amt = Number(amount);
  const bad = !date || (refunded && (!(amt > 0) || amt > total + 0.0005));
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>إلغاء / مرتجع — فاتورة #{invoice.number}</h3><button className="icon-btn" onClick={onCancel}><X size={18} /></button></div>
        <div className="modal-body">
          <p className="field-hint" style={{ marginBottom: 10 }}>الفاتورة تبقى محفوظة بالسجل، لكن تطلع من الإيراد والضريبة والعمولة، ويرجع المخزون تلقائيًا (والمواد المستهلكة بالفاتورة لو فيه).</p>
          <div className="form-row">
            <Field label="تاريخ الإلغاء"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="السبب"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثال: العميل ألغى الطلب" /></Field>
          </div>
          <label className="check-inline" style={{ margin: "6px 0 10px" }}>
            <input type="checkbox" checked={refunded} onChange={(e) => setRefunded(e.target.checked)} /> تم رد مبلغ للعميل (أو المبلغ كان مستلم وبينرد)
          </label>
          {refunded && (
            <div className="form-row">
              <Field label="المبلغ المردود (ر.ع)" hint={`الفاتورة ${fmt(total)} ر.ع شامل الشحن`}><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
              <Field label="انرد من حساب"><select value={account} onChange={(e) => setAccount(e.target.value)}>{ACCOUNTS.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
            </div>
          )}
          {!refunded && <p className="field-hint">بدون رد مبلغ: الفاتورة بتختفي من الحسابات كأنها ما دخلت (مناسب لطلب ما انستلم له مبلغ).</p>}
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onCancel}>رجوع</button>
          <button className="btn-primary" disabled={bad} onClick={() => onConfirm({ date, reason: reason.trim(), refundAmount: refunded ? Number(amt.toFixed(3)) : 0, refundAccount: refunded ? account : "", refundDate: date })}>تأكيد الإلغاء</button>
        </div>
      </div>
    </div>
  );
}

function InvoiceEditor({ invoice, data, products, methods, allInvoices, onSave, onClose }) {
  const [inv, setInv] = useState(invoice);
  function set(f, v) { setInv({ ...inv, [f]: v }); }
  function setItem(id, field, val) {
    setInv({
      ...inv,
      items: inv.items.map((it) => {
        if (it.id !== id) return it;
        const updated = { ...it, [field]: val };
        if (field === "productId") {
          const prod = products.find((p) => p.id === val);
          if (prod && !it.unitPrice) updated.unitPrice = prod.sellingPrice || "";
        }
        return updated;
      }),
    });
  }
  function toggleFree(id) {
    setInv({
      ...inv,
      items: inv.items.map((it) => {
        if (it.id !== id) return it;
        if (!it.free) return { ...it, free: true, prevPrice: it.unitPrice, unitPrice: 0, discount: "" };
        return { ...it, free: false, unitPrice: it.prevPrice || "" };
      }),
    });
  }
  function setAtCost(id) {
    const it = inv.items.find((x) => x.id === id);
    if (!it || !it.productId) return;
    const ref = productReferenceCost(data, it.productId);
    // سعر التكلفة + 5% (تغطية الـVAT) — العميل يشوف رقم واحد فقط، والزيادة داخلية
    setItem(id, "unitPrice", Number((ref.unitCost * (1 + VAT_RATE / 100)).toFixed(3)));
  }
  function addItem() { setInv({ ...inv, items: [...inv.items, { id: uid("it"), productId: "", qty: 1, unitPrice: "", discount: "", free: false }] }); }
  function removeItem(id) { setInv({ ...inv, items: inv.items.filter((it) => it.id !== id) }); }

  function addOverheadUsage() {
    setInv({ ...inv, overheadUsage: [...(inv.overheadUsage || []), { id: uid("ou"), materialId: "", qty: "" }] });
  }
  function setOverheadUsage(id, field, val) {
    setInv({ ...inv, overheadUsage: (inv.overheadUsage || []).map((u) => (u.id === id ? { ...u, [field]: val } : u)) });
  }
  function removeOverheadUsage(id) {
    setInv({ ...inv, overheadUsage: (inv.overheadUsage || []).filter((u) => u.id !== id) });
  }

  const computed = useMemo(() => invoiceComputed(inv), [inv]);

  const stockIssues = useMemo(() => {
    const requestedByProduct = {};
    inv.items.forEach((it) => {
      if (!it.productId) return;
      requestedByProduct[it.productId] = (requestedByProduct[it.productId] || 0) + (Number(it.qty) || 0);
    });
    const issues = {};
    Object.entries(requestedByProduct).forEach(([pid, qty]) => {
      const avail = availableToSell(data, pid, inv.id);
      if (qty > avail) issues[pid] = { requested: qty, available: avail };
    });
    return issues;
  }, [inv.items, data, inv.id]);
  const hasStockIssue = Object.keys(stockIssues).length > 0;
  const chosenItems = inv.items.filter((it) => it.productId);
  const badItemQty = chosenItems.some((it) => !(Number(it.qty) > 0));
  const badItemPrice = chosenItems.some((it) => it.unitPrice !== "" && it.unitPrice != null && Number(it.unitPrice) < 0);
  const emptyPriceItem = chosenItems.some((it) => !it.free && (it.unitPrice === "" || it.unitPrice == null));
  const ovNeed = {};
  (inv.overheadUsage || []).forEach((u) => { if (u.materialId) ovNeed[u.materialId] = (ovNeed[u.materialId] || 0) + (Number(u.qty) || 0); });
  const prevUsage = (data.invoices.find((x) => x.id === inv.id)?.overheadUsage) || [];
  const ovShort = Object.keys(ovNeed).map((id) => {
    const mat = data.materials.find((m) => m.id === id);
    const back = prevUsage.filter((u) => u.materialId === id).reduce((a, u) => a + (Number(u.qty) || 0), 0);
    const have = (Number(mat?.stock) || 0) + back;
    return mat && ovNeed[id] > have + 1e-9 ? mat.name : null;
  }).filter(Boolean);
  const problem = chosenItems.length === 0 ? "اختر منتج واحد على الأقل"
    : !inv.date ? "حدد تاريخ الفاتورة"
    : badItemQty ? "الكمية لازم تكون أكبر من صفر"
    : badItemPrice ? "السعر ما يصير بالسالب"
    : emptyPriceItem ? "حدد سعر لكل منتج (أو علّمه هدية)"
    : ovShort.length ? `مخزون غير كافي لمواد: ${ovShort.join("، ")}`
    : hasStockIssue ? "الكمية المطلوبة أكبر من المتاح بالمخزون" : "";
  const canSave = !problem;

  const customers = useMemo(() => customerStats(allInvoices.filter((i) => i.id !== inv.id)), [allInvoices, inv.id]);
  const matched = customers.find((c) => c.name.toLowerCase() === (inv.customerName || "").trim().toLowerCase());

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>فاتورة #{inv.number}</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          <div className="form-row">
            <Field label="اسم العميل" hint="اكتب واختر من الاقتراحات لو عميل سابق">
              <input list="customer-suggestions" value={inv.customerName} onChange={(e) => set("customerName", e.target.value)} />
              <datalist id="customer-suggestions">
                {customers.map((c) => <option key={c.name} value={c.name} />)}
              </datalist>
            </Field>
            <Field label="رقم الهاتف (اختياري)"><input value={inv.customerPhone} onChange={(e) => set("customerPhone", e.target.value)} /></Field>
            <Field label="التاريخ"><input type="date" value={inv.date} onChange={(e) => set("date", e.target.value)} /></Field>
            <Field label="طريقة الدفع">
              <select value={inv.paymentMethod} onChange={(e) => set("paymentMethod", e.target.value)}>
                <option value="">اختر</option>
                {methods.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
          </div>

          <div className="form-row">
            <Field label="التسليم">
              <select value={inv.deliveryType} onChange={(e) => set("deliveryType", e.target.value)}>
                <option value="pickup">استلام من المصنع</option>
                <option value="delivery">توصيل</option>
              </select>
            </Field>
            {inv.deliveryType === "delivery" && (
              <Field label="عنوان التوصيل"><input value={inv.deliveryAddress} onChange={(e) => set("deliveryAddress", e.target.value)} placeholder="الولاية / المنطقة / تفاصيل الموقع" /></Field>
            )}
          </div>

          {matched && (
            <div className="alert-banner" style={{ background: "#E1F0E7", color: "var(--success)", borderColor: "#BEE0CB" }}>
              <Users size={15} />
              <span>عميل سابق: اشترى {matched.count} مرة قبل كذا، بإجمالي {fmt(matched.total)} ر.ع، آخر شراء بتاريخ {matched.lastDate}</span>
            </div>
          )}

          <div className="sub-head">أصناف الفاتورة</div>
          <p className="field-hint" style={{ marginBottom: 8 }}>لو الصنف هدية مجانية اضغط 🎁، ولو تبيع بسعر التكلفة اضغط "بالتكلفة". الخصم هنا يطبق على هالصنف بس. الكمية محدودة بالمتوفر فعليًا من دفعات الإنتاج المسجلة.</p>
          <div className="materials-list">
            {inv.items.map((it) => {
              const lineC = computed.items.find((x) => x.id === it.id) || {};
              const avail = it.productId ? availableToSell(data, it.productId, inv.id) : null;
              const issue = it.productId ? stockIssues[it.productId] : null;
              return (
                <div className="invoice-item-block" key={it.id}>
                  <div className="invoice-item-row">
                    <select value={it.productId} onChange={(e) => setItem(it.id, "productId", e.target.value)}>
                      <option value="">اختر منتج</option>
                      {products.map((p) => <option key={p.id} value={p.id}>{productLabel(p)}</option>)}
                    </select>
                    <input type="number" min="0" value={it.qty} onChange={(e) => setItem(it.id, "qty", e.target.value)} placeholder="الكمية" />
                    <input type="number" value={it.unitPrice} disabled={it.free} onChange={(e) => setItem(it.id, "unitPrice", e.target.value)} placeholder="سعر الوحدة" />
                    <span className="num line-total">{fmt(lineC.afterLineDiscount)}</span>
                    <button className="icon-btn danger" onClick={() => removeItem(it.id)}><Trash2 size={14} /></button>
                  </div>
                  {it.productId && (
                    <p className={`field-hint ${issue ? "stock-warning" : ""}`} style={{ margin: "4px 0 0" }}>
                      {issue
                        ? `⚠️ المطلوب (${issue.requested}) أكبر من المتوفر للبيع (${issue.available}) — سجّل دفعة إنتاج أو قلّل الكمية`
                        : `المتوفر للبيع: ${avail}`}
                    </p>
                  )}
                  <div className="invoice-item-extra">
                    <input
                      type="number" placeholder="خصم على هذا الصنف (ر.ع)" value={it.discount} disabled={it.free}
                      onChange={(e) => setItem(it.id, "discount", e.target.value)}
                    />
                    <button type="button" className={`chip-toggle ${it.free ? "active" : ""}`} onClick={() => toggleFree(it.id)}>🎁 مجاني (هدية)</button>
                    <button type="button" className="chip-toggle" onClick={() => setAtCost(it.id)} disabled={!it.productId} title="التكلفة + 5% ضريبة (ما تظهر للعميل)">بسعر التكلفة</button>
                  </div>
                </div>
              );
            })}
            <button className="link-btn" onClick={addItem}><Plus size={14} /> إضافة صنف</button>
          </div>

          {data.materials.length > 0 && (
            <>
              <div className="sub-head">استهلاك مواد إضافية (داخلي فقط، ما يظهر بالفاتورة المطبوعة)</div>
              <p className="field-hint" style={{ marginBottom: 8 }}>مثلاً كيس واحد يغلّف عطرين — سجّله هنا مرة وحدة بس عشان يخصم من مخزون الأكياس، بعيد عن أصناف الفاتورة اللي يشوفها العميل.</p>
              <div className="trip-costs">
                {(inv.overheadUsage || []).length === 0 && <p className="empty-sub" style={{ margin: 0 }}>ما فيه استهلاك مسجّل — اضغط + لو تبي تسجل.</p>}
                {(inv.overheadUsage || []).map((u) => {
                  const mat = data.materials.find((m) => m.id === u.materialId);
                  return (
                    <div className="overhead-usage-row" key={u.id}>
                      <select value={u.materialId} onChange={(e) => setOverheadUsage(u.id, "materialId", e.target.value)}>
                        <option value="">اختر مادة</option>
                        {data.materials.map((m) => <option key={m.id} value={m.id}>{materialLabel(m)} — متوفر: {m.stock || 0}</option>)}
                      </select>
                      <input type="number" placeholder={`الكمية${mat ? " (" + mat.unit + ")" : ""}`} value={u.qty} onChange={(e) => setOverheadUsage(u.id, "qty", e.target.value)} />
                      <button className="icon-btn danger" onClick={() => removeOverheadUsage(u.id)}><Trash2 size={14} /></button>
                    </div>
                  );
                })}
                <button className="link-btn" onClick={addOverheadUsage}><Plus size={14} /> إضافة استهلاك</button>
              </div>
            </>
          )}

          <div className="sub-head">خصم على الفاتورة كاملة (اختياري)</div>
          <div className="form-row">
            <Field label="نوع الخصم">
              <select value={inv.discountType} onChange={(e) => set("discountType", e.target.value)}>
                <option value="fixed">مبلغ ثابت (ر.ع)</option>
                <option value="percent">نسبة %</option>
              </select>
            </Field>
            <Field label="قيمة الخصم"><input type="number" value={inv.discountValue} onChange={(e) => set("discountValue", e.target.value)} /></Field>
          </div>

          <Field label="رسوم الشحن (اختياري)" hint="مبلغ الشحن اللي يدفعه العميل — ما يدخل في الإيراد ولا الضريبة ولا الربح، لكنه يظهر في الفاتورة ويدخل رصيد الحساب"><input type="number" min="0" value={inv.shippingFee ?? ""} onChange={(e) => set("shippingFee", e.target.value)} /></Field>
          <Field label="ملاحظات (اختياري)"><textarea rows={2} value={inv.note} onChange={(e) => set("note", e.target.value)} /></Field>

          <div className="calc-summary">
            <div><span>المجموع قبل خصم الفاتورة</span><strong>{fmt(computed.subtotal)} ر.ع</strong></div>
            <div><span>خصم الفاتورة</span><strong className="neg">{fmt(computed.invoiceDiscountAmount)} ر.ع</strong></div>
            {computed.shipping > 0 && <div><span>الشحن (يدفعه العميل لشركة الشحن)</span><strong>{fmt(computed.shipping)} ر.ع</strong></div>}
            <div><span>الإجمالي النهائي (المدفوع)</span><strong>{fmt(computed.totalPaid)} ر.ع</strong></div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>إلغاء</button>
          {problem && chosenItems.length > 0 && <span className="form-problem">{problem}</span>}
          <button className="btn-primary" disabled={!canSave} onClick={() => onSave({ ...inv, items: chosenItems })}>حفظ الفاتورة</button>
        </div>
      </div>
    </div>
  );
}

/* ============================== customers ============================== */

/* ============================== web orders (طلبات الموقع) ============================== */

function WebOrderCard({ order, data, onImport }) {
  const initial = matchWebItems(order, data.products, data.settings.webProductMap).map((m) => m.productId || "");
  const [selection, setSelection] = useState(initial);
  const [busy, setBusy] = useState(false);
  const total = (Number(order.total_amount) || 0) / 1000;
  const ready = selection.length > 0 && selection.every(Boolean);
  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <div className="panel-head">
        <h3>طلب {order.client_reference_id}</h3>
        <span className="badge amber">يحتاج مطابقة</span>
      </div>
      <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--ink-soft)" }}>
        {muscatDate(order.created_at)} · {order.customer_name} · {order.phone} · الإجمالي {fmt(total)} ر.ع
        {order.discount_code ? ` · كود خصم ${order.discount_code}` : ""}
      </p>
      <div className="mini-list">
        <div className="mini-list-title">اختر المنتج المقابل بالبرنامج لكل صنف (الاقتراح معبّى لك لو لقيناه). اختيارك يتحفظ كربط ثابت، وهالمنتج بعدها يستورد تلقائيًا</div>
        {(order.items || []).map((it, idx) => (
          <div className="mini-list-row" key={idx} style={{ gap: 10, alignItems: "center" }}>
            <span style={{ flex: 1 }}>{it.name} {it.code ? `(${it.code})` : ""} × {it.quantity}</span>
            <select
              value={selection[idx] || ""}
              onChange={(e) => setSelection(selection.map((v, i) => (i === idx ? e.target.value : v)))}
              style={{ minWidth: 190 }}
            >
              <option value="">— اختر المنتج —</option>
              {data.products.map((p) => <option key={p.id} value={p.id}>{p.code ? `${p.code} — ` : ""}{p.name}</option>)}
            </select>
          </div>
        ))}
      </div>
      <button
        className="btn-primary" style={{ marginTop: 12 }} disabled={!ready || busy}
        onClick={async () => { setBusy(true); await onImport(order, selection); setBusy(false); }}
      >
        <Plus size={15} /> {busy ? "..." : "استيراد كفاتورة بيع"}
      </button>
    </div>
  );
}

const GCC_NAMES = { OM: "عُمان", AE: "الإمارات", SA: "السعودية", KW: "الكويت", QA: "قطر", BH: "البحرين" };

function FulfillmentRow({ order, onChangeStatus }) {
  const st = order.fulfillment_status || "new";
  const [status, setStatus] = useState(st);
  const [note, setNote] = useState(order.fulfillment_note || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const meta = FULFILLMENT_STATUSES.find((x) => x.id === st) || FULFILLMENT_STATUSES[0];
  const dirty = status !== st || note !== (order.fulfillment_note || "");
  const wa = String(order.phone || "").replace(/[^\d]/g, "");
  const total = (Number(order.total_amount) || 0) / 1000;
  return (
    <div className="panel" style={{ marginBottom: 10 }}>
      <div className="panel-head">
        <h3 style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <bdi>{order.invoice_number || order.client_reference_id}</bdi>
          <span className={`badge ${meta.cls}`}>{meta.label}</span>
        </h3>
        <span className="num">{fmt(total)} ر.ع</span>
      </div>
      <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.9 }}>
        {muscatDate(order.created_at)} · <b style={{ color: "var(--ink)" }}>{order.customer_name}</b>
        {" · "}{wa ? <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer"><bdi>{order.phone}</bdi></a> : "—"}
        {order.email ? <> · <bdi>{order.email}</bdi></> : null}
        {order.country_code ? ` · ${GCC_NAMES[order.country_code] || order.country_code}` : ""}
        <br />{order.delivery_address}
        <br />{(order.items || []).map((it) => `${it.name} × ${it.quantity}`).join("، ")}
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ minWidth: 140 }}>
          {FULFILLMENT_STATUSES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="ملاحظة (مثلاً رقم التتبع — تُرسل للعميل مع إشعار الشحن)" style={{ flex: 1, minWidth: 200 }} />
        <button
          className="btn-primary" disabled={!dirty || busy}
          onClick={async () => {
            setBusy(true); setErr("");
            try { await onChangeStatus(order.client_reference_id, status, note); } catch (e) { setErr("تعذر الحفظ، حاول مرة ثانية."); }
            setBusy(false);
          }}
        >{busy ? "..." : status === "shipped" && st !== "shipped" ? "حفظ + إشعار العميل" : "حفظ"}</button>
      </div>
      {err && <div className="alert-banner" style={{ marginTop: 8 }}><AlertCircle size={15} /> {err}</div>}
    </div>
  );
}

function TransfersSection({ transfers, onTransfer }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const list = (transfers && transfers.list) || [];
  if (list.length === 0 && !(transfers && transfers.error)) return null;
  async function act(ref, kind) {
    if (kind === "cancel" && !window.confirm("إلغاء هذا الطلب؟ ما بيصير له فاتورة ولا ينقص مخزون.")) return;
    setBusy(ref + kind); setErr("");
    const e = await onTransfer(ref, kind);
    setErr(e); setBusy("");
  }
  return (
    <div className="panel" style={{ marginBottom: 14, borderColor: "var(--amber, #d9a441)" }}>
      <div className="panel-head"><h3>🏦 تحويلات بنكية بانتظار التأكيد ({list.length})</h3><span className="panel-sub">راجع كشف صحار، ولما يوصل المبلغ اضغط «تم استلام التحويل». حينها يتحول الطلب لمدفوع وتنصدر الفاتورة وينخصم المخزون.</span></div>
      {transfers.error && <div className="alert-banner" style={{ marginBottom: 8 }}><AlertCircle size={15} /> {transfers.error}</div>}
      {err && <div className="alert-banner" style={{ marginBottom: 8 }}><AlertCircle size={15} /> {err}</div>}
      <div className="table-wrap"><table>
        <thead><tr><th>التاريخ</th><th>العميل</th><th>رقم الطلب (يكتبه في التحويل)</th><th>المنتجات</th><th>المبلغ المطلوب</th><th></th></tr></thead>
        <tbody>{list.map((o) => (
          <tr key={o.client_reference_id}>
            <td>{muscatDate(o.created_at)}</td>
            <td className="strong">{o.customer_name}<div className="panel-sub" dir="ltr">{o.phone}</div></td>
            <td dir="ltr">{o.client_reference_id}</td>
            <td>{(o.items || []).map((i) => `${i.name} × ${i.quantity}`).join("، ")}</td>
            <td className="num"><strong>{fmt(Number(o.total_amount) / 1000)} ر.ع</strong>{Number(o.shipping_fee) > 0 ? <div className="panel-sub">منها شحن {fmt(Number(o.shipping_fee) / 1000)}</div> : null}</td>
            <td><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button className="btn-primary" disabled={!!busy} onClick={() => act(o.client_reference_id, "confirm")}>{busy === o.client_reference_id + "confirm" ? "..." : "تم استلام التحويل"}</button>
              <button className="btn-ghost" disabled={!!busy} onClick={() => act(o.client_reference_id, "cancel")}>إلغاء</button>
            </div></td>
          </tr>))}</tbody></table></div>
    </div>
  );
}

function FulfillmentSection({ fulfil, onReload, onChangeStatus }) {
  const [filter, setFilter] = useState("open");
  useEffect(() => { onReload(); }, []);
  const orders = fulfil.orders.filter((o) => {
    const st = o.fulfillment_status || "new";
    if (filter === "open") return st === "new" || st === "preparing";
    if (filter === "all") return true;
    return st === filter;
  });
  const count = (id) => fulfil.orders.filter((o) => (o.fulfillment_status || "new") === id).length;
  return (
    <div style={{ marginBottom: 22 }}>
      <div className="panel-head" style={{ marginBottom: 10 }}>
        <h3>متابعة تجهيز الطلبات</h3>
        <button className="btn-ghost" onClick={onReload} disabled={fulfil.loading}><RefreshCw size={14} /> {fulfil.loading ? "..." : "تحديث"}</button>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {[{ id: "open", label: `بانتظار التجهيز (${count("new") + count("preparing")})` }, ...FULFILLMENT_STATUSES.filter((x) => x.id !== "new" && x.id !== "preparing").map((x) => ({ id: x.id, label: `${x.label} (${count(x.id)})` })), { id: "all", label: "الكل" }].map((f) => (
          <button key={f.id} className={`chip-toggle ${filter === f.id ? "active" : ""}`} onClick={() => setFilter(f.id)}>{f.label}</button>
        ))}
      </div>
      {fulfil.error && <div className="alert-banner" style={{ marginBottom: 10 }}><AlertCircle size={15} /> {fulfil.error}</div>}
      {orders.length === 0 && !fulfil.loading && (
        <div className="panel"><p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-soft)" }}>ما فيه طلبات بهذي الحالة.</p></div>
      )}
      {orders.map((o) => <FulfillmentRow key={o.client_reference_id + (o.fulfillment_status || "")} order={o} onChangeStatus={onChangeStatus} />)}
    </div>
  );
}

function WebOrdersTab({ data, webState, onSync, onImport, fulfil, onReloadFulfil, onChangeStatus, transfers, onTransfer }) {
  const webInvoices = data.invoices.filter((i) => i.source === "website").slice(-15).reverse();
  // فحص الربط: مبلغ فاتورة البرنامج لازم يساوي اللي دفعه العميل بالموقع، والطلب الملغي ما يبقى محسوب إيراد
  const checks = [];
  (fulfil.orders || []).forEach((o) => {
    const inv = data.invoices.find((i) => i.webOrderRef === o.client_reference_id);
    if (!inv) return;
    const paid = Number(o.total_amount) / 1000;
    const calc = invoiceComputed(inv).totalPaid;
    if (Number.isFinite(paid) && Math.abs(paid - calc) >= 0.0005) checks.push(`الطلب ${o.client_reference_id} (فاتورة #${inv.number}): المدفوع بالموقع ${fmt(paid)} ر.ع، وفاتورة البرنامج ${fmt(calc)} ر.ع.`);
    if (o.fulfillment_status === "cancelled") checks.push(`الطلب ${o.client_reference_id} (فاتورة #${inv.number}) ملغي بالموقع لكن فاتورته لسا محسوبة كإيراد ومنخصومة من المخزون. احذف الفاتورة أو عدّلها.`);
  });
  return (
    <div className="page">
      <PageHead
        eyebrow="المتجر الإلكتروني"
        title="طلبات الموقع"
        desc="الطلبات المدفوعة بالموقع تتحول تلقائيًا لفواتير بيع وتنخصم من المتاح للبيع. يفحص البرنامج الموقع كل دقيقة وهو مفتوح."
        action={<button className="btn-ghost" onClick={onSync} disabled={webState.busy}><RefreshCw size={15} /> {webState.busy ? "جاري الفحص..." : "افحص الآن"}</button>}
      />

      {webState.error && <div className="alert-banner" style={{ marginBottom: 12 }}><AlertCircle size={15} /> {webState.error}</div>}
      {webState.stockError && <div className="alert-banner" style={{ marginBottom: 12 }}><AlertCircle size={15} /> {webState.stockError}</div>}
      {webState.warnings.map((w, i) => (
        <div className="alert-banner" key={i} style={{ marginBottom: 8 }}>{w}</div>
      ))}
      <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--ink-soft)" }}>
        {webState.lastCheck ? `آخر فحص: ${webState.lastCheck.toLocaleTimeString("ar-OM")}` : "لسا ما تم الفحص"}
        {webState.importedNow > 0 ? ` · انستورد ${webState.importedNow} طلب جديد بالفحص الأخير ✅` : ""}
        {webState.stockSyncedAt ? ` · آخر تحديث لمخزون الموقع: ${webState.stockSyncedAt.toLocaleTimeString("ar-OM")}` : ""}
      </p>

      {checks.length > 0 && (
        <div className="alert-banner" style={{ marginBottom: 12, display: "block" }}>
          <strong><AlertCircle size={15} /> فحص تطابق الطلبات مع الفواتير</strong>
          {checks.map((c, i) => <div key={i} style={{ marginTop: 4 }}>{c}</div>)}
        </div>
      )}
      <TransfersSection transfers={transfers} onTransfer={onTransfer} />
      <FulfillmentSection fulfil={fulfil} onReload={onReloadFulfil} onChangeStatus={onChangeStatus} />

      {webState.pending.length > 0 && webState.pending.map((o) => (
        <WebOrderCard key={o.client_reference_id} order={o} data={data} onImport={onImport} />
      ))}

      {webState.pending.length === 0 && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-head"><h3>ما فيه طلبات تنتظر مطابقة</h3></div>
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-soft)" }}>كل طلبات الموقع المدفوعة انستوردت. أي طلب جديد ينزل هنا تلقائيًا.</p>
        </div>
      )}

      <div className="panel">
        <div className="panel-head"><h3>آخر فواتير الموقع</h3></div>
        {webInvoices.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-soft)" }}>ما فيه فواتير من الموقع بعد.</p>
        ) : (
          <div className="mini-list">
            {webInvoices.map((inv) => (
              <div className="mini-list-row" key={inv.id}>
                <span>#{inv.number}{inv.webInvoiceNumber ? ` (${inv.webInvoiceNumber})` : ""} · {inv.date} · {inv.customerName}</span>
                <span className="num">{fmt(invoiceComputed(inv).totalPaid)} ر.ع</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function offerStatus(o, now) {
  if (!o.active) return { label: "موقوف", cls: "" };
  if (o.starts_at && new Date(o.starts_at) > now) return { label: "مجدول", cls: "blue" };
  if (o.ends_at && new Date(o.ends_at) <= now) return { label: "منتهي", cls: "" };
  if (o.max_orders != null && o.used >= o.max_orders) return { label: "اكتمل العدد", cls: "" };
  return { label: "شغّال الآن", cls: "green" };
}

function codeStatus(c, now) {
  if (!c.active) return { label: "موقوف", cls: "" };
  if (c.starts_at && new Date(c.starts_at) > now) return { label: "مجدول", cls: "blue" };
  if (c.expires_at && new Date(c.expires_at) <= now) return { label: "منتهي", cls: "" };
  if (c.max_uses != null && (c.used_count || 0) >= c.max_uses) return { label: "اكتمل العدد", cls: "" };
  return { label: "شغّال", cls: "green" };
}

function addDaysDate(days) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Muscat" });
}

function OffersTab() {
  const [state, setState] = useState({ loading: true, error: "", offers: [], codes: [], products: [], now: new Date() });
  const [busy, setBusy] = useState(false);
  const blank = { name: "", nameEn: "", percent: "", scope: "all", productIds: [], mode: "permanent", startDate: "", endDate: "", maxOrders: "" };
  const [form, setForm] = useState(blank);
  const [formError, setFormError] = useState("");
  const blankCode = { code: "", kind: "percent", value: "", usage: "unlimited", maxUses: "", validity: "none", startDate: "", expires: "", marketer: "", commissionType: "percent", commission: "" };
  const [codeForm, setCodeForm] = useState(blankCode);
  const [codeError, setCodeError] = useState("");
  const [confirmState, setConfirmState] = useState(null);

  async function reload() {
    try {
      const r = await listOffers();
      setState({ loading: false, error: "", offers: r.offers || [], codes: r.codes || [], products: r.products || [], now: new Date(r.now || Date.now()) });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: "تعذر الاتصال بالموقع. تأكد من الإنترنت ومن تركيب دالة accounting-orders. (" + (e.message || e) + ")" }));
    }
  }
  useEffect(() => { reload(); }, []);

  const productLabel = (p) => `${p.code ? p.code + " — " : ""}${p.name_ar || p.name_en || ""}`;
  const productById = useMemo(() => Object.fromEntries(state.products.map((p) => [String(p.id), p])), [state.products]);

  async function createOffer(e) {
    e.preventDefault();
    setFormError("");
    const pct = Number(form.percent);
    if (!form.name.trim()) return setFormError("اكتب اسم للعرض (مثلًا: عرض الافتتاح).");
    if (!(pct > 0 && pct < 100)) return setFormError("نسبة الخصم لازم تكون بين 1 و 99.");
    if (form.scope === "products" && form.productIds.length === 0) return setFormError("اختر عطر واحد على الأقل.");
    if (form.mode === "orders" && !(Number.isInteger(Number(form.maxOrders)) && Number(form.maxOrders) >= 1)) return setFormError("اكتب عدد الطلبات (رقم صحيح من 1 فأكثر).");
    if (form.mode === "dates" && !form.startDate && !form.endDate) return setFormError("اختر تاريخ نهاية العرض (أو البداية).");
    if (form.mode === "dates" && form.startDate && form.endDate && form.endDate < form.startDate) return setFormError("تاريخ النهاية قبل تاريخ البداية.");
    setBusy(true);
    try {
      await saveOffer({
        name: form.name.trim(),
        name_en: form.nameEn.trim(),
        percent_off: pct,
        applies_to: form.scope,
        product_ids: form.scope === "products" ? form.productIds : [],
        starts_at: form.mode === "dates" && form.startDate ? `${form.startDate}T00:00:00+04:00` : null,
        ends_at: form.mode === "dates" && form.endDate ? `${form.endDate}T23:59:59+04:00` : null,
        max_orders: form.mode === "orders" ? Number(form.maxOrders) : null,
        active: true,
      });
      setForm(blank);
      await reload();
    } catch (err) {
      setFormError("ما انحفظ العرض: " + (err.message || err));
    }
    setBusy(false);
  }

  async function toggleOffer(o) {
    setBusy(true);
    try { await saveOffer({ ...o, active: !o.active }); await reload(); } catch (err) { setState((s) => ({ ...s, error: String(err.message || err) })); }
    setBusy(false);
  }

  function removeOffer(o) {
    setConfirmState({
      message: `حذف العرض "${o.name}" نهائيًا؟ الطلبات السابقة ما تتأثر.`,
      onConfirm: async () => { try { await deleteOffer(o.id); await reload(); } catch (err) { setState((s) => ({ ...s, error: String(err.message || err) })); } },
    });
  }

  async function createCode(e) {
    e.preventDefault();
    setCodeError("");
    const v = Number(codeForm.value);
    if (!(v > 0)) return setCodeError("اكتب قيمة الخصم.");
    if (codeForm.kind === "percent" && v >= 100) return setCodeError("نسبة الخصم لازم تكون أقل من 100.");
    let maxUses = null;
    if (codeForm.usage === "once") maxUses = 1;
    else if (codeForm.usage === "twice") maxUses = 2;
    else if (codeForm.usage === "custom") {
      maxUses = Number(codeForm.maxUses);
      if (!(Number.isInteger(maxUses) && maxUses >= 1)) return setCodeError("اكتب عدد الاستخدامات (رقم صحيح من 1 فأكثر).");
    }
    if (codeForm.validity === "range") {
      if (!codeForm.startDate && !codeForm.expires) return setCodeError("اختر تاريخ بداية أو نهاية للكود.");
      if (codeForm.startDate && codeForm.expires && codeForm.expires < codeForm.startDate) return setCodeError("تاريخ النهاية قبل تاريخ البداية.");
    }
    const commission = codeForm.commission === "" ? null : Number(codeForm.commission);
    const isFixed = codeForm.commissionType === "fixed";
    if (commission != null && !(commission >= 0)) return setCodeError("العمولة لازم تكون رقم موجب.");
    if (commission != null && !isFixed && commission > 100) return setCodeError("نسبة العمولة لازم تكون بين 0 و100.");
    if (commission != null && !codeForm.marketer.trim()) return setCodeError("اكتب اسم المسوّق عشان تنحسب له العمولة.");
    setBusy(true);
    try {
      await saveCode({
        marketer_name: codeForm.marketer.trim(),
        commission_type: isFixed ? "fixed" : "percent",
        commission_percent: codeForm.marketer.trim() && !isFixed ? commission : null,
        commission_fixed: codeForm.marketer.trim() && isFixed ? commission : null,
        code: codeForm.code,
        percent_off: codeForm.kind === "percent" ? v : null,
        amount_off: codeForm.kind === "amount" ? v : null,
        max_uses: maxUses,
        starts_at: codeForm.validity === "range" && codeForm.startDate ? `${codeForm.startDate}T00:00:00+04:00` : null,
        expires_at: codeForm.validity === "range" && codeForm.expires ? `${codeForm.expires}T23:59:59+04:00` : null,
        active: true,
      });
      setCodeForm(blankCode);
      await reload();
    } catch (err) {
      setCodeError(err.message === "invalid_code" ? "الكود لازم يكون حروف إنجليزية أو أرقام (3 إلى 30)." : "ما انحفظ الكود: " + (err.message || err));
    }
    setBusy(false);
  }

  async function toggleCode(c) {
    setBusy(true);
    try {
      await saveCode({ code: c.code, percent_off: c.percent_off, amount_off: c.amount_off, max_uses: c.max_uses, starts_at: c.starts_at, expires_at: c.expires_at, active: !c.active, marketer_name: c.marketer_name || "", commission_type: c.commission_type || "percent", commission_percent: c.commission_percent, commission_fixed: c.commission_fixed });
      await reload();
    } catch (err) { setState((s) => ({ ...s, error: String(err.message || err) })); }
    setBusy(false);
  }

  function removeCode(c) {
    setConfirmState({
      message: `حذف الكود ${c.code} نهائيًا؟`,
      onConfirm: async () => { try { await deleteCode(c.code); await reload(); } catch (err) { setState((s) => ({ ...s, error: String(err.message || err) })); } },
    });
  }

  function toggleProduct(id) {
    setForm((f) => ({ ...f, productIds: f.productIds.includes(id) ? f.productIds.filter((x) => x !== id) : [...f.productIds, id] }));
  }

  return (
    <div className="page">
      <PageHead
        eyebrow="المتجر الإلكتروني"
        title="العروض والخصومات"
        desc="العرض يظهر تلقائيًا لكل زوار الموقع بدون كود: السعر القديم مشطوب والسعر الجديد وعليه نسبة الخصم. الخصم يتحسب بالسيرفر، فما أحد يقدر يتلاعب فيه."
        action={<button className="btn-ghost" onClick={reload} disabled={busy}><RefreshCw size={15} /> تحديث</button>}
      />
      {state.error && <div className="alert-banner" style={{ marginBottom: 12 }}><AlertCircle size={15} /> {state.error}</div>}
      {confirmState && (
        <div className="alert-banner" style={{ marginBottom: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: 1 }}>{confirmState.message}</span>
          <button className="btn-primary" onClick={async () => { const c = confirmState; setConfirmState(null); await c.onConfirm(); }}>نعم، احذف</button>
          <button className="btn-ghost" onClick={() => setConfirmState(null)}>إلغاء</button>
        </div>
      )}

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-head"><h3>عرض جديد</h3></div>
        <form onSubmit={createOffer}>
          <div className="grid-2">
            <Field label="اسم العرض (يظهر للعميل)">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="عرض الافتتاح" maxLength={80} />
            </Field>
            <Field label="اسم العرض بالإنجليزي (اختياري)" hint="لو تركته فاضي بيترجم تلقائيًا للإنجليزي">
              <input value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} placeholder="Launch offer" maxLength={80} dir="ltr" />
            </Field>
            <Field label="نسبة الخصم %">
              <input type="number" min="1" max="99" value={form.percent} onChange={(e) => setForm({ ...form, percent: e.target.value })} placeholder="20" />
            </Field>
          </div>

          <Field label="على أي عطور؟">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className={form.scope === "all" ? "btn-primary" : "btn-ghost"} onClick={() => setForm({ ...form, scope: "all" })}>كل العطور</button>
              <button type="button" className={form.scope === "products" ? "btn-primary" : "btn-ghost"} onClick={() => setForm({ ...form, scope: "products" })}>عطور محددة</button>
            </div>
          </Field>
          {form.scope === "products" && (
            <div className="mini-list" style={{ marginBottom: 12 }}>
              {state.products.map((p) => (
                <label className="mini-list-row" key={p.id} style={{ cursor: "pointer", gap: 10 }}>
                  <input type="checkbox" checked={form.productIds.includes(String(p.id))} onChange={() => toggleProduct(String(p.id))} />
                  <span style={{ flex: 1 }}>{productLabel(p)}</span>
                  <span className="num">{p.price != null ? `${Number(p.price).toFixed(3)} ر.ع` : "—"}</span>
                </label>
              ))}
            </div>
          )}

          <Field label="مدة العرض">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className={form.mode === "permanent" ? "btn-primary" : "btn-ghost"} onClick={() => setForm({ ...form, mode: "permanent" })}>دائم (لين أوقفه)</button>
              <button type="button" className={form.mode === "orders" ? "btn-primary" : "btn-ghost"} onClick={() => setForm({ ...form, mode: "orders" })}>لعدد طلبات محدد</button>
              <button type="button" className={form.mode === "dates" ? "btn-primary" : "btn-ghost"} onClick={() => setForm({ ...form, mode: "dates" })}>لفترة زمنية</button>
            </div>
          </Field>
          {form.mode === "permanent" && (
            <p style={{ margin: "-4px 0 12px", fontSize: 12, color: "var(--ink-soft)" }}>العرض يضل شغّال بدون نهاية، وتقدر توقفه أو تحذفه بأي وقت من القائمة تحت.</p>
          )}
          {form.mode === "orders" && (
            <Field label="لأول كم طلب؟" hint="مثال: 10 فيصير الخصم لأول 10 طلبات، وبعدها يختفي من الموقع تلقائيًا. الحد يُحسب لكل طلب (مو لكل قطعة).">
              <input type="number" min="1" value={form.maxOrders} onChange={(e) => setForm({ ...form, maxOrders: e.target.value })} placeholder="10" />
            </Field>
          )}
          {form.mode === "dates" && (
            <>
              <div className="grid-2">
                <Field label="يبدأ (فاضي = الآن)">
                  <input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
                </Field>
                <Field label="ينتهي">
                  <input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
                </Field>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "-4px 0 12px" }}>
                <button type="button" className="btn-ghost" onClick={() => setForm({ ...form, endDate: addDaysDate(7) })}>أسبوع من اليوم</button>
                <button type="button" className="btn-ghost" onClick={() => setForm({ ...form, endDate: addDaysDate(30) })}>شهر من اليوم</button>
              </div>
            </>
          )}

          {formError && <div className="alert-banner" style={{ marginBottom: 10 }}><AlertCircle size={15} /> {formError}</div>}
          <button className="btn-primary" type="submit" disabled={busy}><Plus size={15} /> {busy ? "..." : "تفعيل العرض"}</button>
        </form>
      </div>

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-head"><h3>العروض الحالية والسابقة</h3></div>
        {state.loading ? (
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-soft)" }}>جاري التحميل...</p>
        ) : state.offers.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-soft)" }}>ما فيه عروض بعد.</p>
        ) : (
          <div className="mini-list">
            {state.offers.map((o) => {
              const st = offerStatus(o, state.now);
              const names = o.applies_to === "all" ? "كل العطور" : (o.product_ids || []).map((id) => productById[String(id)]?.name_ar || productById[String(id)]?.name_en || id).join("، ");
              const when = o.max_orders != null && !o.ends_at && !o.starts_at
                ? `لأول ${o.max_orders} طلب`
                : !o.ends_at && !o.starts_at && o.max_orders == null
                  ? "دائم (بدون نهاية)"
                  : `${o.starts_at ? "من " + muscatDate(o.starts_at) : "من البداية"} ${o.ends_at ? "إلى " + muscatDate(o.ends_at) : "بدون نهاية"}`;
              return (
                <div className="mini-list-row" key={o.id} style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ flex: 1, minWidth: 220 }}>
                    <strong>{o.name}</strong>{o.name_en ? <span style={{ color: "var(--ink-soft)", fontWeight: 400 }} dir="ltr"> ({o.name_en})</span> : null} — {Number(o.percent_off)}%
                    <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                      {names} · {when}{o.max_orders != null ? ` · استُخدم ${o.used} من ${o.max_orders} طلب` : o.used ? ` · ${o.used} طلب` : ""}
                    </div>
                  </span>
                  <span className={`badge ${st.cls}`}>{st.label}</span>
                  <button className="btn-ghost" disabled={busy} onClick={() => toggleOffer(o)}>{o.active ? "إيقاف" : "تشغيل"}</button>
                  <button className="btn-ghost" disabled={busy} onClick={() => removeOffer(o)}><Trash2 size={14} /></button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head"><h3>أكواد الخصم (يكتبها العميل بصفحة الدفع)</h3></div>
        <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--ink-soft)" }}>لما العميل يكتب كود صحيح، يلغي عرض الموقع على طلبه ويتطبّق الكود فقط على السعر الأصلي (ما يجتمع خصمان). الكود يكتبه العميل بحروف إنجليزية.</p>
        <form onSubmit={createCode}>
          <div className="grid-2">
            <Field label="الكود"><input value={codeForm.code} onChange={(e) => setCodeForm({ ...codeForm, code: e.target.value.toUpperCase() })} placeholder="WELCOME10" dir="ltr" /></Field>
            <Field label="نوع الخصم">
              <select value={codeForm.kind} onChange={(e) => setCodeForm({ ...codeForm, kind: e.target.value })}>
                <option value="percent">نسبة مئوية %</option>
                <option value="amount">مبلغ ثابت (ر.ع)</option>
              </select>
            </Field>
            <Field label="القيمة"><input type="number" step="any" value={codeForm.value} onChange={(e) => setCodeForm({ ...codeForm, value: e.target.value })} /></Field>
          </div>
          <Field label="كم مرة يُستخدم الكود؟" hint="يُحسب الاستخدام لكل طلب مدفوع. لو العميل فتح صفحة الدفع وتركها، ما يُحسب إلا بعد 30 دقيقة.">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[["once", "مرة واحدة"], ["twice", "مرتين"], ["custom", "عدد محدد"], ["unlimited", "بدون حد"]].map(([k, l]) => (
                <button type="button" key={k} className={codeForm.usage === k ? "btn-primary" : "btn-ghost"} onClick={() => setCodeForm({ ...codeForm, usage: k })}>{l}</button>
              ))}
            </div>
          </Field>
          {codeForm.usage === "custom" && (
            <Field label="عدد الاستخدامات"><input type="number" min="1" value={codeForm.maxUses} onChange={(e) => setCodeForm({ ...codeForm, maxUses: e.target.value })} placeholder="5" /></Field>
          )}
          <Field label="مدة صلاحية الكود">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className={codeForm.validity === "none" ? "btn-primary" : "btn-ghost"} onClick={() => setCodeForm({ ...codeForm, validity: "none" })}>بدون انتهاء</button>
              <button type="button" className={codeForm.validity === "range" ? "btn-primary" : "btn-ghost"} onClick={() => setCodeForm({ ...codeForm, validity: "range" })}>لفترة محددة</button>
            </div>
          </Field>
          {codeForm.validity === "range" && (
            <>
              <div className="grid-2">
                <Field label="يبدأ (فاضي = الآن)"><input type="date" value={codeForm.startDate} onChange={(e) => setCodeForm({ ...codeForm, startDate: e.target.value })} /></Field>
                <Field label="ينتهي"><input type="date" value={codeForm.expires} onChange={(e) => setCodeForm({ ...codeForm, expires: e.target.value })} /></Field>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "-4px 0 12px" }}>
                <button type="button" className="btn-ghost" onClick={() => setCodeForm({ ...codeForm, expires: addDaysDate(7) })}>أسبوع من اليوم</button>
                <button type="button" className="btn-ghost" onClick={() => setCodeForm({ ...codeForm, expires: addDaysDate(30) })}>شهر من اليوم</button>
              </div>
            </>
          )}
          <div className="grid-2">
            <Field label="اسم المسوّق (اختياري)" hint="لو الكود لشخص يسوّق لك، اكتب اسمه عشان تطلع له إحصائية شهرية في قسم «المسوّقون»."><input value={codeForm.marketer} onChange={(e) => setCodeForm({ ...codeForm, marketer: e.target.value })} placeholder="مثال: سارة" maxLength={80} /></Field>
            <Field label="نوع عمولة المسوّق" hint={codeForm.commissionType === "fixed" ? "مبلغ ثابت يستلمه عن كل منتج (قطعة) يُباع بكوده، يعني لو العميل اشترى 3 قطع يستلم 3 أضعاف المبلغ." : "نسبة من سعر كل منتج بعد الخصم."}>
              <select value={codeForm.commissionType} onChange={(e) => setCodeForm({ ...codeForm, commissionType: e.target.value, commission: "" })}>
                <option value="percent">نسبة مئوية %</option>
                <option value="fixed">مبلغ ثابت لكل منتج (ر.ع)</option>
              </select>
            </Field>
            <Field label={codeForm.commissionType === "fixed" ? "مبلغ العمولة لكل منتج (ر.ع) — اختياري" : "نسبة العمولة % — اختياري"}><input type="number" step="any" min="0" max={codeForm.commissionType === "fixed" ? undefined : 100} value={codeForm.commission} onChange={(e) => setCodeForm({ ...codeForm, commission: e.target.value })} placeholder={codeForm.commissionType === "fixed" ? "1.000" : "10"} dir="ltr" /></Field>
          </div>
          {codeError && <div className="alert-banner" style={{ marginBottom: 10 }}><AlertCircle size={15} /> {codeError}</div>}
          <button className="btn-primary" type="submit" disabled={busy}><Plus size={15} /> إضافة الكود</button>
        </form>
        {state.codes.length > 0 && (
          <div className="mini-list" style={{ marginTop: 14 }}>
            {state.codes.map((c) => (
              <div className="mini-list-row" key={c.code} style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ flex: 1 }}>
                  <strong dir="ltr">{c.code}</strong> — {c.percent_off != null ? `${Number(c.percent_off)}%` : `${Number(c.amount_off).toFixed(3)} ر.ع`}{c.marketer_name ? <span style={{ color: "var(--ink-soft)", fontWeight: 400 }}> · المسوّق: {c.marketer_name}{c.commission_type === "fixed" && c.commission_fixed != null ? ` (${Number(c.commission_fixed).toFixed(3)} ر.ع لكل منتج)` : c.commission_percent != null ? ` (${Number(c.commission_percent)}%)` : ""}</span> : null}
                  <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                    استُخدم {c.used_count || 0}{c.max_uses != null ? ` من ${c.max_uses}` : ""}
                    {c.starts_at ? ` · يبدأ ${muscatDate(c.starts_at)}` : ""}{c.expires_at ? ` · ينتهي ${muscatDate(c.expires_at)}` : (!c.starts_at ? " · بدون انتهاء" : "")}
                  </div>
                </span>
                {(() => { const st = codeStatus(c, state.now); return <span className={`badge ${st.cls}`}>{st.label}</span>; })()}
                <button className="btn-ghost" disabled={busy} onClick={() => toggleCode(c)}>{c.active ? "إيقاف" : "تشغيل"}</button>
                <button className="btn-ghost" disabled={busy} onClick={() => removeCode(c)}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MarketersTab() {
  const thisMonth = () => muscatDate(new Date().toISOString()).slice(0, 7);
  const [month, setMonth] = useState(thisMonth());
  const [state, setState] = useState({ loading: true, error: "", rows: [] });

  async function load(m) {
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const r = await marketerReport(m);
      setState({ loading: false, error: "", rows: r.rows || [] });
    } catch (e) {
      setState({ loading: false, error: "تعذر جلب التقرير. تأكد من تحديث دالة accounting-orders وتشغيل ملف add_marketer_codes.sql. (" + (e.message || e) + ")", rows: [] });
    }
  }
  useEffect(() => { load(month); }, [month]);

  function shiftMonth(delta) {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    setMonth(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }

  // نجمّع حسب المسوّق (لو عنده أكثر من كود)
  const grouped = useMemo(() => {
    const map = new Map();
    for (const r of state.rows) {
      const g = map.get(r.marketer) || { marketer: r.marketer, codes: [], orders: 0, units: 0, customers: 0, sales: 0, commission: 0, hasCommission: false };
      g.codes.push(r.code);
      g.orders += r.orders; g.units += r.units || 0; g.customers += r.customers; g.sales += r.sales;
      if (r.commission != null) { g.commission += r.commission; g.hasCommission = true; }
      map.set(r.marketer, g);
    }
    return [...map.values()].sort((a, b) => b.orders - a.orders);
  }, [state.rows]);
  const totals = grouped.reduce((t, g) => ({ orders: t.orders + g.orders, sales: t.sales + g.sales, commission: t.commission + g.commission }), { orders: 0, sales: 0, commission: 0 });

  function downloadCsv() {
    const lines = [["المسوّق", "الأكواد", "عدد الطلبات", "عدد القطع", "عدد العملاء", "المبيعات (ر.ع)", "العمولة (ر.ع)"]];
    for (const g of grouped) lines.push([g.marketer, g.codes.join(" + "), g.orders, g.units, g.customers, g.sales.toFixed(3), g.hasCommission ? g.commission.toFixed(3) : ""]);
    const csv = "﻿" + lines.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `marketers-${month}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
  const [yy, mm] = month.split("-").map(Number);

  return (
    <div className="page">
      <PageHead
        eyebrow="المتجر الإلكتروني"
        title="المسوّقون والعمولات"
        desc="لإنشاء كود لمسوّق: روح «العروض والخصومات» وأضف كود جديد واكتب اسم المسوّق ونسبة عمولته. هنا تشوف كل شهر كم طلب وعميل جابهم وكم عمولته. الطلبات الملغية لا تُحسب."
      />
      <div className="panel">
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
          <button className="btn-ghost" onClick={() => shiftMonth(-1)}>الشهر السابق</button>
          <strong style={{ minWidth: 120, textAlign: "center" }}>{MONTHS[mm - 1]} {yy}</strong>
          <button className="btn-ghost" onClick={() => shiftMonth(1)} disabled={month >= thisMonth()}>الشهر التالي</button>
          <span style={{ flex: 1 }} />
          <button className="btn-ghost" onClick={downloadCsv} disabled={!grouped.length}>تنزيل Excel (CSV)</button>
        </div>
        {state.error && <div className="alert-banner"><AlertCircle size={15} /> {state.error}</div>}
        {state.loading && !state.error && <div style={{ color: "var(--ink-soft)" }}>جاري التحميل...</div>}
        {!state.loading && !state.error && grouped.length === 0 && (
          <div style={{ color: "var(--ink-soft)" }}>ما في مسوّقين بعد. أضف كود بإسم مسوّق من «العروض والخصومات».</div>
        )}
        {!state.loading && !state.error && grouped.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>المسوّق</th><th>الكود</th><th>الطلبات</th><th>القطع</th><th>العملاء</th><th>المبيعات (ر.ع)</th><th>العمولة (ر.ع)</th></tr></thead>
              <tbody>
                {grouped.map((g) => (
                  <tr key={g.marketer}>
                    <td><strong>{g.marketer}</strong></td>
                    <td dir="ltr" style={{ textAlign: "right" }}>{g.codes.join(" + ")}</td>
                    <td>{g.orders}</td>
                    <td>{g.units}</td>
                    <td>{g.customers}</td>
                    <td>{fmt(g.sales)}</td>
                    <td>{g.hasCommission ? <strong>{fmt(g.commission)}</strong> : "—"}</td>
                  </tr>
                ))}
                <tr style={{ fontWeight: 700 }}>
                  <td>الإجمالي</td><td></td><td>{totals.orders}</td><td>{grouped.reduce((n, g) => n + g.units, 0)}</td><td></td><td>{fmt(totals.sales)}</td><td>{fmt(totals.commission)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================== الإقرار الضريبي (ضريبة القيمة المضافة 5% — كشف داخلي) ============================== */

const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

function vatQuarterData(data, year, q) {
  const m0 = (q - 1) * 3 + 1;
  const months = [m0, m0 + 1, m0 + 2].map((m) => `${year}-${String(m).padStart(2, "0")}`);
  const invs = data.invoices
    .filter((i) => months.includes(String(i.date || "").slice(0, 7)))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.number || 0) - (b.number || 0)));
  const inputs = inputVatItems(data).filter((x) => months.includes(String(x.date || "").slice(0, 7)));
  const byMonth = months.map((key) => {
    const list = invs.filter((i) => String(i.date).slice(0, 7) === key);
    const gross = list.reduce((s, i) => s + invoiceComputed(i).grandTotal, 0);
    const input = inputs.filter((x) => String(x.date || "").slice(0, 7) === key).reduce((a, x) => a + x.amount, 0);
    return { key, label: AR_MONTHS[Number(key.slice(5)) - 1], count: list.length, gross, vat: vatOf(gross), net: gross - vatOf(gross), input };
  });
  const gross = byMonth.reduce((s, m) => s + m.gross, 0);
  const vat = byMonth.reduce((s, m) => s + m.vat, 0);
  const input = byMonth.reduce((s, m) => s + m.input, 0);
  return { year, q, months, invs, byMonth, gross, vat, input, due: vat - input, inputs, net: gross - vat };
}


/* ============================== الحسابات (صحار / كاش / ثواني) ============================== */

const ACCOUNTS = [
  { id: "sohar", name: "بنك صحار" },
  { id: "cash", name: "الكاش" },
  { id: "thawani", name: "ثواني (معلّق)" },
];
const accName = (id) => (ACCOUNTS.find((a) => a.id === id) || {}).name || id;
const settlementFee = (t) => Math.max(0, (Number(t.gross) || 0) - (Number(t.received) || 0));

function methodAccount(settings, method) {
  const m = String(method || "");
  const map = (settings && settings.methodAccounts) || {};
  if (map[m]) return map[m] === "none" ? null : map[m];
  if (/كاش|نقد/.test(m)) return "cash";
  if (/ثواني|بوابة|pos|POS|رابط/.test(m)) return "thawani";
  if (!m) return null;
  return "sohar";
}

function txnEffects(t) {
  const a = Number(t.amount) || 0;
  if (t.kind === "opening" || t.kind === "deposit" || t.kind === "capital") return [{ acc: t.account, amt: a }];
  if (t.kind === "withdraw" || t.kind === "partner_draw") return [{ acc: t.account, amt: -a }];
  if (t.kind === "transfer") return [{ acc: t.account, amt: -a }, { acc: t.to, amt: a }];
  if (t.kind === "settlement") return [{ acc: "thawani", amt: -(Number(t.gross) || 0) }, { acc: "sohar", amt: Number(t.received) || 0 }];
  return [];
}

function openingSince(txns) {
  const since = {};
  ACCOUNTS.forEach((a) => {
    const o = (txns || []).filter((t) => t.kind === "opening" && t.account === a.id).sort((x, y) => String(y.date).localeCompare(String(x.date)))[0];
    since[a.id] = o ? o.date : "";
  });
  return since;
}

// مصاريف الشحن التلقائية: صف لكل فاتورة فيها شحن (مشتق من الفواتير — ما يتخزن، فيروح مع الفاتورة لو انحذفت).
// فواتير الكاش/التحويل: تنخصم يوم الفاتورة. فواتير ثواني: تنخصم من صحار يوم تسوية ثواني اللي تغطيها (الأقدم أولًا).
function shippingLedger(data, extraGross = 0) {
  const txns = data.bankTxns || [];
  const since = openingSince(txns);
  const shipAcc = (data.settings && data.settings.shippingAccount) || "sohar";
  const settles = txns.filter((t) => t.kind === "settlement").sort((x, y) => String(x.date).localeCompare(String(y.date)));
  const settledTotal = settles.reduce((sum, t) => sum + (Number(t.gross) || 0), 0) + (Number(extraGross) || 0);
  const settleDateFor = (cum) => {
    let run = 0;
    for (const t of settles) { run += Number(t.gross) || 0; if (cum <= run + 0.0005) return t.date; }
    return extraGross > 0 ? "قيد التسجيل" : "";
  };
  const rows = [];
  let cum = 0;
  [...data.invoices].sort((x, y) => String(x.date).localeCompare(String(y.date)) || (Number(x.number) || 0) - (Number(y.number) || 0)).forEach((inv) => {
    const acc = methodAccount(data.settings, inv.paymentMethod);
    if (!acc) return;
    if (!countsInAccounts(inv)) return;
    if (since[acc] && String(inv.date) < since[acc]) return;
    const c = invoiceComputed(inv);
    let settled = true, date = inv.date, account = acc === "cash" ? "cash" : shipAcc;
    if (acc === "thawani") {
      cum += c.totalPaid;
      settled = cum <= settledTotal + 0.0005;
      date = settled ? settleDateFor(cum) : "";
      account = shipAcc;
    }
    if (isVoid(inv)) return; // الملغاة: ما يتسجل لها مصروف شحن
    if (!(c.shipping > 0)) return;
    const effective = date && date !== "قيد التسجيل" ? date : "";
    const deducted = settled && (!effective || !since[account] || effective >= since[account]);
    rows.push({ id: inv.id, invoiceNo: inv.number, webNo: inv.webInvoiceNumber || "", invDate: inv.date, amount: c.shipping, account, settled, date, deducted });
  });
  return rows;
}

function accountBalances(data) {
  const txns = data.bankTxns || [];
  const bal = { sohar: 0, cash: 0, thawani: 0 };
  const sales = { sohar: 0, cash: 0, thawani: 0 };
  const since = openingSince(txns);
  ACCOUNTS.forEach((a) => {
    const o = txns.filter((t) => t.kind === "opening" && t.account === a.id).sort((x, y) => String(y.date).localeCompare(String(x.date)))[0];
    if (o) bal[a.id] += Number(o.amount) || 0;
  });
  let refunds = 0;
  data.invoices.forEach((inv) => {
    const acc = methodAccount(data.settings, inv.paymentMethod);
    if (!acc || !bal.hasOwnProperty(acc)) return;
    if (!countsInAccounts(inv)) return;
    if (since[acc] && String(inv.date) < since[acc]) return;
    const g = invoiceComputed(inv).totalPaid || 0;
    sales[acc] += g; bal[acc] += g;
    const rf = voidRefund(inv);
    if (rf > 0) {
      const ra = (inv.void && inv.void.refundAccount) || acc;
      const rd = (inv.void && inv.void.refundDate) || inv.date;
      if (bal.hasOwnProperty(ra) && !(since[ra] && String(rd) < since[ra])) { bal[ra] -= rf; refunds += rf; }
    }
  });
  txns.filter((t) => t.kind !== "opening").forEach((t) => txnEffects(t).forEach((e) => { if (bal.hasOwnProperty(e.acc)) bal[e.acc] += e.amt; }));
  // المصروفات اليدوية + مصاريف الشحن التلقائية المخصومة
  const manual = (data.expenses || []);
  manual.forEach((x) => { if (bal.hasOwnProperty(x.account)) bal[x.account] -= Number(x.amount) || 0; });
  // مشتريات / تسويق / معدات / تأسيس المربوطة بحساب
  let linked = 0;
  linkedOutflows(data).forEach((o) => {
    if (!bal.hasOwnProperty(o.account)) return;
    if (since[o.account] && String(o.date) < since[o.account]) return;
    bal[o.account] -= o.amount; linked += o.amount;
  });
  const ship = shippingLedger(data);
  let shipOut = 0, shipPending = 0;
  ship.forEach((r) => { if (r.deducted) { bal[r.account] -= r.amount; shipOut += r.amount; } else if (!r.settled) shipPending += r.amount; });
  const fees = txns.filter((t) => t.kind === "settlement").reduce((sum, t) => sum + settlementFee(t), 0);
  return { bal, sales, since, fees, shipOut, shipPending, refunds, linked };
}

function AccountsTab({ data, persist, currentUser }) {
  const txns = data.bankTxns || [];
  const info = useMemo(() => accountBalances(data), [data]);
  const today = muscatDate(new Date().toISOString());
  const [open, setOpen] = useState({ account: "sohar", amount: "", date: today });
  const [mv, setMv] = useState({ kind: "deposit", account: "sohar", to: "cash", amount: "", date: today, note: "" });
  const [st, setSt] = useState({ gross: "", received: "", date: today, note: "" });
  const [stmt, setStmt] = useState("");
  const methods = data.settings.paymentMethods || [];

  function add(t) { persist({ ...data, bankTxns: [...txns, { id: uid("bt"), createdBy: currentUser?.name, ...t }] }); }
  function remove(id) {
    const t = txns.find((x) => x.id === id);
    if (t && isLocked(data, t.date)) { alert(lockMsg(data)); return; }
    persist({ ...data, bankTxns: txns.filter((x) => x.id !== id) });
  }
  function saveOpening() {
    if (open.amount === "" || !open.date) return;
    const rest = txns.filter((t) => !(t.kind === "opening" && t.account === open.account));
    persist({ ...data, bankTxns: [...rest, { id: uid("bt"), kind: "opening", account: open.account, amount: Number(open.amount), date: open.date, note: "رصيد افتتاحي", createdBy: currentUser?.name }] });
    setOpen({ ...open, amount: "" });
  }
  const mvBad = !(Number(mv.amount) > 0) || !mv.date || (mv.kind === "transfer" && mv.account === mv.to);
  function saveMove() {
    if (mvBad) return;
    add({ kind: mv.kind, account: mv.account, to: mv.kind === "transfer" ? mv.to : undefined, amount: Number(mv.amount), date: mv.date, note: mv.note });
    setMv({ ...mv, amount: "", note: "" });
  }
  const stGross = st.gross === "" ? info.bal.thawani : Number(st.gross);
  const stBad = !(stGross > 0) || st.received === "" || Number(st.received) < 0 || Number(st.received) > stGross + 1e-9 || !st.date;
  const stFee = Math.max(0, stGross - (Number(st.received) || 0));
  function saveSettlement() {
    if (stBad) return;
    add({ kind: "settlement", gross: Number(stGross.toFixed(3)), received: Number(st.received), date: st.date, note: st.note });
    setSt({ gross: "", received: "", date: today, note: "" });
  }
  function setMap(method, val) {
    const m = { ...(data.settings.methodAccounts || {}), [method]: val };
    persist({ ...data, settings: { ...data.settings, methodAccounts: m } });
  }
  function addThawaniMethods() {
    const cur = data.settings.paymentMethods || [];
    const add2 = ["ثواني - POS", "ثواني - رابط دفع", "تحويل بنكي - صحار"].filter((x) => !cur.includes(x));
    if (add2.length) persist({ ...data, settings: { ...data.settings, paymentMethods: [...cur, ...add2] } });
  }
  const KIND = { opening: "رصيد افتتاحي", deposit: "إيداع", withdraw: "سحب / مصروف", transfer: "تحويل بين حسابين", settlement: "تسوية ثواني", partner_draw: "سحب شريك", capital: "رأس مال شريك" };
  const partners = data.settings.partners || [];
  const [pt, setPt] = useState({ kind: "partner_draw", partnerId: (partners[0] || {}).id || "", account: "sohar", amount: "", date: today, note: "" });
  const ptBad = !pt.partnerId || !(Number(pt.amount) > 0) || !pt.date;
  function savePartnerTxn() {
    if (ptBad) return;
    add({ kind: pt.kind, partnerId: pt.partnerId, account: pt.account, amount: Number(pt.amount), date: pt.date, note: pt.note });
    setPt({ ...pt, amount: "", note: "" });
  }
  const partnerName = (id) => (partners.find((p) => p.id === id) || {}).name || "—";
  const linked = useMemo(() => linkedOutflows(data).filter((o) => !(info.since[o.account] && String(o.date) < info.since[o.account])).sort((a, b) => String(b.date).localeCompare(String(a.date))), [data, info]);
  const refundedInv = data.invoices.filter((i) => voidRefund(i) > 0);
  const stmtDiff = stmt === "" ? null : Number(stmt) - info.bal.sohar;

  return (
    <div className="page">
      <PageHead eyebrow="الحسابات" title="الحسابات والشركاء: بنك صحار · الكاش · ثواني" desc="الرصيد يتحسب تلقائيًا: الافتتاحي + المبيعات + الإيداعات − السحوبات − المصروفات (ومنها الشحن). ثواني تحوّل لصحار بعد يومين، وفرق التحويل = رسوم تنخصم من الربح." />

      <div className="kpi-row">
        {ACCOUNTS.map((a) => (
          <div className="kpi-card" key={a.id} style={{ "--accent": a.id === "sohar" ? "var(--teal)" : a.id === "cash" ? "var(--copper)" : "#6B4C8C" }}>
            <Wallet size={16} className="kpi-icon" />
            <div className="kpi-label">{a.name}</div>
            <div className="kpi-value">{fmt(info.bal[a.id])} <span className="unit">ر.ع</span></div>
            <div className="panel-sub">{info.since[a.id] ? `الافتتاحي بتاريخ ${info.since[a.id]}` : "ما سجلت رصيد افتتاحي بعد"}</div>
          </div>
        ))}
        <div className="kpi-card" style={{ "--accent": "#8C3D5A" }}>
          <div className="kpi-label">إجمالي رسوم ثواني</div>
          <div className="kpi-value">{fmt(info.fees)} <span className="unit">ر.ع</span></div>
        </div>
        <div className="kpi-card" style={{ "--accent": "#5C6A63" }}>
          <div className="kpi-label">مشتريات وتسويق ومعدات مخصومة</div>
          <div className="kpi-value">{fmt(info.linked)} <span className="unit">ر.ع</span></div>
        </div>
        {info.refunds > 0 && (
          <div className="kpi-card" style={{ "--accent": "var(--danger)" }}>
            <div className="kpi-label">مرتجعات مردودة للعملاء</div>
            <div className="kpi-value">{fmt(info.refunds)} <span className="unit">ر.ع</span></div>
          </div>
        )}
        <div className="kpi-card" style={{ "--accent": "#3D6B8C" }}>
          <div className="kpi-label">شحن مخصوم من الحسابات</div>
          <div className="kpi-value">{fmt(info.shipOut)} <span className="unit">ر.ع</span></div>
          {info.shipPending > 0 && <div className="panel-sub">شحن بانتظار تسوية ثواني: {fmt(info.shipPending)} ر.ع</div>}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>1) الرصيد الافتتاحي (مرة وحدة)</h3><span className="panel-sub">اكتب الرصيد الحالي اليوم، وما بعد كذا البرنامج يكمل لحاله. المبيعات قبل تاريخ الافتتاحي ما تنحسب.</span></div>
        <div className="form-row four">
          <Field label="الحساب"><select value={open.account} onChange={(e) => setOpen({ ...open, account: e.target.value })}>{ACCOUNTS.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
          <Field label="الرصيد (ر.ع)"><input type="number" value={open.amount} onChange={(e) => setOpen({ ...open, amount: e.target.value })} /></Field>
          <Field label="بتاريخ"><input type="date" value={open.date} onChange={(e) => setOpen({ ...open, date: e.target.value })} /></Field>
        </div>
        <button className="btn-primary" onClick={saveOpening} disabled={open.amount === "" || !open.date}>حفظ الرصيد الافتتاحي</button>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>2) تسوية ثواني (لما يوصلك التحويل في صحار)</h3><span className="panel-sub">المعلّق عند ثواني الحين: {fmt(info.bal.thawani)} ر.ع</span></div>
        <div className="form-row four">
          <Field label="المبلغ الإجمالي قبل الرسوم" hint="فاضي = كل المعلّق"><input type="number" value={st.gross} placeholder={fmt(info.bal.thawani)} onChange={(e) => setSt({ ...st, gross: e.target.value })} /></Field>
          <Field label="المبلغ اللي وصل صحار فعلاً"><input type="number" value={st.received} onChange={(e) => setSt({ ...st, received: e.target.value })} /></Field>
          <Field label="تاريخ الوصول"><input type="date" value={st.date} onChange={(e) => setSt({ ...st, date: e.target.value })} /></Field>
          <Field label="ملاحظة"><input value={st.note} onChange={(e) => setSt({ ...st, note: e.target.value })} /></Field>
        </div>
        {st.received !== "" && !stBad && (() => { const d = shippingLedger(data, stGross).filter((r) => r.deducted).reduce((x, r) => x + r.amount, 0) - shippingLedger(data).filter((r) => r.deducted).reduce((x, r) => x + r.amount, 0); return d > 0.0005 ? <p className="field-hint">🚚 مع هالتسوية ينخصم من صحار شحن بقيمة {fmt(d)} ر.ع (للفواتير اللي تغطيها).</p> : null; })()}
        {st.received !== "" && !stBad && <p className="field-hint">الرسوم = {fmt(stFee)} ر.ع ({stGross > 0 ? ((stFee / stGross) * 100).toFixed(2) : 0}%) — تُسجَّل مصروف وتنخصم من الربح.</p>}
        {st.received !== "" && Number(st.received) > stGross && <p className="field-hint stock-warning">⚠️ الواصل أكبر من المعلّق — راجع المبلغ أو سجّل المبيعات الناقصة.</p>}
        <button className="btn-primary" onClick={saveSettlement} disabled={stBad}>تسجيل التسوية</button>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>3) حركة يدوية (إيداع / سحب / تحويل)</h3><span className="panel-sub">المشتريات والتسويق والمعدات والمصروفات تنخصم لحالها من خاناتها («مدفوع من حساب»). هنا للحركات الأخرى فقط.</span></div>
        <div className="form-row four">
          <Field label="النوع"><select value={mv.kind} onChange={(e) => setMv({ ...mv, kind: e.target.value })}><option value="deposit">إيداع</option><option value="withdraw">سحب / مصروف</option><option value="transfer">تحويل بين حسابين</option></select></Field>
          <Field label={mv.kind === "transfer" ? "من حساب" : "الحساب"}><select value={mv.account} onChange={(e) => setMv({ ...mv, account: e.target.value })}>{ACCOUNTS.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
          {mv.kind === "transfer" && <Field label="إلى حساب"><select value={mv.to} onChange={(e) => setMv({ ...mv, to: e.target.value })}>{ACCOUNTS.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}
          <Field label="المبلغ (ر.ع)"><input type="number" value={mv.amount} onChange={(e) => setMv({ ...mv, amount: e.target.value })} /></Field>
          <Field label="التاريخ"><input type="date" value={mv.date} onChange={(e) => setMv({ ...mv, date: e.target.value })} /></Field>
          <Field label="ملاحظة"><input value={mv.note} onChange={(e) => setMv({ ...mv, note: e.target.value })} /></Field>
        </div>
        <button className="btn-primary" onClick={saveMove} disabled={mvBad}><Plus size={16} /> إضافة</button>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>4) سحوبات الشركاء ورأس المال</h3><span className="panel-sub">سحب الشريك من أرباحه ينخصم من الحساب ويظهر «المتبقي» له في لوحة التحكم. ورأس المال المودَع يزيد الحساب.</span></div>
        <div className="form-row four">
          <Field label="النوع"><select value={pt.kind} onChange={(e) => setPt({ ...pt, kind: e.target.value })}><option value="partner_draw">سحب شريك (من الأرباح)</option><option value="capital">إيداع رأس مال</option></select></Field>
          <Field label="الشريك"><select value={pt.partnerId} onChange={(e) => setPt({ ...pt, partnerId: e.target.value })}>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="الحساب"><select value={pt.account} onChange={(e) => setPt({ ...pt, account: e.target.value })}>{PAY_ACCOUNTS.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
          <Field label="المبلغ (ر.ع)"><input type="number" value={pt.amount} onChange={(e) => setPt({ ...pt, amount: e.target.value })} /></Field>
          <Field label="التاريخ"><input type="date" value={pt.date} onChange={(e) => setPt({ ...pt, date: e.target.value })} /></Field>
          <Field label="ملاحظة"><input value={pt.note} onChange={(e) => setPt({ ...pt, note: e.target.value })} /></Field>
        </div>
        <button className="btn-primary" onClick={savePartnerTxn} disabled={ptBad}><Plus size={16} /> تسجيل</button>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>مطابقة مع كشف بنك صحار</h3></div>
        <div className="form-row four">
          <Field label="رصيد كشف البنك الحقيقي"><input type="number" value={stmt} onChange={(e) => setStmt(e.target.value)} /></Field>
        </div>
        {stmtDiff !== null && (Math.abs(stmtDiff) < 0.0005
          ? <p className="field-hint">✅ مطابق تمامًا لرصيد البرنامج ({fmt(info.bal.sohar)} ر.ع).</p>
          : <p className="field-hint stock-warning">⚠️ الفرق {fmt(stmtDiff)} ر.ع (الكشف − البرنامج). راجع تحويل غير مسجل أو تسوية ناقصة.</p>)}
      </div>

      <div className="panel">
        <div className="panel-head"><h3>ربط طرق الدفع بالحسابات</h3><button className="btn-ghost" onClick={addThawaniMethods}>أضف طرق الدفع الناقصة (ثواني POS / رابط، تحويل بنكي - صحار)</button></div>
        <div className="table-wrap"><table>
          <thead><tr><th>طريقة الدفع في الفاتورة</th><th>تنزل في حساب</th></tr></thead>
          <tbody>{methods.map((m) => (
            <tr key={m}><td className="strong">{m}</td><td>
              <select value={(data.settings.methodAccounts || {})[m] || methodAccount({}, m) || "none"} onChange={(e) => setMap(m, e.target.value)}>
                {ACCOUNTS.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                <option value="none">لا يدخل أي حساب</option>
              </select></td></tr>
          ))}</tbody></table></div>
        <Field label="الحساب اللي ينخصم منه الشحن (لفواتير التحويل وثواني)" hint="فواتير الكاش ينخصم شحنها من الكاش دائمًا"><select value={(data.settings && data.settings.shippingAccount) || "sohar"} onChange={(e) => persist({ ...data, settings: { ...data.settings, shippingAccount: e.target.value } })}><option value="sohar">بنك صحار</option><option value="cash">الكاش</option></select></Field>
        <p className="field-hint">تأكد إن تحويلات حسابات الشركاء الشخصية مضبوطة على «لا يدخل أي حساب» لو ما تبيها تدخل رصيد صحار.</p>
      </div>

      {(linked.length > 0 || refundedInv.length > 0) && (
        <div className="panel">
          <div className="panel-head"><h3>حركات مربوطة تلقائيًا من التبويبات الأخرى</h3><span className="panel-sub">للاطلاع فقط — تعدّلها من تبويبها الأصلي</span></div>
          <div className="table-wrap"><table>
            <thead><tr><th>التاريخ</th><th>النوع</th><th>البيان</th><th>الحساب</th><th>المبلغ</th></tr></thead>
            <tbody>
              {linked.slice(0, 40).map((o) => (<tr key={o.kind + o.id}><td>{o.date}</td><td><span className="badge blue">{o.kind}</span></td><td>{o.title}</td><td>{accName(o.account)}</td><td className="num neg">− {fmt(o.amount)} ر.ع</td></tr>))}
              {refundedInv.map((i) => (<tr key={"rf" + i.id}><td>{i.void.refundDate || i.void.date}</td><td><span className="badge red">مرتجع</span></td><td>فاتورة #{i.number} — {i.customerName || "عميل"}</td><td>{accName(i.void.refundAccount)}</td><td className="num neg">− {fmt(voidRefund(i))} ر.ع</td></tr>))}
            </tbody></table></div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head"><h3>سجل الحركات</h3></div>
        {txns.length === 0 ? <Empty icon={Wallet} title="ما فيه حركات" sub="ابدأ بالرصيد الافتتاحي فوق." /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>التاريخ</th><th>النوع</th><th>الحساب</th><th>المبلغ</th><th>الرسوم</th><th>ملاحظة</th><th></th></tr></thead>
            <tbody>{[...txns].sort((a, b) => String(b.date).localeCompare(String(a.date))).map((t) => (
              <tr key={t.id}>
                <td>{t.date}</td><td className="strong">{KIND[t.kind] || t.kind}</td>
                <td>{t.kind === "settlement" ? "ثواني ← صحار" : t.kind === "transfer" ? `${accName(t.account)} ← ${accName(t.to)}` : accName(t.account)}{t.partnerId ? ` · ${partnerName(t.partnerId)}` : ""}</td>
                <td className="num">{t.kind === "settlement" ? `${fmt(t.gross)} → ${fmt(t.received)}` : fmt(t.amount)}</td>
                <td className="num">{t.kind === "settlement" ? fmt(settlementFee(t)) : "—"}</td>
                <td>{t.note}</td>
                <td><button className="icon-btn danger" onClick={() => remove(t.id)}><Trash2 size={14} /></button></td>
              </tr>))}</tbody></table></div>
        )}
      </div>
    </div>
  );
}


function ExpensesTab({ data, persist, currentUser }) {
  const list = data.expenses || [];
  const today = muscatDate(new Date().toISOString());
  const empty = { date: today, title: "", amount: "", account: "sohar", invoiceNo: "", note: "", vat: "" };
  const [form, setForm] = useState(empty);
  const ship = useMemo(() => shippingLedger(data), [data]);
  const totalManual = list.reduce((sum, x) => sum + (Number(x.amount) || 0), 0);
  const shipDone = ship.filter((r) => r.deducted).reduce((sum, r) => sum + r.amount, 0);
  const shipWait = ship.filter((r) => !r.settled).reduce((sum, r) => sum + r.amount, 0);
  const bad = !form.title.trim() || !(Number(form.amount) > 0) || !form.date;
  function save() {
    if (bad) return;
    if (isLocked(data, form.date)) { alert(lockMsg(data)); return; }
    persist({ ...data, expenses: [...list, { id: uid("ex"), ...form, title: form.title.trim(), amount: Number(form.amount), createdBy: currentUser?.name }] });
    setForm({ ...empty, account: form.account });
  }
  function remove(id) {
    const x = list.find((y) => y.id === id);
    if (x && isLocked(data, x.date)) { alert(lockMsg(data)); return; }
    persist({ ...data, expenses: list.filter((y) => y.id !== id) });
  }
  const rows = [
    ...list.map((x) => ({ key: x.id, date: x.date, title: x.title, invoice: x.invoiceNo ? `#${x.invoiceNo}` : "", amount: x.amount, account: accName(x.account), kind: "يدوي", status: "مخصوم", id: x.id })),
    ...ship.map((r) => ({ key: "ship_" + r.id, date: r.date || r.invDate, title: `مصروف شحن — فاتورة #${r.invoiceNo}${r.webNo ? ` (${r.webNo})` : ""}`, invoice: `#${r.invoiceNo}`, amount: r.amount, account: accName(r.account), kind: "شحن تلقائي", status: r.deducted ? "مخصوم" : r.settled ? "قبل تاريخ الافتتاحي" : "بانتظار تسوية ثواني" })),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return (
    <div className="page">
      <PageHead eyebrow="المصروفات" title="المصروفات" desc="مصروف عام ينخصم من الحساب ومن الربح. ومصاريف الشحن تنكتب لحالها لكل فاتورة فيها شحن (تعادل إيراد الشحن، فما تأثر على الربح)." />
      <div className="kpi-row">
        <div className="kpi-card" style={{ "--accent": "var(--danger)" }}><div className="kpi-label">مصروفات عامة (تنخصم من الربح)</div><div className="kpi-value">{fmt(totalManual)} <span className="unit">ر.ع</span></div></div>
        <div className="kpi-card" style={{ "--accent": "#3D6B8C" }}><div className="kpi-label">شحن مخصوم من الحسابات</div><div className="kpi-value">{fmt(shipDone)} <span className="unit">ر.ع</span></div></div>
        <div className="kpi-card" style={{ "--accent": "#8C6B3D" }}><div className="kpi-label">شحن بانتظار تسوية ثواني</div><div className="kpi-value">{fmt(shipWait)} <span className="unit">ر.ع</span></div></div>
      </div>
      <div className="panel">
        <div className="panel-head"><h3>إضافة مصروف</h3><span className="panel-sub">لا تسجّل هنا تسويق أو خسائر أو تأسيس، لها تبويباتها.</span></div>
        <div className="form-row four">
          <Field label="البند"><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="مثال: إيجار، اشتراك..." /></Field>
          <Field label="المبلغ (ر.ع)"><input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
          <Field label="ينخصم من"><select value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })}><option value="sohar">بنك صحار</option><option value="cash">الكاش</option></select></Field>
          <Field label="التاريخ"><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
          <Field label="رقم فاتورة (اختياري)"><input value={form.invoiceNo} onChange={(e) => setForm({ ...form, invoiceNo: e.target.value })} /></Field>
          <Field label="ملاحظة"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
          <VatPaidField value={form.vat} onChange={(v) => setForm({ ...form, vat: v })} />
        </div>
        <button className="btn-primary" onClick={save} disabled={bad}><Plus size={16} /> إضافة المصروف</button>
      </div>
      {rows.length === 0 ? <Empty icon={Receipt} title="ما فيه مصروفات" sub="أضف أول مصروف من الفورم فوق." /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>التاريخ</th><th>البند</th><th>الفاتورة</th><th>المبلغ</th><th>الحساب</th><th>النوع</th><th>الحالة</th><th></th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.key}>
              <td>{r.date || "—"}</td><td className="strong">{r.title}</td><td>{r.invoice}</td><td className="num">{fmt(r.amount)} ر.ع</td><td>{r.account}</td>
              <td><span className={`badge ${r.kind === "يدوي" ? "green" : "blue"}`}>{r.kind}</span></td><td>{r.status}</td>
              <td>{r.id && <button className="icon-btn danger" onClick={() => remove(r.id)}><Trash2 size={14} /></button>}</td>
            </tr>))}</tbody></table></div>
      )}
    </div>
  );
}

function VatTab({ data }) {
  const nowYear = Number(muscatDate(new Date().toISOString()).slice(0, 4));
  const nowQ = Math.floor((Number(muscatDate(new Date().toISOString()).slice(5, 7)) - 1) / 3) + 1;
  const years = useMemo(() => {
    const ys = new Set([nowYear]);
    data.invoices.forEach((i) => { const y = Number(String(i.date || "").slice(0, 4)); if (y) ys.add(y); });
    return [...ys].sort((a, b) => b - a);
  }, [data.invoices, nowYear]);
  const [year, setYear] = useState(nowYear);
  const [q, setQ] = useState(nowQ);
  const d = useMemo(() => vatQuarterData(data, year, q), [data, year, q]);
  const all = useMemo(() => [1, 2, 3, 4].map((x) => vatQuarterData(data, year, x)), [data, year]);
  const range = `${AR_MONTHS[(q - 1) * 3]} – ${AR_MONTHS[(q - 1) * 3 + 2]} ${year}`;

  function downloadCsv() {
    const lines = [["رقم الفاتورة", "التاريخ", "العميل", "الإجمالي شامل الضريبة (ر.ع)", "المبلغ قبل الضريبة (ر.ع)", `الضريبة ${VAT_RATE}% (ر.ع)`]];
    d.invs.forEach((i) => {
      const g = invoiceComputed(i).grandTotal;
      lines.push([i.number, i.date, i.customerName || "", g.toFixed(3), (g - vatOf(g)).toFixed(3), vatOf(g).toFixed(3)]);
    });
    lines.push(["", "", "الإجمالي", d.gross.toFixed(3), d.net.toFixed(3), d.vat.toFixed(3)]);
    lines.push(["", "", "ضريبة المشتريات (تُخصم)", "", "", d.input.toFixed(3)]);
    lines.push(["", "", "صافي الضريبة المستحقة", "", "", d.due.toFixed(3)]);
    const csv = "﻿" + lines.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `vat-${year}-Q${q}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function printReturn() {
    const rows = d.invs.map((i) => {
      const g = invoiceComputed(i).grandTotal;
      return `<tr><td><bdi>#${i.number}</bdi></td><td><bdi>${i.date}</bdi></td><td>${escHtml(i.customerName || "—")}</td><td><bdi>${fmt(g)}</bdi></td><td><bdi>${fmt(vatOf(g))}</bdi></td></tr>`;
    }).join("");
    const monthRows = d.byMonth.map((m) => `<div class="totals-row"><span>${m.label} (${m.count} فاتورة)</span><span><bdi>${fmt(m.gross)} | ضريبة ${fmt(m.vat)}</bdi></span></div>`).join("");
    const html = `
      <div class="accent-bar"></div>
      <div class="sheet">
        <div class="print-head">
          <div class="head-col head-brand">
            <div class="print-brand">SILENT CODE</div>
            <div class="print-tagline">كشف ضريبة القيمة المضافة ${VAT_RATE}% — ${range}</div>
          </div>
          <div class="head-col head-meta"><div class="print-meta-line"><div>أصيل الفخامة ش.م.م — سجل تجاري 1648344</div></div></div>
        </div>
        <table class="items">
          <thead><tr><th>رقم الفاتورة</th><th>التاريخ</th><th>العميل</th><th>الإجمالي شامل الضريبة</th><th>الضريبة ${VAT_RATE}%</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="totals-wrap"><div class="totals">
          ${monthRows}
          <div class="totals-row"><span>المبيعات قبل الضريبة</span><span><bdi>${fmt(d.net)} ر.ع</bdi></span></div>
          <div class="totals-row"><span>إجمالي المبيعات شامل الضريبة</span><span><bdi>${fmt(d.gross)} ر.ع</bdi></span></div>
          <div class="totals-row"><span>ضريبة المبيعات ${VAT_RATE}%</span><span><bdi>${fmt(d.vat)} ر.ع</bdi></span></div>
          <div class="totals-row"><span>ضريبة المشتريات (تُخصم)</span><span><bdi>${fmt(d.input)} ر.ع</bdi></span></div>
          <div class="grand-total"><span>صافي الضريبة المستحقة</span><span><bdi>${fmt(d.due)} ر.ع</bdi></span></div>
        </div></div>
        <div class="foot"><div class="foot-note">الأسعار محسوبة شاملة الضريبة (الضريبة = المبلغ × ${VAT_RATE} ÷ ${100 + VAT_RATE}). كشف مستخرج من فواتير البيع، وضريبة المشتريات هي المبالغ اللي سجّلتها يدويًا بخانة «منها ضريبة 5%». يُراجع مع محاسب قبل أي تقديم رسمي.</div></div>
      </div>`;
    openPrintWindow("ar", html);
  }

  return (
    <div className="page">
      <PageHead
        eyebrow="المالية"
        title="الإقرار الضريبي (5%)"
        desc="كشف ربع سنوي بالضريبة المستخرجة من مبيعاتك (الأسعار محسوبة شاملة الضريبة). نفس الصافي ينخصم تلقائيًا من الربح في لوحة التحكم، عشان يكون محجوز لو انطلب منك. الفواتير الملغاة ما تدخل الكشف."
      />
      <div className="panel">
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select>
          {[1, 2, 3, 4].map((x) => (
            <button key={x} className={x === q ? "btn-primary" : "btn-ghost"} onClick={() => setQ(x)}>الربع {x}</button>
          ))}
          <span style={{ flex: 1 }} />
          <button className="btn-ghost" onClick={downloadCsv} disabled={!d.invs.length}>تنزيل Excel (CSV)</button>
          <button className="btn-primary" onClick={printReturn} disabled={!d.invs.length}><Printer size={15} /> طباعة / PDF</button>
        </div>
        <div className="kpi-row">
          <div className="kpi-card"><div className="kpi-label">مبيعات {range} (شامل الضريبة)</div><div className="kpi-value">{fmt(d.gross)} <span className="unit">ر.ع</span></div></div>
          <div className="kpi-card"><div className="kpi-label">المبيعات قبل الضريبة</div><div className="kpi-value">{fmt(d.net)} <span className="unit">ر.ع</span></div></div>
          <div className="kpi-card" style={{ "--accent": "#6B4C8C" }}><div className="kpi-label">ضريبة المبيعات {VAT_RATE}%</div><div className="kpi-value">{fmt(d.vat)} <span className="unit">ر.ع</span></div></div>
          <div className="kpi-card" style={{ "--accent": "#3D6B8C" }}><div className="kpi-label">ضريبة المشتريات (تُخصم)</div><div className="kpi-value">{fmt(d.input)} <span className="unit">ر.ع</span></div></div>
          <div className="kpi-card" style={{ "--accent": "#B3452F" }}><div className="kpi-label">صافي الضريبة المستحقة</div><div className="kpi-value">{fmt(d.due)} <span className="unit">ر.ع</span></div></div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>الأرباع الأربعة لسنة {year}</h3></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>الربع</th><th>الفواتير</th><th>المبيعات شامل الضريبة</th><th>ضريبة المبيعات</th><th>ضريبة المشتريات</th><th>الصافي المستحق</th></tr></thead>
            <tbody>
              {all.map((x) => (
                <tr key={x.q}><td>الربع {x.q} ({AR_MONTHS[(x.q - 1) * 3]} – {AR_MONTHS[(x.q - 1) * 3 + 2]})</td><td className="num">{x.invs.length}</td><td className="num">{fmt(x.gross)}</td><td className="num">{fmt(x.vat)}</td><td className="num">{fmt(x.input)}</td><td className="num"><strong>{fmt(x.due)}</strong></td></tr>
              ))}
              <tr style={{ fontWeight: 700 }}><td>السنة</td><td className="num">{all.reduce((s, x) => s + x.invs.length, 0)}</td><td className="num">{fmt(all.reduce((s, x) => s + x.gross, 0))}</td><td className="num">{fmt(all.reduce((s, x) => s + x.vat, 0))}</td><td className="num">{fmt(all.reduce((s, x) => s + x.input, 0))}</td><td className="num">{fmt(all.reduce((s, x) => s + x.due, 0))}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>فواتير {range}</h3><span className="panel-sub">كل شهر لحاله</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>الشهر</th><th>الفواتير</th><th>شامل الضريبة</th><th>قبل الضريبة</th><th>ضريبة المبيعات</th><th>ضريبة المشتريات</th></tr></thead>
            <tbody>
              {d.byMonth.map((m) => (
                <tr key={m.key}><td>{m.label}</td><td className="num">{m.count}</td><td className="num">{fmt(m.gross)}</td><td className="num">{fmt(m.net)}</td><td className="num"><strong>{fmt(m.vat)}</strong></td><td className="num">{fmt(m.input)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--ink-soft)" }}>كشف داخلي: ضريبة المبيعات من الفواتير، وضريبة المشتريات من المبالغ اللي تسجلها بخانة «منها ضريبة 5%» (مشتريات، مصروفات، تسويق، معدات). راجعه مع محاسب قبل أي تقديم رسمي.</p>
      </div>
    </div>
  );
}

function CustomersTab({ data, persist }) {
  const [openKey, setOpenKey] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [renaming, setRenaming] = useState(null); // { oldName, newName }
  const customers = useMemo(() => customerStats(data.invoices), [data.invoices]);

  function removeCustomer(c) {
    setConfirmState({
      message: `تأكيد حذف العميل "${c.name}"؟ هذا راح يحذف كل فواتيره (${c.count} فاتورة بإجمالي ${fmt(c.total)} ر.ع) نهائيًا ولا يرجع.`,
      onConfirm: () => {
        const ids = new Set(c.invoices.map((inv) => inv.id));
        persist({ ...data, invoices: data.invoices.filter((inv) => !ids.has(inv.id)) });
      },
    });
  }

  function saveRename() {
    if (!renaming || !renaming.newName.trim()) return;
    const newName = renaming.newName.trim();
    persist({
      ...data,
      invoices: data.invoices.map((inv) =>
        inv.customerName && inv.customerName.trim().toLowerCase() === renaming.oldName.toLowerCase()
          ? { ...inv, customerName: newName }
          : inv
      ),
    });
    setRenaming(null);
  }

  return (
    <div className="page">
      <PageHead eyebrow="المبيعات" title="العملاء" desc="كل عميل اشترى منكم، عدد مرات الشراء، وإجمالي المبيعات — يتحدث تلقائيًا من فواتير البيع" />

      {customers.length === 0 ? (
        <Empty icon={Users} title="ما فيه عملاء بعد" sub="أول ما تسجل فاتورة بيع باسم عميل، بيظهر هنا تلقائيًا." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>العميل</th><th>الهاتف</th><th>الإيميل</th><th>الدولة</th><th>عدد مرات الشراء</th><th>إجمالي المشتريات</th><th>آخر شراء</th><th></th></tr></thead>
            <tbody>
              {customers.map((c) => {
                const key = c.name.toLowerCase();
                const open = openKey === key;
                return (
                  <React.Fragment key={key}>
                    <tr>
                      <td className="strong">{c.name}</td>
                      <td>{c.phone || "—"}</td>
                      <td>{c.email ? <bdi>{c.email}</bdi> : "—"}</td>
                      <td>{GCC_NAMES[c.country] || c.country || "—"}</td>
                      <td className="num">{c.count}</td>
                      <td className="num">{fmt(c.total)} ر.ع</td>
                      <td>{c.lastDate}</td>
                      <td>
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <button className="link-btn" onClick={() => setOpenKey(open ? null : key)}>
                            <ChevronLeft size={13} className={`chev ${open ? "open" : ""}`} /> {open ? "إخفاء" : "السجل"}
                          </button>
                          <button className="icon-btn" onClick={() => setRenaming({ oldName: c.name, newName: c.name })}><Pencil size={13} /></button>
                          <button className="icon-btn danger" onClick={() => removeCustomer(c)}><Trash2 size={13} /></button>
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={8}>
                          <div className="mini-list">
                            <div className="mini-list-title">سجل مشتريات {c.name}</div>
                            {[...c.invoices].sort((a, b) => (a.date < b.date ? 1 : -1)).map((inv) => {
                              const invTotal = invoiceComputed(inv).grandTotal;
                              return (
                                <div className="mini-list-row" key={inv.id}>
                                  <span>فاتورة #{inv.number} — {inv.date}</span>
                                  <span className="num">{fmt(invTotal)} ر.ع</span>
                                </div>
                              );
                            })}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {renaming && (
        <div className="modal-overlay" onClick={() => setRenaming(null)}>
          <div className="modal" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>تعديل اسم العميل</h3><button className="icon-btn" onClick={() => setRenaming(null)}><X size={18} /></button></div>
            <div className="modal-body">
              <Field label="الاسم الجديد" hint="يتحدث بكل الفواتير القديمة لهذا العميل تلقائيًا">
                <input value={renaming.newName} onChange={(e) => setRenaming({ ...renaming, newName: e.target.value })} autoFocus />
              </Field>
            </div>
            <div className="modal-foot">
              <button className="btn-ghost" onClick={() => setRenaming(null)}>إلغاء</button>
              <button className="btn-primary" disabled={!renaming.newName.trim()} onClick={saveRename}>حفظ</button>
            </div>
          </div>
        </div>
      )}
      <ConfirmModal state={confirmState} onCancel={() => setConfirmState(null)} />
    </div>
  );
}

/* ============================== marketing ============================== */

function emptyMarketing() { return { id: uid("mkt"), date: todayStr(), type: "campaign", title: "", cost: "", productId: "", qty: "", paidFrom: "sohar", vat: "" }; }

function MarketingTab({ data, persist, currentUser }) {
  const [form, setForm] = useState(emptyMarketing());
  function set(field, val) {
    const next = { ...form, [field]: val };
    if (field === "type" && val === "campaign") next.qty = "";
    if (field === "type" && val === "sample") { next.paidFrom = ""; next.vat = ""; }
    if ((field === "productId" || field === "qty") && next.type === "sample") {
      const ref = productReferenceCost(data, next.productId);
      if (next.productId && next.qty) next.cost = (ref.unitCost * Number(next.qty)).toFixed(3);
    }
    setForm(next);
  }
  function add() {
    if (!form.title.trim() || !form.cost) return;
    if (isLocked(data, form.date)) { alert(lockMsg(data)); return; }
    persist({ ...data, marketing: [...data.marketing, { ...form, title: form.title.trim(), createdBy: currentUser?.name }] });
    setForm(emptyMarketing());
  }
  function remove(id) {
    const m = data.marketing.find((x) => x.id === id);
    if (m && isLocked(data, m.date)) { alert(lockMsg(data)); return; }
    persist({ ...data, marketing: data.marketing.filter((m2) => m2.id !== id) });
  }

  const totalCampaigns = data.marketing.filter((m) => m.type === "campaign").reduce((s, m) => s + (Number(m.cost) || 0), 0);
  const totalSamples = data.marketing.filter((m) => m.type === "sample").reduce((s, m) => s + (Number(m.cost) || 0), 0);

  return (
    <div className="page">
      <PageHead eyebrow="التسويق" title="التسويق والسامبلات" desc="سجل حملات التسويق والعينات المجانية، وربطها بمنتج معين يعطيك نسبة تسويق دقيقة لكل منتج" />

      <div className="kpi-row">
        <div className="kpi-card" style={{ "--accent": "#3D6B8C" }}><Megaphone size={16} className="kpi-icon" /><div className="kpi-label">إجمالي الحملات</div><div className="kpi-value">{fmt(totalCampaigns)} <span className="unit">ر.ع</span></div></div>
        <div className="kpi-card" style={{ "--accent": "#8C6B3D" }}><Sparkles size={16} className="kpi-icon" /><div className="kpi-label">إجمالي تكلفة السامبلات</div><div className="kpi-value">{fmt(totalSamples)} <span className="unit">ر.ع</span></div></div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>إضافة عنصر تسويقي</h3></div>
        <div className="form-row four">
          <Field label="النوع">
            <select value={form.type} onChange={(e) => set("type", e.target.value)}>
              <option value="campaign">حملة تسويقية</option>
              <option value="sample">سامبل / عينة مجانية</option>
            </select>
          </Field>
          <Field label="العنوان / الوصف"><input value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="مثال: إعلان انستقرام" /></Field>
          <Field label="المنتج (اختياري إن كانت حملة عامة)">
            <select value={form.productId} onChange={(e) => set("productId", e.target.value)}>
              <option value="">عام - كل المنتجات</option>
              {data.products.map((p) => <option key={p.id} value={p.id}>{productLabel(p)}</option>)}
            </select>
          </Field>
          {form.type === "sample" && <Field label="عدد السامبلات"><input type="number" value={form.qty} onChange={(e) => set("qty", e.target.value)} /></Field>}
          <Field label="التكلفة (ر.ع)" hint={form.type === "sample" ? "تُحسب تلقائيًا من تكلفة المنتج، تقدر تعدلها" : ""}>
            <input type="number" value={form.cost} onChange={(e) => set("cost", e.target.value)} />
          </Field>
          <Field label="التاريخ"><input type="date" value={form.date} onChange={(e) => set("date", e.target.value)} /></Field>
          {form.type === "campaign" && <PaidFromField value={form.paidFrom} onChange={(v) => set("paidFrom", v)} />}
          {form.type === "campaign" && <VatPaidField value={form.vat} onChange={(v) => set("vat", v)} />}
        </div>
        <button className="btn-primary" onClick={add} disabled={!form.title.trim() || !form.cost}><Plus size={16} /> إضافة</button>
      </div>

      {data.marketing.length === 0 ? (
        <Empty icon={Megaphone} title="ما فيه مصاريف تسويق مسجلة" sub="أضف أول حملة أو سامبل من الفورم فوق." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>التاريخ</th><th>النوع</th><th>الوصف</th><th>المنتج</th><th>الكمية</th><th>التكلفة</th><th>بواسطة</th><th></th></tr></thead>
            <tbody>
              {[...data.marketing].reverse().map((m) => {
                const prod = data.products.find((p) => p.id === m.productId);
                return (
                  <tr key={m.id}>
                    <td>{m.date}</td>
                    <td><span className={`badge ${m.type === "sample" ? "amber" : "blue"}`}>{m.type === "sample" ? "سامبل" : "حملة"}</span></td>
                    <td>{m.title}</td>
                    <td>{prod ? prod.name : "عام"}</td>
                    <td className="num">{m.qty || "—"}</td>
                    <td className="num">{fmt(m.cost)} ر.ع{m.paidFrom ? <div className="panel-sub">من {accName(m.paidFrom)}</div> : null}</td>
                    <td>{m.createdBy && <span className="badge green">{m.createdBy}</span>}</td>
                    <td><button className="icon-btn danger" onClick={() => remove(m.id)}><Trash2 size={14} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ============================== losses ============================== */

function emptyLoss() { return { id: uid("loss"), date: todayStr(), productId: "", qty: "", costTotal: "", note: "" }; }

/* ---- المخزون الجاهز للبيع (بعد الإنتاج) — هو الرقم اللي يتربط بالموقع ---- */
function WebLinkPanel({ data, persist }) {
  const [web, setWeb] = useState(null);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState({});
  const [saved, setSaved] = useState(false);
  const map = data.settings.webProductMap || {};
  const rev = {};
  Object.entries(map).forEach(([w, a]) => { rev[a] = w; });

  async function load() {
    setErr("");
    try {
      const r = await listWebProducts();
      const list = r.products || [];
      setWeb(list);
      const init = {};
      data.products.forEach((p) => { init[p.id] = rev[p.id] || ""; });
      setSel(init);
    } catch (e) { setErr("تعذر تحميل منتجات الموقع."); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  function useSuggestions() {
    const next = { ...sel };
    data.products.forEach((p) => { if (!next[p.id]) next[p.id] = suggestWebProduct(p, web) || ""; });
    setSel(next);
  }
  const used = {};
  Object.entries(sel).forEach(([a, w]) => { if (w) used[w] = (used[w] || 0) + 1; });
  const dup = Object.values(used).some((n) => n > 1);
  async function save() {
    if (dup) return;
    const nextMap = {};
    Object.entries(sel).forEach(([a, w]) => { if (w) nextMap[w] = a; });
    // نحافظ على روابط منتجات ما تظهر بالقائمة الحالية (مثلاً منتج انحذف من الموقع) — لا؛ نحتفظ بس بالصالحة
    await persist({ ...data, settings: { ...data.settings, webProductMap: nextMap } });
    setSaved(true); setTimeout(() => setSaved(false), 2500);
  }
  const changed = data.products.some((p) => (sel[p.id] || "") !== (rev[p.id] || ""));

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="panel-head"><h3>ربط المنتجات بالموقع</h3><span className="panel-sub">اربط كل منتج مرة وحدة. بعدها كل طلباته تدخل فواتير تلقائيًا، ومخزونه يتحدّث بالموقع. ما يتم أي ربط بالتخمين.</span></div>
      {err && <div className="alert-banner" style={{ marginBottom: 10 }}><AlertCircle size={15} /> {err}</div>}
      {!web && !err && <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-soft)" }}>جاري تحميل منتجات الموقع...</p>}
      {web && (
        <>
          <div className="mini-list">
            {data.products.map((p) => {
              const sug = !sel[p.id] ? suggestWebProduct(p, web) : "";
              return (
                <div className="mini-list-row" key={p.id} style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ flex: 1, minWidth: 140 }}><strong>{p.name}</strong> <span className="row-sub">{p.code}</span></span>
                  <select value={sel[p.id] || ""} onChange={(e) => setSel({ ...sel, [p.id]: e.target.value })} style={{ minWidth: 200, maxWidth: "100%" }}>
                    <option value="">— غير مربوط —</option>
                    {web.map((w) => <option key={w.id} value={w.id}>{w.code ? `${w.code} — ` : ""}{w.name_ar || w.name_en}{w.name_en && w.name_ar ? ` (${w.name_en})` : ""}</option>)}
                  </select>
                  {sug && <button className="btn-ghost" onClick={() => setSel({ ...sel, [p.id]: sug })}>اقتراح: {(web.find((w) => w.id === sug) || {}).name_ar || sug}</button>}
                </div>
              );
            })}
          </div>
          {dup && <div className="alert-banner" style={{ margin: "10px 0" }}><AlertCircle size={15} /> منتجين بالبرنامج مربوطين بنفس منتج الموقع — غيّر واحد منهم.</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button className="btn-ghost" onClick={useSuggestions}>املأ الاقتراحات للفاضي</button>
            <button className="btn-primary" disabled={dup || !changed} onClick={save}>حفظ الربط</button>
            {saved && <span className="badge green">تم الحفظ ✅</span>}
          </div>
        </>
      )}
    </div>
  );
}

function FinishedStockTab({ data, persist, currentUser, webState, onPush }) {
  const LOW = 5;
  const [form, setForm] = useState({ productId: "", dir: "add", qty: "", note: "", date: todayStr() });
  const [err, setErr] = useState("");
  const [pushing, setPushing] = useState(false);
  const mapped = new Set(Object.values(data.settings.webProductMap || {}));

  const rows = data.products.map((p) => {
    const produced = producedQty(data, p.id);
    const adj = adjustedQty(data, p.id);
    const sold = soldQtyExcludingInvoice(data, p.id, null);
    const samples = sampledQty(data, p.id);
    const lost = lostQty(data, p.id);
    const avail = produced + adj - sold - samples - lost;
    const linked = mapped.has(p.id);
    const tracked = isStockTracked(data, p.id);
    return { p, produced, adj, sold, samples, lost, avail, shown: Math.max(0, Math.floor(avail)), linked, tracked };
  });
  const totalAvail = rows.reduce((s, r) => s + Math.max(0, r.avail), 0);
  const lowCount = rows.filter((r) => r.avail <= LOW).length;

  function addAdjustment() {
    setErr("");
    const q = Number(form.qty);
    if (!form.productId) return setErr("اختر المنتج.");
    if (!(q > 0) || !Number.isFinite(q)) return setErr("اكتب كمية أكبر من صفر.");
    if (!form.note.trim()) return setErr("اكتب سبب التسوية (مثلًا: جرد فعلي، مخزون افتتاحي).");
    const signed = form.dir === "sub" ? -q : q;
    const row = rows.find((r) => r.p.id === form.productId);
    if (row && row.avail + signed < 0) return setErr(`النقص أكبر من المتاح (${row.avail}).`);
    persist({ ...data, stockAdjustments: [...(data.stockAdjustments || []), { id: uid("adj"), date: form.date, productId: form.productId, qty: signed, note: form.note.trim(), createdBy: currentUser?.name }] });
    setForm({ productId: "", dir: "add", qty: "", note: "", date: todayStr() });
  }
  function removeAdjustment(id) { persist({ ...data, stockAdjustments: (data.stockAdjustments || []).filter((a) => a.id !== id) }); }
  async function pushNow() { setPushing(true); try { await onPush(); } finally { setPushing(false); } }

  const adjustments = [...(data.stockAdjustments || [])].reverse();
  const n0 = (v) => String(Math.round(v * 1000) / 1000);

  return (
    <div className="page">
      <PageHead
        eyebrow="التصنيع"
        title="المخزون الجاهز للبيع"
        desc="العبوات الجاهزة بعد الإنتاج. هذا الرقم (المتاح) هو اللي يظهر في الموقع: ما فيه عميل يقدر يطلب أكثر منه. يزيد بدفعات الإنتاج، وينقص بالمبيعات (ومنها طلبات الموقع) والسامبلات والخسائر."
        action={<button className="btn-ghost" onClick={pushNow} disabled={pushing}><RefreshCw size={15} /> تحديث مخزون الموقع الآن</button>}
      />
      {webState.stockError && <div className="alert-banner" style={{ marginBottom: 12 }}><AlertCircle size={15} /> {webState.stockError}</div>}
      <div className="kpi-row">
        <div className="kpi-card"><PackageCheck size={16} className="kpi-icon" /><div className="kpi-label">إجمالي العبوات المتاحة</div><div className="kpi-value">{n0(totalAvail)} <span className="unit">عبوة</span></div></div>
        <div className="kpi-card" style={{ "--accent": "var(--danger)" }}><AlertTriangle size={16} className="kpi-icon" /><div className="kpi-label">منتجات قليلة أو منتهية (≤ {LOW})</div><div className="kpi-value">{lowCount}</div></div>
        <div className="kpi-card"><Globe size={16} className="kpi-icon" /><div className="kpi-label">آخر تحديث لمخزون الموقع</div><div className="kpi-value" style={{ fontSize: 16 }}>{webState.stockSyncedAt ? webState.stockSyncedAt.toLocaleTimeString("ar-OM") : "—"}</div></div>
      </div>

      {data.products.length === 0 ? (
        <Empty icon={Package} title="أضف منتج أولاً" sub="لازم يكون فيه منتج مسجل عشان يظهر مخزونه الجاهز." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>المنتج</th><th>المنتَج</th><th>تسويات</th><th>المبيعات</th><th>سامبلات</th><th>خسائر</th><th>المتاح للبيع</th><th>الموقع</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.p.id}>
                  <td><strong>{r.p.name}</strong><div className="row-sub">{r.p.code}</div></td>
                  <td className="num">{n0(r.produced)}</td>
                  <td className="num">{r.adj ? (r.adj > 0 ? "+" : "") + n0(r.adj) : "—"}</td>
                  <td className="num">{n0(r.sold)}</td>
                  <td className="num">{n0(r.samples)}</td>
                  <td className="num">{n0(r.lost)}</td>
                  <td className={`num ${r.avail <= 0 ? "neg" : ""}`}><strong>{n0(r.avail)}</strong>{r.avail > 0 && r.avail <= LOW ? <div><span className="badge amber">قليل</span></div> : r.avail <= 0 ? <div><span className="badge">نفذ</span></div> : null}</td>
                  <td>{!r.tracked ? <span className="badge amber" title="سجّل دفعة إنتاج أو تسوية جرد ليبدأ تتبّع مخزونه وإرساله للموقع">غير متتبَّع — مخزون الموقع كما هو</span> : r.linked ? <span className="badge green">يظهر {r.shown}</span> : <span className="badge amber" title="اربطه من لوحة «ربط المنتجات بالموقع» تحت">غير مربوط</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.products.length > 0 && <WebLinkPanel data={data} persist={persist} />}

      {data.products.length > 0 && (
        <div className="panel" style={{ marginTop: 14 }}>
          <div className="panel-head"><h3>تسوية الجرد</h3><span className="panel-sub">لو عدّيت المخزون فعليًا ولقيت فرق، أو عندك عبوات جاهزة قديمة من قبل البرنامج</span></div>
          <div className="form-row four">
            <Field label="المنتج">
              <select value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })}>
                <option value="">اختر منتج</option>
                {data.products.map((p) => <option key={p.id} value={p.id}>{productLabel(p)}</option>)}
              </select>
            </Field>
            <Field label="نوع التسوية">
              <select value={form.dir} onChange={(e) => setForm({ ...form, dir: e.target.value })}>
                <option value="add">زيادة (أضف عبوات)</option>
                <option value="sub">نقص (اخصم عبوات)</option>
              </select>
            </Field>
            <Field label="الكمية"><input type="number" min="1" step="1" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} /></Field>
            <Field label="التاريخ"><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
          </div>
          <Field label="السبب (إجباري)"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="مثال: جرد فعلي بالمخزن، مخزون افتتاحي" /></Field>
          {err && <div className="alert-banner" style={{ marginBottom: 10 }}><AlertCircle size={15} /> {err}</div>}
          <button className="btn-primary" onClick={addAdjustment}><Plus size={16} /> تسجيل التسوية</button>
        </div>
      )}

      {adjustments.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>التاريخ</th><th>المنتج</th><th>الكمية</th><th>السبب</th><th>بواسطة</th><th></th></tr></thead>
            <tbody>
              {adjustments.map((a) => {
                const prod = data.products.find((p) => p.id === a.productId);
                return (
                  <tr key={a.id}>
                    <td>{a.date}</td><td>{prod?.name || "—"}</td>
                    <td className={`num ${a.qty < 0 ? "neg" : ""}`}>{a.qty > 0 ? "+" : ""}{a.qty}</td>
                    <td>{a.note}</td>
                    <td>{a.createdBy && <span className="badge green">{a.createdBy}</span>}</td>
                    <td><button className="icon-btn danger" onClick={() => removeAdjustment(a.id)}><Trash2 size={14} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LossesTab({ data, persist, currentUser }) {
  const [form, setForm] = useState(emptyLoss());
  function set(field, val) {
    const next = { ...form, [field]: val };
    if (field === "productId" || field === "qty") {
      const ref = productReferenceCost(data, next.productId);
      if (next.productId && next.qty) next.costTotal = (ref.unitCost * Number(next.qty)).toFixed(3);
    }
    setForm(next);
  }
  function add() {
    if (!form.productId || !form.costTotal) return;
    persist({ ...data, losses: [...data.losses, { ...form, createdBy: currentUser?.name }] });
    setForm(emptyLoss());
  }
  function remove(id) { persist({ ...data, losses: data.losses.filter((l) => l.id !== id) }); }
  const total = data.losses.reduce((s, l) => s + (Number(l.costTotal) || 0), 0);

  return (
    <div className="page">
      <PageHead eyebrow="التصنيع" title="خسائر التصنيع" desc="أي فاقد أو تلف غير طبيعي يصير وقت التصنيع أو التغليف" />
      <div className="kpi-row">
        <div className="kpi-card" style={{ "--accent": "var(--danger)" }}><PackageX size={16} className="kpi-icon" /><div className="kpi-label">إجمالي قيمة الخسائر</div><div className="kpi-value">{fmt(total)} <span className="unit">ر.ع</span></div></div>
      </div>

      {data.products.length === 0 ? (
        <Empty icon={Package} title="أضف منتج أولاً" sub="لازم يكون فيه منتج مسجل عشان تربط الخسارة فيه." />
      ) : (
        <div className="panel">
          <div className="panel-head"><h3>تسجيل خسارة</h3></div>
          <div className="form-row four">
            <Field label="المنتج">
              <select value={form.productId} onChange={(e) => set("productId", e.target.value)}>
                <option value="">اختر منتج</option>
                {data.products.map((p) => <option key={p.id} value={p.id}>{productLabel(p)}</option>)}
              </select>
            </Field>
            <Field label="الكمية التالفة"><input type="number" value={form.qty} onChange={(e) => set("qty", e.target.value)} /></Field>
            <Field label="القيمة الإجمالية (ر.ع)" hint="تُحسب تلقائيًا، تقدر تعدلها"><input type="number" value={form.costTotal} onChange={(e) => set("costTotal", e.target.value)} /></Field>
            <Field label="التاريخ"><input type="date" value={form.date} onChange={(e) => set("date", e.target.value)} /></Field>
          </div>
          <Field label="السبب / ملاحظات"><input value={form.note} onChange={(e) => set("note", e.target.value)} placeholder="مثال: خطأ بالتعبئة" /></Field>
          <button className="btn-primary" onClick={add} disabled={!form.productId || !form.costTotal}><Plus size={16} /> تسجيل الخسارة</button>
        </div>
      )}

      {data.losses.length === 0 ? (
        <Empty icon={AlertTriangle} title="ما فيه خسائر مسجلة" sub="زين! سجل أي خسارة تصير هنا عشان تتابعها." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>التاريخ</th><th>المنتج</th><th>الكمية</th><th>القيمة</th><th>السبب</th><th>بواسطة</th><th></th></tr></thead>
            <tbody>
              {[...data.losses].reverse().map((l) => {
                const prod = data.products.find((p) => p.id === l.productId);
                return (
                  <tr key={l.id}>
                    <td>{l.date}</td><td>{prod?.name || "—"}</td><td className="num">{l.qty}</td>
                    <td className="num neg">{fmt(l.costTotal)} ر.ع</td><td>{l.note}</td>
                    <td>{l.createdBy && <span className="badge green">{l.createdBy}</span>}</td>
                    <td><button className="icon-btn danger" onClick={() => remove(l.id)}><Trash2 size={14} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ============================== equipment ============================== */

function emptyEquipment() { return { id: uid("equip"), code: "", date: todayStr(), title: "", qty: 1, cost: "", note: "", paidFrom: "sohar", vat: "", lifeMonths: "" }; }

function EquipmentTab({ data, persist, currentUser }) {
  const [form, setForm] = useState({ ...emptyEquipment(), code: nextCode(data.equipment, "EQ-") });
  const [editingId, setEditingId] = useState(null);
  const [confirmState, setConfirmState] = useState(null);

  function save() {
    if (!form.title.trim() || !form.cost) return;
    if (isLocked(data, form.date)) { alert(lockMsg(data)); return; }
    if (editingId) {
      persist({ ...data, equipment: data.equipment.map((e) => (e.id === editingId ? { ...form, title: form.title.trim() } : e)) });
      setForm({ ...emptyEquipment(), code: nextCode(data.equipment, "EQ-") });
      setEditingId(null);
    } else {
      const newItem = { ...form, code: form.code || nextCode(data.equipment, "EQ-"), title: form.title.trim(), createdBy: currentUser?.name };
      const nextEquipment = [...data.equipment, newItem];
      persist({ ...data, equipment: nextEquipment });
      setForm({ ...emptyEquipment(), code: nextCode(nextEquipment, "EQ-") });
    }
  }
  function startEdit(e) { setForm(e); setEditingId(e.id); }
  function cancelEdit() { setForm({ ...emptyEquipment(), code: nextCode(data.equipment, "EQ-") }); setEditingId(null); }
  function remove(id) {
    const eq = data.equipment.find((x) => x.id === id);
    if (eq && isLocked(data, eq.date)) { alert(lockMsg(data)); return; }
    setConfirmState({
      message: "تأكيد حذف هذا العنصر؟",
      onConfirm: () => persist({ ...data, equipment: data.equipment.filter((e) => e.id !== id) }),
    });
  }

  const totalAssets = data.equipment.reduce((s, e) => s + (Number(e.cost) || 0), 0);

  return (
    <div className="page">
      <PageHead
        eyebrow="التشغيل"
        title="المعدات والأصول الثابتة"
        desc="أدوات ومعدات تُعاد استخدامها باستمرار (قوارير خلط، موازين، مكائن...) — استثمار منفصل تمامًا عن تكلفة الوحدة، يُسترد تدريجيًا من الأرباح زي التأسيس بالضبط"
      />

      <div className="alert-banner" style={{ background: "#E7EEF3", color: "#3D6B8C", borderColor: "#C9D9E5" }}>
        <AlertCircle size={16} />
        <span>
          تنبيه مهم: هذا القسم للأدوات المُعاد استخدامها فقط (ما تُستهلك). أما المستلزمات الاستهلاكية المرتبطة بالتصنيع فعلاً (كمامات، قفازات، مناديل تنظيف...) — سجّلها كمادة بتبويب «المخزون والمواد»، وضيفها كسطر بوصفة المنتج، عشان تنعكس فعليًا على تكلفة تصنيع الوحدة وتكلفة البضاعة المباعة (بالضبط زي كحول التنظيف).
        </span>
      </div>

      <div className="kpi-row">
        <div className="kpi-card" style={{ "--accent": "#3D6B8C" }}>
          <Wrench size={16} className="kpi-icon" />
          <div className="kpi-label">إجمالي المعدات والأصول</div>
          <div className="kpi-value">{fmt(totalAssets)} <span className="unit">ر.ع</span></div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>{editingId ? "تعديل معدة / أصل ثابت" : "إضافة معدة / أصل ثابت"}</h3></div>
        <div className="form-row four">
          <Field label="الرقم المرجعي"><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="مثال: EQ-001" /></Field>
          <Field label="اسم العنصر"><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="مثال: قوارير خلط ستانلس" /></Field>
          <Field label="الكمية"><input type="number" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} /></Field>
          <Field label="التكلفة الإجمالية (ر.ع)"><input type="number" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></Field>
          <Field label="التاريخ"><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
        </div>
        <div className="form-row four">
          <PaidFromField value={form.paidFrom} onChange={(v) => setForm({ ...form, paidFrom: v })} />
          <VatPaidField value={form.vat} onChange={(v) => setForm({ ...form, vat: v })} />
        </div>
        <Field label="ملاحظات (اختياري)"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-primary" onClick={save} disabled={!form.title.trim() || !form.cost}>
            {editingId ? "حفظ التعديل" : <><Plus size={16} /> إضافة</>}
          </button>
          {editingId && <button className="btn-ghost" onClick={cancelEdit}>إلغاء</button>}
        </div>
      </div>

      {data.equipment.length === 0 ? (
        <Empty icon={Wrench} title="ما فيه معدات مسجلة" sub="أضف أول معدة أو أداة من الفورم فوق." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>الرقم المرجعي</th><th>التاريخ</th><th>العنصر</th><th>الكمية</th><th>التكلفة</th><th>ملاحظات</th><th>بواسطة</th><th></th></tr></thead>
            <tbody>
              {[...data.equipment].reverse().map((e) => (
                <tr key={e.id}>
                  <td><span className="badge blue">{e.code || "—"}</span></td>
                  <td>{e.date}</td>
                  <td className="strong">{e.title}</td>
                  <td className="num">{e.qty || "—"}</td>
                  <td className="num">{fmt(e.cost)} ر.ع{e.paidFrom ? <div className="panel-sub">من {accName(e.paidFrom)}</div> : null}</td>
                  <td>{e.note}</td>
                  <td>{e.createdBy && <span className="badge green">{e.createdBy}</span>}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="icon-btn" onClick={() => startEdit(e)}><Pencil size={13} /></button>
                      <button className="icon-btn danger" onClick={() => remove(e.id)}><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmModal state={confirmState} onCancel={() => setConfirmState(null)} />
    </div>
  );
}

/* ============================== branding ============================== */

function emptyBranding() { return { id: uid("brand"), date: todayStr(), title: "", cost: "", note: "", paidFrom: "sohar", vat: "" }; }

function BrandingTab({ data, persist, currentUser }) {
  const [form, setForm] = useState(emptyBranding());
  const [editingId, setEditingId] = useState(null);
  function save() {
    if (!form.title.trim() || !form.cost) return;
    if (isLocked(data, form.date)) { alert(lockMsg(data)); return; }
    if (editingId) {
      persist({ ...data, branding: data.branding.map((b) => (b.id === editingId ? { ...form, title: form.title.trim() } : b)) });
    } else {
      persist({ ...data, branding: [...data.branding, { ...form, title: form.title.trim(), createdBy: currentUser?.name }] });
    }
    setForm(emptyBranding());
    setEditingId(null);
  }
  function startEdit(b) { setForm(b); setEditingId(b.id); }
  function cancelEdit() { setForm(emptyBranding()); setEditingId(null); }
  function remove(id) {
    const b = data.branding.find((x) => x.id === id);
    if (b && isLocked(data, b.date)) { alert(lockMsg(data)); return; }
    persist({ ...data, branding: data.branding.filter((x) => x.id !== id) });
  }
  const total = data.branding.reduce((s, b) => s + (Number(b.cost) || 0), 0);

  return (
    <div className="page">
      <PageHead eyebrow="التأسيس" title="تكاليف التأسيس والبراند" desc="شعار، تصميم، ترخيص، اسم تجاري... تكاليف مرة وحدة منفصلة تمامًا عن تكلفة المنتج، تُسترد تدريجيًا من الأرباح" />
      <div className="kpi-row">
        <div className="kpi-card" style={{ "--accent": "#6B4C8C" }}><Building2 size={16} className="kpi-icon" /><div className="kpi-label">إجمالي استثمار التأسيس</div><div className="kpi-value">{fmt(total)} <span className="unit">ر.ع</span></div></div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>{editingId ? "تعديل مصروف تأسيسي" : "إضافة مصروف تأسيسي"}</h3></div>
        <div className="form-row four">
          <Field label="البند"><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="مثال: تصميم الشعار" /></Field>
          <Field label="التكلفة (ر.ع)"><input type="number" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></Field>
          <Field label="التاريخ"><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
          <Field label="ملاحظات"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
          <PaidFromField value={form.paidFrom} onChange={(v) => setForm({ ...form, paidFrom: v })} />
          <VatPaidField value={form.vat} onChange={(v) => setForm({ ...form, vat: v })} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-primary" onClick={save} disabled={!form.title.trim() || !form.cost}>
            {editingId ? "حفظ التعديل" : <><Plus size={16} /> إضافة</>}
          </button>
          {editingId && <button className="btn-ghost" onClick={cancelEdit}>إلغاء</button>}
        </div>
      </div>

      {data.branding.length === 0 ? (
        <Empty icon={Building2} title="ما فيه مصاريف تأسيس مسجلة" sub="أضف أول بند من الفورم فوق." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>التاريخ</th><th>البند</th><th>التكلفة</th><th>ملاحظات</th><th>بواسطة</th><th></th></tr></thead>
            <tbody>
              {[...data.branding].reverse().map((b) => (
                <tr key={b.id}>
                  <td>{b.date}</td><td className="strong">{b.title}</td><td className="num">{fmt(b.cost)} ر.ع{b.paidFrom ? <div className="panel-sub">من {accName(b.paidFrom)}</div> : null}</td><td>{b.note}</td>
                  <td>{b.createdBy && <span className="badge green">{b.createdBy}</span>}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="icon-btn" onClick={() => startEdit(b)}><Pencil size={13} /></button>
                      <button className="icon-btn danger" onClick={() => remove(b.id)}><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ============================== settings ============================== */

function SettingsTab({ data, persist, currentUser }) {
  const s = data.settings;
  const fileInputRef = useRef(null);
  const [importMsg, setImportMsg] = useState("");
  const [confirmState, setConfirmState] = useState(null);
  const [backupDates, setBackupDates] = useState(null); // null = loading
  const [restoreMsg, setRestoreMsg] = useState("");
  const [lockInput, setLockInput] = useState((data.settings && data.settings.lockedUntil) || "");
  function setSettings(next) { persist({ ...data, settings: next }); }

  useEffect(() => {
    listBackupDates().then(setBackupDates).catch(() => setBackupDates([]));
  }, []);

  function restoreFromAutoBackup(dateStr) {
    setConfirmState({
      message: `استعادة نسخة ${dateStr} راح تستبدل كل بياناتك الحالية بهالنسخة. متأكد؟`,
      onConfirm: async () => {
        setRestoreMsg("جاري الاستعادة...");
        try {
          const restored = await loadBackup(dateStr);
          await persist({ ...restored, auditLog: [...(restored.auditLog || []), { id: uid("au"), at: new Date().toISOString(), by: currentUser?.name, kind: "restore", area: "استعادة نسخة", ref: dateStr }] }, { replace: true });
          setRestoreMsg(`تمت الاستعادة من نسخة ${dateStr} بنجاح ✅`);
        } catch {
          setRestoreMsg("صار خطأ أثناء الاستعادة، حاول مرة ثانية.");
        }
      },
    });
  }

  function addMethod() { setSettings({ ...s, paymentMethods: [...s.paymentMethods, "طريقة جديدة"] }); }
  function editMethod(i, val) { const arr = [...s.paymentMethods]; arr[i] = val; setSettings({ ...s, paymentMethods: arr }); }
  function removeMethod(i) { setSettings({ ...s, paymentMethods: s.paymentMethods.filter((_, idx) => idx !== i) }); }

  function addPartner() { setSettings({ ...s, partners: [...s.partners, { id: uid("partner"), name: "شريك جديد", percent: 0, email: "" }] }); }
  function editPartner(id, field, val) {
    setSettings({ ...s, partners: s.partners.map((p) => (p.id === id ? { ...p, [field]: val } : p)) });
  }
  function removePartner(id) { setSettings({ ...s, partners: s.partners.filter((p) => p.id !== id) }); }

  const partnersSum = s.partners.reduce((sum, p) => sum + (Number(p.percent) || 0), 0);
  const biz = s.businessInfo || { phone: "", address: "", instagram: "", note: "" };
  function setBiz(field, val) { setSettings({ ...s, businessInfo: { ...biz, [field]: val } }); }

  function exportBackup() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `silent-code-backup-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function triggerImport() { fileInputRef.current?.click(); }

  function handleImportFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        if (!parsed || !parsed.materials || !parsed.products) {
          setImportMsg("الملف مو نسخة احتياطية صحيحة من هذا البرنامج.");
          return;
        }
        setConfirmState({
          message: "استعادة هذي النسخة راح تستبدل كل البيانات الحالية بالكامل. متأكد؟",
          onConfirm: () => { persist({ ...defaultAppData(), ...parsed, auditLog: [...(parsed.auditLog || []), { id: uid("au"), at: new Date().toISOString(), by: currentUser?.name, kind: "restore", area: "استعادة ملف", ref: "JSON" }] }, { replace: true }); setImportMsg("تمت الاستعادة بنجاح ✅"); },
        });
      } catch {
        setImportMsg("ما قدرنا نقرأ الملف، تأكد إنه ملف JSON صحيح.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  return (
    <div className="page">
      <PageHead eyebrow="الإعدادات" title="إعدادات البرنامج" desc="طرق الدفع، الشراكة، وتوزيع الأرباح" />

      <div className="panel">
        <div className="panel-head"><h3>معلومات البراند بالفاتورة</h3><span className="panel-sub">تظهر تلقائيًا بأعلى كل فاتورة مطبوعة تروح للعميل</span></div>
        <div className="form-row four">
          <Field label="رقم الهاتف / واتساب"><input value={biz.phone} onChange={(e) => setBiz("phone", e.target.value)} placeholder="+968 9xxxxxxx" /></Field>
          <Field label="العنوان / الموقع"><input value={biz.address} onChange={(e) => setBiz("address", e.target.value)} placeholder="مسقط، عمان" /></Field>
          <Field label="إنستقرام (اختياري)"><input value={biz.instagram} onChange={(e) => setBiz("instagram", e.target.value)} placeholder="@silentcode.om" /></Field>
        </div>
        <Field label="ملاحظة أسفل الفاتورة (اختياري)"><input value={biz.note} onChange={(e) => setBiz("note", e.target.value)} placeholder="مثال: منتجاتنا يدوية 100%، الرد خلال 24 ساعة" /></Field>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>نسخة احتياطية</h3><span className="panel-sub">احتفظ بنسخة على جهازك بشكل دوري، ضمان إضافي غير الاعتماد على الرابط فقط</span></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn-primary" onClick={exportBackup}><Wallet size={15} /> تحميل نسخة احتياطية (JSON)</button>
          <button className="btn-ghost" onClick={triggerImport}>استعادة من نسخة احتياطية</button>
          <input ref={fileInputRef} type="file" accept="application/json" style={{ display: "none" }} onChange={handleImportFile} />
        </div>
        {importMsg && <p className="field-hint" style={{ marginTop: 8 }}>{importMsg}</p>}
        <p className="field-hint" style={{ marginTop: 8 }}>نصيحة: نزّل نسخة كل فترة (أسبوعيًا مثلاً) واحفظها بمكان آمن (إيميلك، درايف...) — لو صار أي طارئ على الرابط أو التخزين، تقدر تستعيد بياناتك كاملة من هذا الملف.</p>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>النسخ الاحتياطية التلقائية</h3><span className="panel-sub">تُؤخذ تلقائيًا بالخلفية أول ما تفتح البرنامج كل يوم — بدون أي تدخل منك، وما تلمس بياناتك الحالية إطلاقًا</span></div>
        {backupDates === null ? (
          <p className="field-hint">جاري التحميل...</p>
        ) : backupDates.length === 0 ? (
          <p className="field-hint">ما فيه نسخ محفوظة بعد — أول نسخة تلقائية تُؤخذ أول ما تفتح البرنامج اليوم.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>التاريخ</th><th></th></tr></thead>
              <tbody>
                {backupDates.map((d) => (
                  <tr key={d}>
                    <td className="strong">{d}</td>
                    <td><button className="icon-btn" onClick={() => restoreFromAutoBackup(d)}>استعادة هذي النسخة</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {restoreMsg && <p className="field-hint" style={{ marginTop: 8 }}>{restoreMsg}</p>}
        <p className="field-hint" style={{ marginTop: 8 }}>النسخ تتراكم بدون حد أقصى ولا حذف تلقائي — تضل محفوظة كلها للأبد، منفصلة تمامًا عن بياناتك الحية.</p>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>طرق الدفع</h3><span className="panel-sub">تظهر بالاختيار عند تسجيل الفواتير</span></div>
        <div className="settings-list">
          {s.paymentMethods.map((m, i) => (
            <div className="settings-row" key={i}>
              <input value={m} onChange={(e) => editMethod(i, e.target.value)} />
              <button className="icon-btn danger" onClick={() => removeMethod(i)}><Trash2 size={14} /></button>
            </div>
          ))}
          <button className="link-btn" onClick={addMethod}><Plus size={14} /> إضافة طريقة دفع</button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>إقفال الفترة المحاسبية</h3><span className="panel-sub">بعد تقديم الإقرار الضريبي أو إغلاق الشهر، اقفل لين تاريخ معيّن: ما أحد يقدر يضيف أو يعدّل أو يحذف فواتير ومصروفات ومشتريات بهالفترة.</span></div>
        <div className="form-row four">
          <Field label="مقفل لين تاريخ (شامل)" hint={s.lockedUntil ? `الإقفال الحالي: ${s.lockedUntil}` : "ما فيه إقفال حاليًا"}>
            <input type="date" value={lockInput} onChange={(e) => setLockInput(e.target.value)} />
          </Field>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn-primary" disabled={!lockInput} onClick={() => setSettings({ ...s, lockedUntil: lockInput })}>تطبيق الإقفال</button>
          {s.lockedUntil && <button className="btn-ghost" onClick={() => { setSettings({ ...s, lockedUntil: "" }); setLockInput(""); }}>فتح الإقفال</button>}
        </div>
        <p className="field-hint" style={{ marginTop: 8 }}>طلبات الموقع الجديدة تنستورد دائمًا (هي مبيعات حقيقية). الإقفال يمنع فقط التعديل اليدوي. كل إقفال وفتح ينسجل في «سجل التعديلات».</p>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>نسبة تطوير المشروع</h3><span className="panel-sub">من الربح التشغيلي الصافي، قبل توزيعه على الشركاء</span></div>
        <Field label="النسبة %"><input type="number" min="0" max="100" value={s.devPercent} onChange={(e) => setSettings({ ...s, devPercent: e.target.value })} style={{ maxWidth: 140 }} /></Field>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>الشركاء وتسجيل الدخول</h3><span className="panel-sub">توزيع الباقي بعد نسبة التطوير — المجموع الحالي: {partnersSum}%</span></div>
        <p className="field-hint" style={{ marginBottom: 10 }}>الإيميل هنا لازم يطابق بالضبط الإيميل المسجّل لهذا الشريك بحساب Firebase Authentication (يضبطه صاحب المشروع من Firebase Console). كلمات المرور نفسها ما تُخزّن ولا تظهر بهذا البرنامج إطلاقًا — تُدار بشكل آمن من Google مباشرة.</p>
        <div className="settings-list">
          {s.partners.map((p) => (
            <div className="partner-row" key={p.id}>
              <input value={p.name} onChange={(e) => editPartner(p.id, "name", e.target.value)} placeholder="الاسم" />
              <input type="number" style={{ maxWidth: 90 }} value={p.percent} onChange={(e) => editPartner(p.id, "percent", e.target.value)} />
              <span className="field-hint">%</span>
              <input
                type="email" value={p.email || ""} onChange={(e) => editPartner(p.id, "email", e.target.value)}
                placeholder="الإيميل المسجّل بـ Firebase" style={{ maxWidth: 220 }}
              />
              <button className="icon-btn danger" onClick={() => removePartner(p.id)}><Trash2 size={14} /></button>
            </div>
          ))}
          <button className="link-btn" onClick={addPartner}><Plus size={14} /> إضافة شريك</button>
        </div>
        {partnersSum !== 100 && <p className="field-hint" style={{ color: "var(--copper)", marginTop: 6 }}>تنبيه: مجموع نسب الشركاء لازم يكون 100% عشان التوزيع يكون دقيق.</p>}
      </div>
      <ConfirmModal state={confirmState} onCancel={() => setConfirmState(null)} />
    </div>
  );
}

/* ============================== سجل التعديلات ============================== */

const AUDIT_KIND = { add: ["إضافة", "green"], edit: ["تعديل", "blue"], delete: ["حذف", "red"], void: ["إلغاء / مرتجع", "red"], unvoid: ["إعادة تفعيل", "amber"], lock: ["إقفال", "amber"], restore: ["استعادة", "amber"] };

function AuditTab({ data }) {
  const log = data.auditLog || [];
  const [area, setArea] = useState("");
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const areas = useMemo(() => [...new Set(log.map((x) => x.area))], [log]);
  const qn = q.trim().toLowerCase();
  const rows = useMemo(() => [...log].reverse().filter((x) => (!area || x.area === area) && (!kind || x.kind === kind) && (!qn || String(x.ref || "").toLowerCase().includes(qn) || String(x.by || "").toLowerCase().includes(qn))).slice(0, 400), [log, area, kind, qn]);
  const fmtAt = (iso) => { try { return new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Muscat", hour12: false }).replace(",", ""); } catch (e) { return iso; } };
  return (
    <div className="page">
      <PageHead eyebrow="النظام" title="سجل التعديلات" desc="كل إضافة وتعديل وحذف وإلغاء وإقفال ينسجل تلقائيًا: من سوّاه، ومتى. للرجوع له عند أي خلاف أو مراجعة محاسب. (آخر 1500 عملية)" />
      <div className="panel">
        <div className="form-row">
          <Field label="القسم"><select value={area} onChange={(e) => setArea(e.target.value)}><option value="">الكل</option>{areas.map((a) => <option key={a} value={a}>{a}</option>)}</select></Field>
          <Field label="نوع العملية"><select value={kind} onChange={(e) => setKind(e.target.value)}><option value="">الكل</option>{Object.entries(AUDIT_KIND).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}</select></Field>
          <Field label="بحث (بيان / اسم)"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث..." /></Field>
        </div>
      </div>
      {rows.length === 0 ? <Empty icon={ShieldCheck} title="ما فيه سجل بعد" sub="العمليات الجاية تنسجل هنا تلقائيًا." /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>الوقت (مسقط)</th><th>بواسطة</th><th>العملية</th><th>القسم</th><th>البيان</th><th>المبلغ</th></tr></thead>
          <tbody>{rows.map((x) => {
            const k = AUDIT_KIND[x.kind] || [x.kind, "blue"];
            return (<tr key={x.id}><td className="num">{fmtAt(x.at)}</td><td>{x.by}</td><td><span className={`badge ${k[1]}`}>{k[0]}</span></td><td>{x.area}</td><td>{x.ref}</td><td className="num">{x.amount != null && x.amount !== "" ? `${fmt(x.amount)} ر.ع` : "—"}</td></tr>);
          })}</tbody></table></div>
      )}
    </div>
  );
}

/* ============================== styles ============================== */

function Style() {
  return (
    <style>{`
      * { box-sizing: border-box; }
      html, body { margin:0; padding:0; background:#F6F2EA; -webkit-text-size-adjust:100%; }
      button { font-family:'Cairo',sans-serif; }
      :focus-visible { outline:2px solid var(--teal); outline-offset:2px; }
      :root{
        --bg:#F6F2EA; --surface:#FFFFFF; --surface-2:#FBF8F2; --border:#E3DCCB;
        --ink:#22302B; --ink-soft:#6B7770; --teal:#0E6E5B; --teal-dark:#0A4F42;
        --copper:#B9702E; --danger:#B3452F; --success:#1F7A4D;
      }
      .app-shell{ display:flex; min-height:100vh; width:100%; background:var(--bg); color:var(--ink); font-family:'Cairo',sans-serif; direction:rtl; }
      .boot-screen{ display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; height:100vh; background:var(--bg); color:var(--ink-soft); font-family:'Cairo',sans-serif; }
      .spin{ animation: spin 1s linear infinite; color:var(--teal); }
      @keyframes spin{ to{ transform:rotate(360deg); } }

      .sidebar{ width:230px; flex-shrink:0; background:#14231F; color:#E7E2D3; display:flex; flex-direction:column; padding:20px 16px; gap:22px; position:sticky; top:0; align-self:flex-start; height:100vh; overflow-y:auto; }
      .brand{ display:flex; align-items:center; gap:10px; }
      .brand-mark{ width:34px; height:34px; border-radius:9px; background:var(--teal); display:flex; align-items:center; justify-content:center; font-weight:800; color:#fff; font-size:16px; }
      .brand-title{ font-weight:700; font-size:14px; }
      .brand-sub{ font-size:11px; color:#9CA89F; }
      .nav{ display:flex; flex-direction:column; gap:4px; overflow-y:auto; }
      .nav-item{ white-space:nowrap; flex-shrink:0; display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:8px; background:transparent; border:none; color:#C9D0C6; font-family:'Cairo'; font-size:13px; cursor:pointer; text-align:right; transition:background .15s; }
      .nav-item:hover{ background:rgba(255,255,255,.06); }
      .nav-item.active{ background:var(--teal); color:#fff; font-weight:600; }
      .nav{ gap:2px; flex:1 1 auto; min-height:0; }
      .nav-item{ padding:6px 10px !important; }
      .sidebar{ gap:14px !important; padding:16px 14px !important; }
      .sidebar-foot{ display:none !important; }
      .nav-group{ display:flex; flex-direction:column; gap:2px; padding-bottom:6px; }
      .nav-group + .nav-group{ border-top:1px solid rgba(255,255,255,.07); padding-top:8px; }
      .nav-group-title{ font-size:10.5px; letter-spacing:.04em; color:#7D8A80; font-weight:700; padding:2px 10px 4px; }
      .period-bar{ display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:4px 0 14px; }
      .period-bar input[type=date]{ padding:6px 8px; border:1px solid var(--border); border-radius:8px; background:var(--surface); font-family:inherit; }
      .chip-btn{ border:1px solid var(--border); background:var(--surface); color:var(--ink); border-radius:999px; padding:6px 14px; font-family:'Cairo'; font-size:12.5px; cursor:pointer; }
      .chip-btn.on{ background:var(--teal); color:#fff; border-color:var(--teal); font-weight:700; }
      .period-label{ margin-right:auto; font-size:12.5px; color:var(--ink-soft); }
      .profit-hero{ display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; background:var(--surface); border:1px solid var(--border); border-right:5px solid var(--accent); border-radius:14px; padding:18px 22px; margin-bottom:16px; }
      .profit-value{ font-size:34px; font-weight:800; color:var(--accent); line-height:1.2; }
      .profit-value .unit{ font-size:14px; color:var(--ink-soft); font-weight:600; }
      .profit-note{ font-size:12px; color:var(--ink-soft); max-width:440px; line-height:1.7; }
      .kpi-group{ margin-bottom:14px; }
      .kpi-group-title{ font-size:12.5px; font-weight:700; color:var(--ink-soft); margin:0 2px 8px; }
      .split-card small{ display:block; margin-top:4px; font-size:11.5px; color:var(--ink-soft); }
      .check-inline{ display:inline-flex; align-items:center; gap:8px; font-size:13px; cursor:pointer; }
      .ticket-void{ opacity:.62; background:repeating-linear-gradient(135deg,#fff,#fff 10px,#faf3f0 10px,#faf3f0 20px); }
      .badge.red{ background:#F6E1DB; color:var(--danger); }
      .icon-btn.warn{ color:var(--copper); border-color:#E8CFA9; }
      .sidebar-foot{ margin-top:auto; display:flex; align-items:flex-start; gap:6px; font-size:10.5px; color:#7D8A80; line-height:1.5; padding-top:12px; border-top:1px dashed #2C3B36; }
      .sidebar-user{ margin-top:auto; display:flex; flex-direction:column; align-items:stretch; gap:6px; padding-top:12px; border-top:1px solid #2C3B36; }
      .sidebar-user .logout-btn{ margin:0 !important; padding:6px 9px; text-align:center; }
      .sidebar-user-name{ font-size:12.5px; font-weight:700; color:#E7E2D3; }
      .logout-btn{ background:none; border:1px solid #3A4A44; color:#B8C2BC; font-family:'Cairo'; font-size:11.5px; white-space:nowrap; border-radius:7px; padding:4px 9px; cursor:pointer; }
      .logout-btn:hover{ background:rgba(255,255,255,.06); }

      .login-screen{ min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg); font-family:'Cairo',sans-serif; padding:20px; }
      .login-card{ background:var(--surface); border:1px solid var(--border); border-radius:18px; padding:32px 28px; width:100%; max-width:340px; text-align:center; }
      .login-card h2{ margin:0 0 2px; font-size:19px; font-weight:800; letter-spacing:.5px; }
      .login-brand-sub{ font-size:11px; color:var(--teal); font-weight:600; margin:0 0 14px; }
      .login-sub{ font-size:12.5px; color:var(--ink-soft); margin:0 0 18px; }
      .login-users{ display:flex; flex-direction:column; gap:8px; }
      .login-user-btn{ padding:11px; border-radius:10px; border:1px solid var(--border); background:var(--surface-2); font-family:'Cairo'; font-size:14px; font-weight:600; cursor:pointer; color:var(--ink); }
      .login-user-btn.active{ background:var(--teal); color:#fff; border-color:var(--teal); }
      .login-form{ display:flex; flex-direction:column; gap:10px; }
      .login-form input{ text-align:center; font-size:14px; }
      .login-error{ color:var(--danger); font-size:12px; margin:10px 0 0; }
      .login-reset-msg{ color:var(--success); font-size:12px; margin:10px 0 0; }

      .content{ flex:1; min-width:0; padding:28px 32px; overflow-x:hidden; }
      .page{ max-width:1080px; margin:0 auto; display:flex; flex-direction:column; gap:20px; }
      .page-head{ display:flex; align-items:flex-end; justify-content:space-between; gap:12px; flex-wrap:wrap; }
      .eyebrow{ font-size:11.5px; color:var(--teal); font-weight:700; letter-spacing:.3px; margin-bottom:4px; }
      .page-head h2{ margin:0; font-size:22px; font-weight:800; }
      .page-desc{ margin:4px 0 0; color:var(--ink-soft); font-size:13px; max-width:560px; }

      .kpi-row{ display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; }
      .kpi-card{ background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:14px 16px; border-right:3px solid var(--accent, var(--teal)); position:relative; }
      .kpi-icon{ color:var(--accent,var(--teal)); margin-bottom:6px; }
      .kpi-label{ font-size:12px; color:var(--ink-soft); margin-bottom:4px; }
      .kpi-value{ font-family:'JetBrains Mono',monospace; font-weight:600; font-size:18px; }
      .kpi-value .unit{ font-family:'Cairo'; font-size:11px; color:var(--ink-soft); }

      .panel{ background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:18px 20px; }
      .panel-head{ margin-bottom:12px; display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
      .panel-head h3{ margin:0; font-size:15px; font-weight:700; }
      .panel-sub{ font-size:12px; color:var(--ink-soft); }

      .table-wrap{ overflow-x:auto; background:var(--surface); border:1px solid var(--border); border-radius:14px; }
      table{ width:100%; border-collapse:collapse; font-size:13px; }
      thead th{ text-align:right; padding:11px 14px; background:var(--surface-2); color:var(--ink-soft); font-weight:600; font-size:11.5px; border-bottom:1px solid var(--border); white-space:nowrap; }
      tbody td{ padding:10px 14px; border-bottom:1px solid var(--border); white-space:nowrap; }
      tbody tr:last-child td{ border-bottom:none; }
      td.strong{ font-weight:700; }
      td.num, th.num{ font-family:'JetBrains Mono',monospace; }
      .num{ font-family:'JetBrains Mono',monospace; }
      .pos{ color:var(--success); } .neg{ color:var(--danger); }
      .stock-low{ color:var(--danger); font-weight:700; }
      .stock-warning{ color:var(--danger); font-weight:600; }

      .empty-state{ display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; padding:50px 20px; color:var(--ink-soft); background:var(--surface-2); border:1px dashed var(--border); border-radius:14px; text-align:center; }
      .empty-title{ font-weight:700; color:var(--ink); margin:2px 0 0; }
      .empty-sub{ font-size:12.5px; max-width:360px; margin:0; }

      .alert-banner{ display:flex; align-items:center; gap:8px; background:#FBF0DC; color:#8C6B22; border:1px solid #EBD9A9; border-radius:10px; padding:10px 14px; font-size:12.5px; }

      .btn-primary{ display:flex; align-items:center; gap:6px; background:var(--teal); color:#fff; border:none; border-radius:9px; padding:9px 16px; font-family:'Cairo'; font-weight:600; font-size:13.5px; cursor:pointer; transition:background .15s; }
      .btn-primary:hover{ background:var(--teal-dark); }
      .btn-primary:disabled{ opacity:.45; cursor:not-allowed; }
      .btn-ghost{ display:flex; align-items:center; gap:6px; background:transparent; border:1px solid var(--border); border-radius:9px; padding:9px 16px; font-family:'Cairo'; font-size:13.5px; cursor:pointer; color:var(--ink); }
      .link-btn{ display:flex; align-items:center; gap:5px; background:none; border:none; color:var(--teal); font-family:'Cairo'; font-weight:600; font-size:12.5px; cursor:pointer; padding:4px 0; }
      .icon-btn{ display:inline-flex; align-items:center; gap:4px; background:var(--surface-2); border:1px solid var(--border); border-radius:7px; padding:5px 9px; cursor:pointer; color:var(--ink); font-size:11.5px; font-family:'Cairo'; }
      .icon-btn.danger{ color:var(--danger); }

      .cards-grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:14px; }
      .product-card{ background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:16px; }
      .product-card-top{ display:flex; justify-content:space-between; align-items:flex-start; gap:8px; }
      .product-name{ font-weight:700; font-size:15px; }
      .product-cat{ font-size:11.5px; color:var(--ink-soft); margin-top:4px; display:flex; align-items:center; gap:5px; }
      .product-actions{ display:flex; gap:6px; }
      .product-stats{ display:flex; gap:16px; margin-top:14px; padding-top:12px; border-top:1px dashed var(--border); }
      .stat-label{ font-size:10.5px; color:var(--ink-soft); }
      .stat-value{ font-family:'JetBrains Mono',monospace; font-weight:600; font-size:14px; margin-top:2px; }
      .expand-btn{ margin-top:12px; display:flex; align-items:center; gap:5px; background:none; border:none; color:var(--teal); font-family:'Cairo'; font-size:12px; font-weight:600; cursor:pointer; padding:0; }
      .chev{ transition:transform .15s; } .chev.open{ transform:rotate(-90deg); }
      .product-detail{ margin-top:12px; padding-top:12px; border-top:1px solid var(--border); }
      .detail-grid{ display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
      .detail-list{ flex:1; min-width:160px; }
      .detail-row{ display:flex; justify-content:space-between; font-size:12.5px; padding:4px 0; color:var(--ink-soft); gap:10px; }
      .detail-row.total{ border-top:1px solid var(--border); margin-top:4px; padding-top:6px; font-weight:700; color:var(--ink); }
      .mini-list{ margin-top:10px; background:var(--surface-2); border-radius:9px; padding:8px 10px; }
      .mini-list-title{ font-size:11px; color:var(--ink-soft); margin-bottom:4px; font-weight:600; }
      .mini-list-row{ display:flex; justify-content:space-between; font-size:12px; padding:2px 0; }

      .field{ display:flex; flex-direction:column; gap:5px; flex:1; min-width:130px; }
      .field-label{ font-size:11.5px; color:var(--ink-soft); font-weight:600; }
      .field-hint{ font-size:11px; color:#7D8A80; line-height:1.5; }
      .form-problem{ margin-inline-end:auto; align-self:center; color:var(--danger); font-size:12px; font-weight:600; }
      .grid-2{ display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px; }
      .panel form > .field, .panel > .field, .modal-body > .field{ margin-bottom:12px; }
      .ticket-main{ min-width:0; flex:1; }
      .page-head > div:last-child:not(:first-child){ max-width:100%; }
      input, select, textarea{ font-family:'Cairo'; font-size:13px; padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface-2); color:var(--ink); width:100%; }
      input:focus, select:focus, textarea:focus{ outline:2px solid var(--teal); outline-offset:0; background:#fff; }
      .form-row{ display:flex; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
      .form-row.four > *{ min-width:150px; }
      .sub-head{ font-size:12.5px; font-weight:700; color:var(--ink); margin:16px 0 8px; }

      .materials-list{ display:flex; flex-direction:column; gap:8px; margin-bottom:6px; }
      .material-row{ display:grid; grid-template-columns:1fr 140px 34px; gap:8px; align-items:center; }
      .purchase-line-block{ border:1px solid var(--border); border-radius:10px; padding:8px; margin-bottom:6px; }
      .purchase-line-row{ display:grid; grid-template-columns:1fr 110px 110px 80px 34px; gap:8px; align-items:center; }
      .purchase-line-extra{ display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; margin-top:8px; }
      .purchase-extra-row{ display:grid; grid-template-columns:1fr 110px 80px 34px; gap:8px; align-items:center; margin-bottom:6px; }
      .overhead-usage-row{ display:grid; grid-template-columns:1fr 130px 34px; gap:8px; align-items:center; margin-bottom:6px; }
      .attachment-row{ display:flex; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap; }
      .attachment-row .num{ flex:1; font-size:12px; }
      .invoice-item-block{ border:1px solid var(--border); border-radius:10px; padding:8px; margin-bottom:4px; }
      .invoice-item-row{ display:grid; grid-template-columns:1.6fr .7fr .9fr .9fr 34px; gap:8px; align-items:center; }
      .invoice-item-extra{ display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap; }
      .invoice-item-extra input{ max-width:200px; }
      .chip-toggle{ font-family:'Cairo'; font-size:11.5px; background:var(--surface-2); border:1px solid var(--border); border-radius:999px; padding:5px 12px; cursor:pointer; color:var(--ink); white-space:nowrap; }
      .chip-toggle.active{ background:var(--copper); color:#fff; border-color:var(--copper); }
      .chip-toggle:disabled{ opacity:.4; cursor:not-allowed; }
      .print-totals{ text-align:left; font-size:12.5px; margin-bottom:10px; display:flex; flex-direction:column; gap:3px; }
      .line-total{ font-size:12.5px; text-align:left; }
      .trip-costs{ background:var(--surface-2); border-radius:9px; padding:10px; }

      .calc-summary{ display:flex; gap:20px; background:var(--surface-2); border-radius:10px; padding:12px 16px; margin-top:14px; flex-wrap:wrap; }
      .calc-summary > div{ display:flex; flex-direction:column; gap:2px; }
      .calc-summary span{ font-size:11px; color:var(--ink-soft); }
      .calc-summary strong{ font-family:'JetBrains Mono',monospace; font-size:16px; }
      .calc-summary strong.pos{ color:var(--success); } .calc-summary strong.neg{ color:var(--danger); }

      .type-toggle{ display:flex; gap:8px; }
      .type-toggle button{ flex:1; padding:9px; border-radius:8px; border:1px solid var(--border); background:var(--surface-2); cursor:pointer; font-family:'Cairo'; font-size:12.5px; color:var(--ink); }
      .type-toggle button.active{ background:var(--teal); color:#fff; border-color:var(--teal); font-weight:600; }

      .modal-overlay{ position:fixed; inset:0; background:rgba(20,25,22,.45); display:flex; align-items:center; justify-content:center; z-index:50; padding:20px; }
      .modal{ background:var(--surface); border-radius:16px; width:100%; max-width:660px; max-height:88vh; display:flex; flex-direction:column; overflow:hidden; }
      .modal-head{ display:flex; justify-content:space-between; align-items:center; padding:16px 20px; border-bottom:1px solid var(--border); }
      .modal-head h3{ margin:0; font-size:16px; }
      .modal-body{ padding:18px 20px; overflow-y:auto; }
      .modal-foot{ display:flex; justify-content:flex-end; gap:10px; padding:14px 20px; border-top:1px solid var(--border); }

      .badge{ font-size:10.5px; font-weight:700; padding:3px 9px; border-radius:999px; }
      .badge.blue{ background:#E7EEF3; color:#3D6B8C; }
      .badge.amber{ background:#F3EBDF; color:#8C6B3D; }
      .badge.green{ background:#E1F0E7; color:var(--success); }

      .invoice-list{ display:flex; flex-direction:column; gap:10px; }
      .ticket{ display:flex; justify-content:space-between; gap:14px; background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:14px 18px; position:relative; }
      .ticket::before, .ticket::after{ content:''; position:absolute; width:14px; height:14px; border-radius:50%; background:var(--bg); top:50%; transform:translateY(-50%); border:1px solid var(--border); }
      .ticket::before{ right:-8px; } .ticket::after{ left:-8px; }
      .ticket-top{ display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
      .ticket-no{ font-weight:700; font-size:13.5px; }
      .ticket-date{ font-size:11.5px; color:var(--ink-soft); font-family:'JetBrains Mono',monospace; }
      .ticket-customer{ font-size:13px; margin-top:3px; }
      .ticket-items{ display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
      .chip{ font-size:11px; background:var(--surface-2); border:1px solid var(--border); border-radius:999px; padding:3px 10px; }
      .ticket-side{ display:flex; flex-direction:column; align-items:flex-end; justify-content:space-between; gap:8px; flex-shrink:0; }
      .ticket-total{ font-family:'JetBrains Mono',monospace; font-weight:700; font-size:16px; }
      .ticket-actions{ display:flex; gap:6px; }

      .split-row{ display:flex; gap:12px; flex-wrap:wrap; }
      .split-card{ flex:1; min-width:150px; background:var(--surface-2); border-radius:10px; padding:12px 14px; display:flex; flex-direction:column; gap:4px; }
      .split-card span{ font-size:11.5px; color:var(--ink-soft); }
      .split-card strong{ font-family:'JetBrains Mono',monospace; font-size:15px; }
      .branding-note{ margin-top:12px; font-size:12px; color:var(--ink-soft); background:var(--surface-2); border-radius:9px; padding:10px 12px; }

      .settings-list{ display:flex; flex-direction:column; gap:8px; }
      .settings-row{ display:flex; gap:8px; align-items:center; }
      .settings-row input{ flex:1; }
      .partner-row{ display:flex; gap:8px; align-items:center; }
      .partner-row input:first-child{ flex:1; }

      @media (max-width:820px){
        .app-shell{ flex-direction:column; }
        .sidebar{ position:sticky; top:0; z-index:40; height:auto; width:100%; flex-direction:row; flex-wrap:wrap; align-items:center; padding:10px 12px 0; gap:8px 10px; overflow:visible; }
        .brand{ flex:1; min-width:0; }
        .sidebar-user{ order:2; margin:0; padding:0; border:0; flex-direction:row; align-items:center; gap:6px; }
        .sidebar-user-name{ display:none; }
        .sidebar-user .logout-btn{ padding:5px 8px; font-size:11px; }
        .nav{ order:3; width:100%; flex-direction:row; overflow-x:auto; gap:4px; padding:4px 0 10px; scrollbar-width:none; }
        .nav::-webkit-scrollbar{ display:none; }
        .nav-item{ padding:7px 12px !important; }
        .sidebar{ gap:8px 10px !important; padding:10px 12px 0 !important; }
        .nav-group{ flex-direction:row; padding:0; border:0 !important; gap:4px; }
        .nav-group-title{ display:none; }
        .profit-value{ font-size:26px; }
        .period-label{ width:100%; margin:0; }
        .sidebar-foot{ display:none; }
        .content{ padding:16px 14px 40px; }
        .page-head h2{ font-size:19px; }
        .kpi-row{ grid-template-columns:repeat(2,1fr); gap:10px; }
        .kpi-card{ padding:12px; }
        .kpi-row > :last-child:nth-child(odd){ grid-column:1 / -1; }
        .kpi-value{ font-size:16px; }
        .panel{ padding:14px; }
        .grid-2{ grid-template-columns:1fr; }
        .ticket{ flex-direction:column; }
        .ticket::before, .ticket::after{ display:none; }
        .ticket-side{ flex-direction:row; align-items:center; justify-content:space-between; flex-wrap:wrap; }
        .page-head > div:last-child:not(:first-child){ width:100%; }
        .page-head .btn-primary, .page-head .btn-ghost{ flex:1; justify-content:center; }
        .modal-overlay{ padding:0; align-items:flex-end; }
        .modal{ max-width:100% !important; max-height:94vh; border-radius:16px 16px 0 0; }
        .modal-foot{ flex-wrap:wrap; }
        .modal-foot .form-problem{ flex-basis:100%; }
        input, select, textarea{ font-size:16px; }
        .form-row > *{ min-width:100% !important; }
        .material-row{ grid-template-columns:1fr 100px 30px; }
        .purchase-line-row, .purchase-extra-row, .purchase-line-extra, .overhead-usage-row{ grid-template-columns:1fr; }
        .invoice-item-row{ grid-template-columns:1fr; }
      }
    `}</style>
  );
}
