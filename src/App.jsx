import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  LayoutDashboard, Boxes, Factory, Package, Receipt, Megaphone, AlertTriangle,
  Building2, Settings as SettingsIcon, Plus, Trash2, Printer, X, TrendingUp,
  TrendingDown, Loader2, ChevronLeft, Users, PackageX, Sparkles, AlertCircle,
  ShoppingCart, Wallet, Pencil, Wrench, FileText, Globe, RefreshCw
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, Legend
} from "recharts";
import { loadAppData, saveAppData, defaultAppData, watchAuth, signIn, signOutUser, resetPassword, ensureDailyBackup, listBackupDates, loadBackup } from "./firebase";
import { uploadToGoogleDrive, deleteFromGoogleDrive } from "./googleDrive";
import { pullWebOrders, ackWebOrders, pushWebStock, matchWebItems, buildInvoiceFromWebOrder, muscatDate, listOffers, saveOffer, deleteOffer, saveCode, deleteCode, listWebOrders, setWebOrderStatus, FULFILLMENT_STATUSES } from "./webOrders";

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
function availableToSell(data, productId, excludeInvoiceId) {
  return producedQty(data, productId) - soldQtyExcludingInvoice(data, productId, excludeInvoiceId) - sampledQty(data, productId) - lostQty(data, productId);
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
  return { items: itemsWithNet, subtotal, invoiceDiscountAmount, grandTotal };
}

/* ---- printing: fully isolated popup window, independent of the app's own CSS/layout ---- */

const PRINT_LABELS = {
  ar: {
    dir: "rtl", htmlLang: "ar", fontFamily: "'Cairo','Segoe UI',Tahoma,Arial,sans-serif",
    docTitle: "فاتورة بيع", tagline: "صناعة وتغليف العطور",
    customerInfo: "معلومات العميل", delivery: "التسليم", pickup: "استلام من المصنع", deliveryType: "توصيل",
    item: "الصنف", qty: "الكمية", unitPrice: "سعر الوحدة", discount: "خصم", total: "الإجمالي",
    subtotal: "المجموع", invoiceDiscount: "خصم الفاتورة", grandTotal: "الإجمالي الكلي",
    notes: "ملاحظات", thanks: "شكرًا لثقتكم بنا 🤍", gift: "🎁 هدية", currency: "ر.ع",
    periodTagline: "كشف حساب فترة (للاستخدام الداخلي)", from: "من", to: "إلى",
    invoiceNo: "رقم الفاتورة", customer: "العميل", paymentMethod: "طريقة الدفع", orderRef: "رقم الطلب", paid: "مدفوعة", email: "الإيميل", country: "الدولة",
    byMethod: "التوزيع حسب طريقة الدفع", invoiceCount: "عدد الفواتير",
  },
  en: {
    dir: "ltr", htmlLang: "en", fontFamily: "'Segoe UI',Tahoma,Arial,sans-serif",
    docTitle: "Sales Invoice", tagline: "Perfume Manufacturing & Packaging",
    customerInfo: "Customer Info", delivery: "Delivery", pickup: "Factory Pickup", deliveryType: "Delivery",
    item: "Item", qty: "Qty", unitPrice: "Unit Price", discount: "Discount", total: "Total",
    subtotal: "Subtotal", invoiceDiscount: "Invoice Discount", grandTotal: "Grand Total",
    notes: "Notes", thanks: "Thank you for your trust 🤍", gift: "🎁 Gift", currency: "OMR",
    periodTagline: "Period Statement (internal use)", from: "From", to: "To",
    invoiceNo: "Invoice No.", customer: "Customer", paymentMethod: "Payment Method", orderRef: "Order", paid: "PAID", email: "Email", country: "Country",
    byMethod: "Breakdown by Payment Method", invoiceCount: "Invoice Count",
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

function openPrintWindow(lang, bodyHTML) {
  const win = window.open("", "_blank", "width=850,height=1000");
  if (!win) {
    alert("المتصفح منع فتح نافذة الطباعة. فعّل النوافذ المنبثقة (Popups) لهذا الموقع وحاول مرة ثانية. / Popup blocked — please allow popups for this site.");
    return;
  }
  const L = PRINT_LABELS[lang];
  win.document.open();
  win.document.write(`<!doctype html><html dir="${L.dir}" lang="${L.htmlLang}"><head><meta charset="utf-8" /><title>${L.docTitle}</title><style>${printStyles(lang)}</style></head><body>${bodyHTML}</body></html>`);
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

  const html = `
    <div class="accent-bar"></div>
    <div class="sheet">
      <div class="print-head">
        <div class="head-col head-brand">
          <div class="print-brand">SILENT CODE</div>
          <div class="print-tagline">${L.tagline}</div>
          ${bizLines ? `<div class="biz-info">${bizLines}</div>` : ""}
        </div>
        <div class="head-col head-meta">
          <div class="doc-title">${L.docTitle}</div>
          <div class="invoice-badge"><bdi>${escHtml(invoice.webInvoiceNumber || "#" + invoice.number)}</bdi></div>
          <div class="print-meta-line">
            <div><bdi>${escHtml(invoice.date)}</bdi></div>
            ${invoice.webOrderRef ? `<div>${L.orderRef}: <bdi>${escHtml(invoice.webOrderRef)}</bdi></div>` : ""}
            ${invoice.paymentMethod ? `<div>${escHtml(lang === "en" ? (PRINT_METHOD_EN[invoice.paymentMethod] || invoice.paymentMethod) : invoice.paymentMethod)}</div>` : ""}
          </div>
          ${invoice.source === "website" ? `<div class="stamp">${L.paid}</div>` : ""}
        </div>
      </div>

      <div class="info-grid">
        <div class="info-box first">
          <div class="info-box-title">${L.customerInfo}</div>
          <div class="row"><b>${escHtml(invoice.customerName || "—")}</b></div>
          ${invoice.customerPhone ? `<div class="row"><bdi>${escHtml(invoice.customerPhone)}</bdi></div>` : ""}
          ${invoice.customerEmail ? `<div class="row"><bdi>${escHtml(invoice.customerEmail)}</bdi></div>` : ""}
          ${invoice.customerCountry ? `<div class="row">${escHtml(PRINT_COUNTRIES[invoice.customerCountry]?.[lang] || invoice.customerCountry)}</div>` : ""}
        </div>
        <div class="info-box second">
          <div class="info-box-title">${L.delivery}</div>
          <div class="row">${deliveryLine}</div>
        </div>
      </div>

      <table class="items">
        <thead><tr><th>${L.item}</th><th>${L.qty}</th><th>${L.unitPrice}</th><th>${L.discount}</th><th>${L.total}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>

      <div class="totals-wrap">
        <div class="totals">
          <div class="totals-row"><span>${L.subtotal}</span><span><bdi>${fmt(computed.subtotal)} ${L.currency}</bdi></span></div>
          ${computed.invoiceDiscountAmount > 0 ? `<div class="totals-row"><span>${L.invoiceDiscount}</span><span><bdi>-${fmt(computed.invoiceDiscountAmount)} ${L.currency}</bdi></span></div>` : ""}
          <div class="grand-total"><span>${L.grandTotal}</span><span><bdi>${fmt(computed.grandTotal)} ${L.currency}</bdi></span></div>
        </div>
      </div>

      ${invoice.note ? `<div class="note">${L.notes}: ${escHtml(invoice.note)}</div>` : ""}

      <div class="foot">
        <div class="foot-thanks">${L.thanks}</div>
        <div class="foot-note">${escHtml(biz.note || "SILENT CODE")}</div>
      </div>
    </div>
  `;
  openPrintWindow(lang, html);
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
      <td><bdi>${fmt(invoiceComputed(inv).grandTotal)}</bdi></td>
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

function productRevenueQty(data, productId) {
  let qty = 0, revenue = 0;
  data.invoices.forEach((inv) => {
    const computed = invoiceComputed(inv);
    computed.items.forEach((it) => {
      if (it.productId === productId) {
        qty += it.qty;
        revenue += it.netRevenue;
      }
    });
  });
  return { qty, revenue };
}

function computeAllProductAgg(data) {
  const totalRevenue = data.products.reduce((s, p) => s + productRevenueQty(data, p.id).revenue, 0);
  const totalGeneralMarketing = data.marketing.filter((m) => !m.productId).reduce((s, m) => s + (Number(m.cost) || 0), 0);
  return data.products.map((p) => {
    const { qty, revenue } = productRevenueQty(data, p.id);
    const ref = productReferenceCost(data, p.id);
    const cogs = qty * ref.unitCost;
    const direct = data.marketing.filter((m) => m.productId === p.id).reduce((s, m) => s + (Number(m.cost) || 0), 0);
    const allocatedGeneral = totalRevenue > 0 ? totalGeneralMarketing * (revenue / totalRevenue) : 0;
    const marketingTotal = direct + allocatedGeneral;
    const lossesTotal = data.losses.filter((l) => l.productId === p.id).reduce((s, l) => s + (Number(l.costTotal) || 0), 0);
    const grossProfit = revenue - cogs;
    const netProfit = grossProfit - marketingTotal - lossesTotal;
    return { product: p, qty, revenue, unitCost: ref.unitCost, costSource: ref.source, cogs, marketingTotal, lossesTotal, grossProfit, netProfit };
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
    const total = (inv.items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 0);
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

  async function persist(next) {
    const prev = dataRef.current ?? data;
    dataRef.current = next;
    setData(next);
    try {
      await saveAppData(prev, next);
      return true;
    } catch (e) {
      console.error("save error", e);
      return false;
    }
  }

  /* ---- استيراد طلبات الموقع المدفوعة كفواتير بيع ---- */
  function stockWarningsFor(nextData, orders) {
    const out = [];
    orders.forEach((o) => {
      (o.items || []).forEach((it) => {
        const prodId = it.productId;
        if (!prodId) return;
        const avail = availableToSell(nextData, prodId);
        if (avail < 0) {
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
      fresh.forEach((o) => {
        const m = matchWebItems(o, cur.products, cur.settings.webProductMap);
        (m.length > 0 && m.every((x) => x.productId) ? auto : manual).push(o);
      });

      let warnings = [];
      if (auto.length > 0) {
        let next = cur;
        const importedItems = [];
        auto.forEach((o) => {
          const m = matchWebItems(o, next.products, next.settings.webProductMap);
          const inv = buildInvoiceFromWebOrder(o, m, next.nextInvoiceNo, uid);
          next = { ...next, invoices: [...next.invoices, inv], nextInvoiceNo: next.nextInvoiceNo + 1 };
          importedItems.push({ items: inv.items });
        });
        const ok = await persist(next);
        if (ok) {
          ackRefs.push(...auto.map((o) => o.client_reference_id));
          warnings = stockWarningsFor(next, importedItems);
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
  async function loadFulfillment() {
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
    const cur = dataRef.current;
    if (!cur) return;
    const rev = {};
    Object.entries(cur.settings.webProductMap || {}).forEach(([webId, accId]) => { rev[accId] = webId; });
    const snap = cur.products.map((p) => ({
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
      warnings: [...new Set([...s.warnings, ...stockWarningsFor(next, [{ items: inv.items }])])],
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

  const NAV = [
    { id: "dashboard", label: "الرئيسية", icon: LayoutDashboard },
    { id: "materials", label: "المخزون والمواد", icon: Boxes },
    { id: "purchaseLog", label: "سجل المشتريات", icon: FileText },
    { id: "products", label: "المنتجات والوصفات", icon: Package },
    { id: "production", label: "دفعات الإنتاج", icon: Factory },
    { id: "invoices", label: "فواتير البيع", icon: Receipt },
    { id: "webOrders", label: "طلبات الموقع", icon: Globe, badge: webState.pending.length + webState.warnings.length + fulfil.orders.filter((o) => (o.fulfillment_status || "new") === "new").length },
    { id: "offers", label: "العروض والخصومات", icon: Sparkles },
    { id: "customers", label: "العملاء", icon: Users },
    { id: "marketing", label: "التسويق والسامبلات", icon: Megaphone },
    { id: "losses", label: "خسائر التصنيع", icon: AlertTriangle },
    { id: "equipment", label: "المعدات والأصول الثابتة", icon: Wrench },
    { id: "branding", label: "تكاليف التأسيس", icon: Building2 },
    { id: "settings", label: "الإعدادات", icon: SettingsIcon },
  ];

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
          {NAV.map((n) => (
            <button key={n.id} className={`nav-item ${tab === n.id ? "active" : ""}`} onClick={() => setTab(n.id)}>
              <n.icon size={17} strokeWidth={2} />
              <span>{n.label}</span>
              {n.badge > 0 && <span className="badge amber" style={{ marginRight: "auto" }}>{n.badge}</span>}
            </button>
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
        {tab === "dashboard" && <Dashboard data={data} />}
        {tab === "materials" && <MaterialsTab data={data} persist={persist} currentUser={currentUser} />}
        {tab === "purchaseLog" && <PurchaseLogTab data={data} />}
        {tab === "products" && <ProductsTab data={data} persist={persist} currentUser={currentUser} />}
        {tab === "production" && <ProductionTab data={data} persist={persist} currentUser={currentUser} />}
        {tab === "invoices" && <InvoicesTab data={data} persist={persist} currentUser={currentUser} />}
        {tab === "webOrders" && <WebOrdersTab data={data} webState={webState} onSync={syncWebOrders} onImport={importManualWebOrder} fulfil={fulfil} onReloadFulfil={loadFulfillment} onChangeStatus={changeFulfillment} />}
        {tab === "offers" && <OffersTab />}
        {tab === "customers" && <CustomersTab data={data} persist={persist} />}
        {tab === "marketing" && <MarketingTab data={data} persist={persist} currentUser={currentUser} />}
        {tab === "losses" && <LossesTab data={data} persist={persist} currentUser={currentUser} />}
        {tab === "equipment" && <EquipmentTab data={data} persist={persist} currentUser={currentUser} />}
        {tab === "branding" && <BrandingTab data={data} persist={persist} currentUser={currentUser} />}
        {tab === "settings" && <SettingsTab data={data} persist={persist} currentUser={currentUser} />}
      </main>


    </div>
  );
}

/* ============================== dashboard ============================== */

function Dashboard({ data }) {
  const agg = useMemo(() => computeAllProductAgg(data), [data]);
  const totals = useMemo(() => {
    const totalRevenue = agg.reduce((s, a) => s + a.revenue, 0);
    const totalCOGS = agg.reduce((s, a) => s + a.cogs, 0);
    const totalMarketing = data.marketing.reduce((s, m) => s + (Number(m.cost) || 0), 0);
    const totalLosses = data.losses.reduce((s, l) => s + (Number(l.costTotal) || 0), 0);
    const totalBranding = data.branding.reduce((s, b) => s + (Number(b.cost) || 0), 0);
    const totalEquipmentAssets = data.equipment.reduce((s, e) => s + (Number(e.cost) || 0), 0);
    const grossProfit = totalRevenue - totalCOGS;
    const operatingNetProfit = grossProfit - totalMarketing - totalLosses;
    return { totalRevenue, totalCOGS, totalMarketing, totalLosses, totalBranding, totalEquipmentAssets, grossProfit, operatingNetProfit };
  }, [agg, data]);

  const lowStock = data.materials.filter((m) => (Number(m.stock) || 0) <= (Number(m.minThreshold) || 0));

  const devPercent = data.settings.devPercent || 0;
  const devShare = totals.operatingNetProfit * (devPercent / 100);
  const remaining = totals.operatingNetProfit - devShare;
  const partners = data.settings.partners || [];

  const kpis = [
    { label: "إجمالي الإيرادات", value: totals.totalRevenue, color: "var(--teal)", Icon: TrendingUp },
    { label: "تكلفة البضاعة المباعة", value: totals.totalCOGS, color: "var(--copper)", Icon: Package },
    { label: "مصاريف التسويق", value: totals.totalMarketing, color: "#3D6B8C", Icon: Megaphone },
    { label: "خسائر التصنيع", value: totals.totalLosses, color: "var(--danger)", Icon: AlertTriangle },
    {
      label: "الربح التشغيلي الصافي",
      value: totals.operatingNetProfit,
      color: totals.operatingNetProfit >= 0 ? "var(--success)" : "var(--danger)",
      Icon: totals.operatingNetProfit >= 0 ? TrendingUp : TrendingDown,
    },
  ];

  const chartData = data.products.map((p) => {
    const a = agg.find((x) => x.product.id === p.id);
    return {
      name: p.name.length > 10 ? p.name.slice(0, 10) + "…" : p.name,
      الإيراد: Number((a?.revenue || 0).toFixed(3)),
      التكلفة: Number((a?.cogs || 0).toFixed(3)),
    };
  });

  return (
    <div className="page">
      <PageHead eyebrow="نظرة عامة" title="لوحة التحكم" desc="ملخص أداء البزنس من التصنيع للبيع" />

      <div className="kpi-row">
        {kpis.map((k) => (
          <div className="kpi-card" key={k.label} style={{ "--accent": k.color }}>
            <k.Icon size={16} className="kpi-icon" />
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value">{fmt(k.value)} <span className="unit">ر.ع</span></div>
          </div>
        ))}
      </div>

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
          <span className="panel-sub">حسب نسب الإعدادات الحالية</span>
        </div>
        <div className="split-row">
          <div className="split-card">
            <span>تطوير المشروع ({devPercent}%)</span>
            <strong>{fmt(devShare)} ر.ع</strong>
          </div>
          {partners.map((p) => (
            <div className="split-card" key={p.id}>
              <span>{p.name} ({p.percent}% من الباقي)</span>
              <strong>{fmt(remaining * ((Number(p.percent) || 0) / 100))} ر.ع</strong>
            </div>
          ))}
        </div>
        <div className="branding-note">
          إجمالي استثمار التأسيس/البراند حتى الآن: <strong>{fmt(totals.totalBranding)} ر.ع</strong> — وإجمالي المعدات والأصول الثابتة (المعاد استخدامها): <strong>{fmt(totals.totalEquipmentAssets)} ر.ع</strong> — الاثنين منفصلين تمامًا، يُستردّون تدريجيًا من الأرباح ولا يدخلون بتكلفة الوحدة. أما المستلزمات الاستهلاكية المرتبطة بالتصنيع (كمامات، قفازات...) فتُضاف كمواد بالمخزون وتدخل ضمن وصفة المنتج، فتنعكس تلقائيًا على تكلفة الوحدة وتكلفة البضاعة المباعة أعلاه.
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
    id: uid("pur"), number: nextNo, date: todayStr(), note: "",
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
  const methods = data.settings.paymentMethods || [];

  function startNew() { setEditing(emptyInvoice(data.nextInvoiceNo, methods[0])); }

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
    const invoices = exists ? data.invoices.map((x) => (x.id === inv.id ? inv : x)) : [...data.invoices, { ...inv, createdBy: currentUser?.name }];
    const nextInvoiceNo = exists ? data.nextInvoiceNo : data.nextInvoiceNo + 1;
    const materials = applyOverheadStockDelta(data.materials, existing?.overheadUsage, inv.overheadUsage);
    persist({ ...data, invoices, nextInvoiceNo, materials });
    setEditing(null);
  }
  function remove(id) {
    const inv = data.invoices.find((x) => x.id === id);
    setConfirmState({
      message: "تأكيد حذف الفاتورة؟",
      onConfirm: () => {
        const materials = applyOverheadStockDelta(data.materials, inv?.overheadUsage, []);
        persist({ ...data, invoices: data.invoices.filter((i) => i.id !== id), materials });
      },
    });
  }
  function invoiceTotal(inv) { return invoiceComputed(inv).grandTotal; }

  const qn = q.trim().toLowerCase();
  const filtered = data.invoices.filter((inv) => (!dateFrom || inv.date >= dateFrom) && (!dateTo || inv.date <= dateTo)
    && (!qn || String(inv.number).includes(qn) || (inv.customerName || "").toLowerCase().includes(qn) || (inv.customerPhone || "").includes(qn)));
  const isFiltering = dateFrom || dateTo;
  const periodTotal = filtered.reduce((s, inv) => s + invoiceTotal(inv), 0);
  const byMethod = {};
  filtered.forEach((inv) => {
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
          </div>

          {isFiltering && (
            <>
              <div className="calc-summary">
                <div><span>عدد الفواتير بالفترة</span><strong>{filtered.length}</strong></div>
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
              <button className="btn-ghost" style={{ marginTop: 12 }} onClick={() => printPeriodNow({ dateFrom, dateTo, invoices: filtered, total: periodTotal, byMethod }, data)}>
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
            <div className="ticket" key={inv.id}>
              <div className="ticket-main">
                <div className="ticket-top">
                  <span className="ticket-no">فاتورة #{inv.number}</span>
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
                <div className="ticket-actions">
                  <button className="icon-btn" onClick={() => printInvoiceNow(inv, data, "ar")} title="طباعة عربي"><Printer size={15} /> AR</button>
                  <button className="icon-btn" onClick={() => printInvoiceNow(inv, data, "en")} title="Print English"><Printer size={15} /> EN</button>
                  <button className="icon-btn" onClick={() => setEditing(inv)}>تعديل</button>
                  <button className="icon-btn danger" onClick={() => remove(inv.id)}><Trash2 size={15} /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && <InvoiceEditor invoice={editing} data={data} products={data.products} methods={methods} allInvoices={data.invoices} onSave={save} onClose={() => setEditing(null)} />}
      <ConfirmModal state={confirmState} onCancel={() => setConfirmState(null)} />
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
    setItem(id, "unitPrice", Number(ref.unitCost.toFixed(3)));
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
                    <button type="button" className="chip-toggle" onClick={() => setAtCost(it.id)} disabled={!it.productId}>بسعر التكلفة</button>
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

          <Field label="ملاحظات (اختياري)"><textarea rows={2} value={inv.note} onChange={(e) => set("note", e.target.value)} /></Field>

          <div className="calc-summary">
            <div><span>المجموع قبل خصم الفاتورة</span><strong>{fmt(computed.subtotal)} ر.ع</strong></div>
            <div><span>خصم الفاتورة</span><strong className="neg">{fmt(computed.invoiceDiscountAmount)} ر.ع</strong></div>
            <div><span>الإجمالي النهائي</span><strong>{fmt(computed.grandTotal)} ر.ع</strong></div>
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
        <div className="mini-list-title">اختر المنتج المقابل بالبرنامج لكل صنف (يتذكّره البرنامج للمرات الجاية)</div>
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

function WebOrdersTab({ data, webState, onSync, onImport, fulfil, onReloadFulfil, onChangeStatus }) {
  const webInvoices = data.invoices.filter((i) => i.source === "website").slice(-15).reverse();
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
                <span className="num">{fmt(invoiceComputed(inv).grandTotal)} ر.ع</span>
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
  const blankCode = { code: "", kind: "percent", value: "", usage: "unlimited", maxUses: "", validity: "none", startDate: "", expires: "" };
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
    setBusy(true);
    try {
      await saveCode({
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
      await saveCode({ code: c.code, percent_off: c.percent_off, amount_off: c.amount_off, max_uses: c.max_uses, starts_at: c.starts_at, expires_at: c.expires_at, active: !c.active });
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
          {codeError && <div className="alert-banner" style={{ marginBottom: 10 }}><AlertCircle size={15} /> {codeError}</div>}
          <button className="btn-primary" type="submit" disabled={busy}><Plus size={15} /> إضافة الكود</button>
        </form>
        {state.codes.length > 0 && (
          <div className="mini-list" style={{ marginTop: 14 }}>
            {state.codes.map((c) => (
              <div className="mini-list-row" key={c.code} style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ flex: 1 }}>
                  <strong dir="ltr">{c.code}</strong> — {c.percent_off != null ? `${Number(c.percent_off)}%` : `${Number(c.amount_off).toFixed(3)} ر.ع`}
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
                              const invTotal = (inv.items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 0);
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

function emptyMarketing() { return { id: uid("mkt"), date: todayStr(), type: "campaign", title: "", cost: "", productId: "", qty: "" }; }

function MarketingTab({ data, persist, currentUser }) {
  const [form, setForm] = useState(emptyMarketing());
  function set(field, val) {
    const next = { ...form, [field]: val };
    if (field === "type" && val === "campaign") next.qty = "";
    if ((field === "productId" || field === "qty") && next.type === "sample") {
      const ref = productReferenceCost(data, next.productId);
      if (next.productId && next.qty) next.cost = (ref.unitCost * Number(next.qty)).toFixed(3);
    }
    setForm(next);
  }
  function add() {
    if (!form.title.trim() || !form.cost) return;
    persist({ ...data, marketing: [...data.marketing, { ...form, title: form.title.trim(), createdBy: currentUser?.name }] });
    setForm(emptyMarketing());
  }
  function remove(id) { persist({ ...data, marketing: data.marketing.filter((m) => m.id !== id) }); }

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
                    <td className="num">{fmt(m.cost)} ر.ع</td>
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

function emptyEquipment() { return { id: uid("equip"), code: "", date: todayStr(), title: "", qty: 1, cost: "", note: "" }; }

function EquipmentTab({ data, persist, currentUser }) {
  const [form, setForm] = useState({ ...emptyEquipment(), code: nextCode(data.equipment, "EQ-") });
  const [editingId, setEditingId] = useState(null);
  const [confirmState, setConfirmState] = useState(null);

  function save() {
    if (!form.title.trim() || !form.cost) return;
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
                  <td className="num">{fmt(e.cost)} ر.ع</td>
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

function emptyBranding() { return { id: uid("brand"), date: todayStr(), title: "", cost: "", note: "" }; }

function BrandingTab({ data, persist, currentUser }) {
  const [form, setForm] = useState(emptyBranding());
  const [editingId, setEditingId] = useState(null);
  function save() {
    if (!form.title.trim() || !form.cost) return;
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
  function remove(id) { persist({ ...data, branding: data.branding.filter((b) => b.id !== id) }); }
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
                  <td>{b.date}</td><td className="strong">{b.title}</td><td className="num">{fmt(b.cost)} ر.ع</td><td>{b.note}</td>
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
          await persist(restored);
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
          onConfirm: () => { persist(parsed); setImportMsg("تمت الاستعادة بنجاح ✅"); },
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
        .nav-item{ padding:7px 12px; }
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
