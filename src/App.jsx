import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  LayoutDashboard, Boxes, Factory, Package, Receipt, Megaphone, AlertTriangle,
  Building2, Settings as SettingsIcon, Plus, Trash2, Printer, X, TrendingUp,
  TrendingDown, Loader2, ChevronLeft, Users, PackageX, Sparkles, AlertCircle,
  ShoppingCart, Wallet, Pencil, Wrench
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, Legend
} from "recharts";
import { loadAppData, saveAppData } from "./firebase";

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
const toOMR = (amount, currency) => (currency === "AED" ? (Number(amount) || 0) * AED_RATE : Number(amount) || 0);

function defaultData() {
  return {
    materials: [],
    purchases: [],
    products: [],
    batches: [],
    invoices: [],
    marketing: [],
    losses: [],
    branding: [],
    equipment: [],
    settings: {
      paymentMethods: [
        "نقدًا (كاش)",
        "تحويل - حساب الشركة",
        "تحويل - حسابي (سعيد)",
        "تحويل - حساب عبدالله",
        "بوابة دفع إلكتروني",
      ],
      partners: [
        { id: uid("partner"), name: "سعيد", percent: 50, pin: "1234" },
        { id: uid("partner"), name: "عبدالله", percent: 50, pin: "1234" },
      ],
      devPercent: 50,
    },
    nextInvoiceNo: 1001,
  };
}

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
    if (!map.has(key)) map.set(key, { name, phone: inv.customerPhone || "", count: 0, total: 0, lastDate: inv.date, invoices: [] });
    const c = map.get(key);
    c.count += 1;
    c.total += total;
    if (inv.customerPhone) c.phone = inv.customerPhone;
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
            <button className="btn-ghost" onClick={onCancel}>إلغاء</button>
            <button className="btn-primary" style={{ background: "var(--danger)" }} onClick={() => { state.onConfirm(); onCancel(); }}>
              تأكيد الحذف
            </button>
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

function LoginScreen({ partners, onLogin }) {
  const [selected, setSelected] = useState(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  function submit() {
    if (!selected) return;
    if (String(pin) === String(selected.pin || "")) {
      onLogin({ id: selected.id, name: selected.name });
    } else {
      setError("الرمز غلط، حاول مرة ثانية");
      setPin("");
    }
  }

  return (
    <div className="login-screen" dir="rtl">
      <Style />
      <div className="login-card">
        <div className="brand-mark" style={{ margin: "0 auto 14px" }}>م</div>
        <h2>SILENT CODE</h2>
        <p className="login-brand-sub">نظام محاسبة التصنيع والتغليف</p>
        <p className="login-sub">اختر اسمك وأدخل الرمز عشان تدخل</p>

        <div className="login-users">
          {partners.map((p) => (
            <button
              key={p.id}
              className={`login-user-btn ${selected?.id === p.id ? "active" : ""}`}
              onClick={() => { setSelected(p); setError(""); setPin(""); }}
            >
              {p.name}
            </button>
          ))}
        </div>

        {selected && (
          <div className="login-pin-row">
            <input
              type="password"
              inputMode="numeric"
              maxLength={6}
              placeholder="الرمز"
              value={pin}
              onChange={(e) => { setPin(e.target.value); setError(""); }}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              autoFocus
            />
            <button className="btn-primary" onClick={submit} disabled={!pin}>دخول</button>
          </div>
        )}
        {error && <p className="login-error">{error}</p>}
      </div>
    </div>
  );
}

/* ============================== app ============================== */

export default function CostingApp() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("dashboard");
  const [printInvoice, setPrintInvoice] = useState(null);
  const [printPeriod, setPrintPeriod] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const loaded = await loadAppData();
        setData(loaded);
      } catch (e) {
        console.error("load error", e);
        setData(defaultData());
      }
      setLoading(false);
    })();
  }, []);

  async function persist(next) {
    const prev = data;
    setData(next);
    try {
      await saveAppData(prev, next);
    } catch (e) {
      console.error("save error", e);
    }
  }

  useEffect(() => {
    if (printInvoice || printPeriod) {
      const t = setTimeout(() => window.print(), 80);
      const after = () => { setPrintInvoice(null); setPrintPeriod(null); };
      window.addEventListener("afterprint", after, { once: true });
      return () => clearTimeout(t);
    }
  }, [printInvoice, printPeriod]);

  if (loading || !data) {
    return (
      <div className="boot-screen">
        <Style />
        <Loader2 className="spin" size={26} />
        <span>جاري تحميل بيانات البزنس...</span>
      </div>
    );
  }

  if (!currentUser) {
    return <LoginScreen partners={data.settings.partners || []} onLogin={setCurrentUser} />;
  }

  const NAV = [
    { id: "dashboard", label: "الرئيسية", icon: LayoutDashboard },
    { id: "materials", label: "المخزون والمواد", icon: Boxes },
    { id: "products", label: "المنتجات والوصفات", icon: Package },
    { id: "production", label: "دفعات الإنتاج", icon: Factory },
    { id: "invoices", label: "فواتير البيع", icon: Receipt },
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
            </button>
          ))}
        </nav>
        <div className="sidebar-user">
          <div className="sidebar-user-name">{currentUser.name}</div>
          <button className="logout-btn" onClick={() => setCurrentUser(null)}>تسجيل خروج</button>
        </div>
        <div className="sidebar-foot">
          <Users size={13} />
          <span>بيانات مشتركة بين كل مستخدمي هذا البرنامج</span>
        </div>
      </aside>

      <main className="content">
        {tab === "dashboard" && <Dashboard data={data} />}
        {tab === "materials" && <MaterialsTab data={data} persist={persist} currentUser={currentUser} />}
        {tab === "products" && <ProductsTab data={data} persist={persist} currentUser={currentUser} />}
        {tab === "production" && <ProductionTab data={data} persist={persist} currentUser={currentUser} />}
        {tab === "invoices" && <InvoicesTab data={data} persist={persist} onPrint={setPrintInvoice} onPrintPeriod={setPrintPeriod} currentUser={currentUser} />}
        {tab === "customers" && <CustomersTab data={data} />}
        {tab === "marketing" && <MarketingTab data={data} persist={persist} currentUser={currentUser} />}
        {tab === "losses" && <LossesTab data={data} persist={persist} currentUser={currentUser} />}
        {tab === "equipment" && <EquipmentTab data={data} persist={persist} currentUser={currentUser} />}
        {tab === "branding" && <BrandingTab data={data} persist={persist} currentUser={currentUser} />}
        {tab === "settings" && <SettingsTab data={data} persist={persist} />}
      </main>

      {printInvoice && <PrintInvoice invoice={printInvoice} data={data} />}
      {printPeriod && <PrintPeriodSummary period={printPeriod} data={data} />}
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
function emptyPurchase() {
  return {
    id: uid("pur"), date: todayStr(), note: "",
    lines: [{ id: uid("pl"), materialId: "", qty: "", unitCost: "", currency: "OMR" }],
    extraCosts: [],
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
    setConfirmState({
      message: "تأكيد حذف المادة؟",
      onConfirm: () => persist({ ...data, materials: data.materials.filter((m) => m.id !== id) }),
    });
  }
  function removePurchase(id) {
    setConfirmState({
      message: "تأكيد حذف سجل الشراء؟ (لن يرجع تلقائيًا الكمية أو يصحح متوسط التكلفة بالمواد)",
      onConfirm: () => persist({ ...data, purchases: data.purchases.filter((p) => p.id !== id) }),
    });
  }
  function savePurchase(pur) {
    const validLines = convertLinesToOMR(pur.lines.filter((l) => l.materialId && l.qty));
    const extraCosts = convertExtrasToOMR(pur.extraCosts);
    const allocated = allocatePurchaseLines(validLines, extraCosts);
    let materials = [...data.materials];
    allocated.forEach((l) => {
      materials = materials.map((m) => {
        if (m.id !== l.materialId) return m;
        const curStock = Number(m.stock) || 0;
        const curAvg = Number(m.avgCost) || 0;
        const qty = Number(l.qty) || 0;
        const newStock = curStock + qty;
        const newAvg = newStock > 0 ? (curStock * curAvg + qty * l.landedUnitCost) / newStock : curAvg;
        return { ...m, stock: newStock, avgCost: newAvg };
      });
    });
    const purchases = [...data.purchases, { ...pur, lines: allocated, extraCosts, createdBy: currentUser?.name }];
    persist({ ...data, materials, purchases });
    setPurchase(null);
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
            <button className="btn-primary" onClick={() => setPurchase(emptyPurchase())} disabled={data.materials.length === 0}>
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
                          return (
                            <div key={l.id} className="num" style={{ fontSize: 11.5 }}>
                              {mat?.name || "—"}: {l.qty} × {fmt(l.landedUnitCost)} ر.ع{l.currency === "AED" ? ` (${fmt(l.unitCostOriginal)} د.إ)` : ""}
                            </div>
                          );
                        })}
                      </td>
                      <td className="num">{fmt(pur.extraCosts.reduce((s, e) => s + (Number(e.amount) || 0), 0))} ر.ع</td>
                      <td>{pur.createdBy && <span className="badge blue">{pur.createdBy}</span>}</td>
                      <td><button className="icon-btn danger" onClick={() => removePurchase(pur.id)}><Trash2 size={13} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>

      {editingMat && <MaterialEditor material={editingMat} onSave={saveMaterial} onClose={() => setEditingMat(null)} />}
      {purchase && <PurchaseEditor purchase={purchase} materials={data.materials} onSave={savePurchase} onClose={() => setPurchase(null)} />}
      <ConfirmModal state={confirmState} onCancel={() => setConfirmState(null)} />
    </div>
  );
}

function MaterialEditor({ material, onSave, onClose }) {
  const [m, setM] = useState(material);
  const isNew = !material.name;
  function set(f, v) { setM({ ...m, [f]: v }); }
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
          <button className="btn-primary" disabled={!m.name.trim()} onClick={() => onSave({ ...m, name: m.name.trim() })}>حفظ</button>
        </div>
      </div>
    </div>
  );
}

function PurchaseEditor({ purchase, materials, onSave, onClose }) {
  const [pur, setPur] = useState(purchase);
  function set(f, v) { setPur({ ...pur, [f]: v }); }
  function setLine(id, f, v) { setPur({ ...pur, lines: pur.lines.map((l) => (l.id === id ? { ...l, [f]: v } : l)) }); }
  function addLine() { setPur({ ...pur, lines: [...pur.lines, { id: uid("pl"), materialId: "", qty: "", unitCost: "", currency: "OMR" }] }); }
  function removeLine(id) { setPur({ ...pur, lines: pur.lines.filter((l) => l.id !== id) }); }
  function setExtra(id, f, v) { setPur({ ...pur, extraCosts: pur.extraCosts.map((e) => (e.id === id ? { ...e, [f]: v } : e)) }); }
  function addExtra() { setPur({ ...pur, extraCosts: [...pur.extraCosts, { id: uid("ec"), label: "", amount: "", currency: "OMR" }] }); }
  function removeExtra(id) { setPur({ ...pur, extraCosts: pur.extraCosts.filter((e) => e.id !== id) }); }

  const validLines = pur.lines.filter((l) => l.materialId && l.qty);
  const allocated = allocatePurchaseLines(convertLinesToOMR(validLines), convertExtrasToOMR(pur.extraCosts));
  const canSave = validLines.length > 0;
  const hasAED = validLines.some((l) => l.currency === "AED") || pur.extraCosts.some((e) => e.currency === "AED");

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>تسجيل عملية شراء</h3><button className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          <div className="form-row">
            <Field label="التاريخ"><input type="date" value={pur.date} onChange={(e) => set("date", e.target.value)} /></Field>
            <Field label="ملاحظة (مثال: رحلة مسقط لجلب المواد)"><input value={pur.note} onChange={(e) => set("note", e.target.value)} /></Field>
          </div>

          <div className="sub-head">المواد المشتراة</div>
          <p className="field-hint" style={{ marginBottom: 8 }}>لو اشتريت بالدرهم الإماراتي، اختر "د.إ" جنب السعر وبيتحول تلقائيًا للريال العماني (1000 د.إ = 105 ر.ع).</p>
          <div className="materials-list">
            {pur.lines.map((l) => {
              const mat = materials.find((m) => m.id === l.materialId);
              return (
                <div className="purchase-line-row" key={l.id}>
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
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>إلغاء</button>
          <button className="btn-primary" disabled={!canSave} onClick={() => onSave(pur)}>حفظ الشراء</button>
        </div>
      </div>
    </div>
  );
}

/* ============================== products ============================== */

function emptyProduct() {
  return {
    id: uid("prod"), code: "", name: "", category: "", type: "manufactured",
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

      {editing && <ProductEditor product={editing} materials={data.materials} onSave={save} onClose={() => setEditing(null)} />}
      <ConfirmModal state={confirmState} onCancel={() => setConfirmState(null)} />
    </div>
  );
}

function ProductEditor({ product, materials, onSave, onClose }) {
  const [p, setP] = useState(product);
  const est = productLiveEstimate(p, materials);
  const price = Number(p.sellingPrice) || 0;
  const margin = price > 0 ? ((price - est.perUnit) / price) * 100 : null;

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
          <button className="btn-primary" disabled={!p.name.trim()} onClick={() => onSave({ ...p, name: p.name.trim() })}>حفظ المنتج</button>
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

  const insufficient = form ? form.lines.filter((l) => {
    const mat = data.materials.find((m) => m.id === l.materialId);
    return mat && (Number(mat.stock) || 0) < (Number(l.qty) || 0);
  }) : [];

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

              {insufficient.length > 0 && (
                <div className="alert-banner" style={{ marginTop: 10 }}>
                  <AlertCircle size={15} />
                  <span>تنبيه: بعض المواد بالمخزون أقل من الكمية المطلوبة، بس تقدر تكمل التسجيل.</span>
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
              <button className="btn-primary" onClick={save}>حفظ الدفعة</button>
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
    items: [{ id: uid("it"), productId: "", qty: 1, unitPrice: "", discount: "", free: false }],
  };
}

function InvoicesTab({ data, persist, onPrint, onPrintPeriod, currentUser }) {
  const [editing, setEditing] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const methods = data.settings.paymentMethods || [];

  function startNew() { setEditing(emptyInvoice(data.nextInvoiceNo, methods[0])); }
  function save(inv) {
    const exists = data.invoices.some((x) => x.id === inv.id);
    const invoices = exists ? data.invoices.map((x) => (x.id === inv.id ? inv : x)) : [...data.invoices, { ...inv, createdBy: currentUser?.name }];
    const nextInvoiceNo = exists ? data.nextInvoiceNo : data.nextInvoiceNo + 1;
    persist({ ...data, invoices, nextInvoiceNo });
    setEditing(null);
  }
  function remove(id) {
    setConfirmState({
      message: "تأكيد حذف الفاتورة؟",
      onConfirm: () => persist({ ...data, invoices: data.invoices.filter((i) => i.id !== id) }),
    });
  }
  function invoiceTotal(inv) { return invoiceComputed(inv).grandTotal; }

  const filtered = data.invoices.filter((inv) => (!dateFrom || inv.date >= dateFrom) && (!dateTo || inv.date <= dateTo));
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
          <div className="panel-head"><h3>فلترة حسب التاريخ (للتسوية البنكية)</h3></div>
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
              <button className="btn-ghost" style={{ marginTop: 12 }} onClick={() => onPrintPeriod({ dateFrom, dateTo, invoices: filtered, total: periodTotal, byMethod })}>
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
                  <button className="icon-btn" onClick={() => onPrint(inv)}><Printer size={15} /></button>
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

  const computed = useMemo(() => invoiceComputed(inv), [inv]);
  const canSave = inv.items.some((it) => it.productId);

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

          {matched && (
            <div className="alert-banner" style={{ background: "#E1F0E7", color: "var(--success)", borderColor: "#BEE0CB" }}>
              <Users size={15} />
              <span>عميل سابق: اشترى {matched.count} مرة قبل كذا، بإجمالي {fmt(matched.total)} ر.ع، آخر شراء بتاريخ {matched.lastDate}</span>
            </div>
          )}

          <div className="sub-head">أصناف الفاتورة</div>
          <p className="field-hint" style={{ marginBottom: 8 }}>لو الصنف هدية مجانية اضغط 🎁، ولو تبيع بسعر التكلفة اضغط "بالتكلفة". الخصم هنا يطبق على هالصنف بس.</p>
          <div className="materials-list">
            {inv.items.map((it) => {
              const lineC = computed.items.find((x) => x.id === it.id) || {};
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
          <button className="btn-primary" disabled={!canSave} onClick={() => onSave(inv)}>حفظ الفاتورة</button>
        </div>
      </div>
    </div>
  );
}

function PrintInvoice({ invoice, data }) {
  const computed = invoiceComputed(invoice);
  return (
    <div className="print-area" dir="rtl">
      <div className="print-head">
        <div><div className="print-brand">SILENT CODE</div><div className="print-sub">فاتورة بيع</div></div>
        <div className="print-meta"><div>رقم الفاتورة: {invoice.number}</div><div>التاريخ: {invoice.date}</div>{invoice.paymentMethod && <div>طريقة الدفع: {invoice.paymentMethod}</div>}</div>
      </div>
      <div className="print-customer">
        <div>العميل: {invoice.customerName || "—"}</div>
        {invoice.customerPhone && <div>الهاتف: {invoice.customerPhone}</div>}
      </div>
      <table className="print-table">
        <thead><tr><th>الصنف</th><th>الكمية</th><th>سعر الوحدة</th><th>خصم</th><th>الإجمالي</th></tr></thead>
        <tbody>
          {computed.items.filter((it) => it.productId).map((it) => {
            const prod = data.products.find((p) => p.id === it.productId);
            return (
              <tr key={it.id}>
                <td>{prod?.name || "—"}{it.free ? " (هدية)" : ""}</td><td>{it.qty}</td><td>{fmt(it.price)}</td>
                <td>{it.lineDiscount ? fmt(it.lineDiscount) : "—"}</td>
                <td>{fmt(it.afterLineDiscount)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="print-totals">
        <div>المجموع: {fmt(computed.subtotal)} ر.ع</div>
        {computed.invoiceDiscountAmount > 0 && <div>خصم الفاتورة: {fmt(computed.invoiceDiscountAmount)} ر.ع</div>}
        <div className="print-total">الإجمالي الكلي: {fmt(computed.grandTotal)} ر.ع</div>
      </div>
      {invoice.note && <div className="print-note">ملاحظات: {invoice.note}</div>}
      <div className="print-foot">شكرًا لتعاملكم معنا</div>
    </div>
  );
}

function PrintPeriodSummary({ period, data }) {
  const { dateFrom, dateTo, invoices, total, byMethod } = period;
  return (
    <div className="print-area" dir="rtl">
      <div className="print-head">
        <div><div className="print-brand">SILENT CODE</div><div className="print-sub">كشف حساب فترة</div></div>
        <div className="print-meta">
          <div>من: {dateFrom || "البداية"}</div>
          <div>إلى: {dateTo || "الآن"}</div>
        </div>
      </div>
      <table className="print-table">
        <thead><tr><th>رقم الفاتورة</th><th>التاريخ</th><th>العميل</th><th>طريقة الدفع</th><th>الإجمالي</th></tr></thead>
        <tbody>
          {[...invoices].sort((a, b) => (a.date < b.date ? -1 : 1)).map((inv) => (
            <tr key={inv.id}>
              <td>#{inv.number}</td>
              <td>{inv.date}</td>
              <td>{inv.customerName || "—"}</td>
              <td>{inv.paymentMethod || "—"}</td>
              <td>{fmt(invoiceComputed(inv).grandTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="print-totals">
        <div className="mini-list-title" style={{ marginTop: 4 }}>التوزيع حسب طريقة الدفع</div>
        {Object.entries(byMethod).map(([method, amt]) => (
          <div key={method}>{method}: {fmt(amt)} ر.ع</div>
        ))}
        <div className="print-total">الإجمالي الكلي: {fmt(total)} ر.ع</div>
      </div>
      <div className="print-foot">عدد الفواتير: {invoices.length}</div>
    </div>
  );
}

/* ============================== customers ============================== */

function CustomersTab({ data }) {
  const [openKey, setOpenKey] = useState(null);
  const customers = useMemo(() => customerStats(data.invoices), [data.invoices]);

  return (
    <div className="page">
      <PageHead eyebrow="المبيعات" title="العملاء" desc="كل عميل اشترى منكم، عدد مرات الشراء، وإجمالي المبيعات — يتحدث تلقائيًا من فواتير البيع" />

      {customers.length === 0 ? (
        <Empty icon={Users} title="ما فيه عملاء بعد" sub="أول ما تسجل فاتورة بيع باسم عميل، بيظهر هنا تلقائيًا." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>العميل</th><th>الهاتف</th><th>عدد مرات الشراء</th><th>إجمالي المشتريات</th><th>آخر شراء</th><th></th></tr></thead>
            <tbody>
              {customers.map((c) => {
                const key = c.name.toLowerCase();
                const open = openKey === key;
                return (
                  <React.Fragment key={key}>
                    <tr>
                      <td className="strong">{c.name}</td>
                      <td>{c.phone || "—"}</td>
                      <td className="num">{c.count}</td>
                      <td className="num">{fmt(c.total)} ر.ع</td>
                      <td>{c.lastDate}</td>
                      <td>
                        <button className="link-btn" onClick={() => setOpenKey(open ? null : key)}>
                          <ChevronLeft size={13} className={`chev ${open ? "open" : ""}`} /> {open ? "إخفاء" : "السجل"}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={6}>
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

function emptyEquipment() { return { id: uid("equip"), date: todayStr(), title: "", qty: 1, cost: "", note: "" }; }

function EquipmentTab({ data, persist, currentUser }) {
  const [form, setForm] = useState(emptyEquipment());
  const [confirmState, setConfirmState] = useState(null);

  function add() {
    if (!form.title.trim() || !form.cost) return;
    persist({ ...data, equipment: [...data.equipment, { ...form, title: form.title.trim(), createdBy: currentUser?.name }] });
    setForm(emptyEquipment());
  }
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
        <div className="panel-head"><h3>إضافة معدة / أصل ثابت</h3></div>
        <div className="form-row four">
          <Field label="اسم العنصر"><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="مثال: قوارير خلط ستانلس" /></Field>
          <Field label="الكمية"><input type="number" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} /></Field>
          <Field label="التكلفة الإجمالية (ر.ع)"><input type="number" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></Field>
          <Field label="التاريخ"><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
        </div>
        <Field label="ملاحظات (اختياري)"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
        <button className="btn-primary" onClick={add} disabled={!form.title.trim() || !form.cost}><Plus size={16} /> إضافة</button>
      </div>

      {data.equipment.length === 0 ? (
        <Empty icon={Wrench} title="ما فيه معدات مسجلة" sub="أضف أول معدة أو أداة من الفورم فوق." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>التاريخ</th><th>العنصر</th><th>الكمية</th><th>التكلفة</th><th>ملاحظات</th><th>بواسطة</th><th></th></tr></thead>
            <tbody>
              {[...data.equipment].reverse().map((e) => (
                <tr key={e.id}>
                  <td>{e.date}</td>
                  <td className="strong">{e.title}</td>
                  <td className="num">{e.qty || "—"}</td>
                  <td className="num">{fmt(e.cost)} ر.ع</td>
                  <td>{e.note}</td>
                  <td>{e.createdBy && <span className="badge green">{e.createdBy}</span>}</td>
                  <td><button className="icon-btn danger" onClick={() => remove(e.id)}><Trash2 size={14} /></button></td>
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
  function add() {
    if (!form.title.trim() || !form.cost) return;
    persist({ ...data, branding: [...data.branding, { ...form, title: form.title.trim(), createdBy: currentUser?.name }] });
    setForm(emptyBranding());
  }
  function remove(id) { persist({ ...data, branding: data.branding.filter((b) => b.id !== id) }); }
  const total = data.branding.reduce((s, b) => s + (Number(b.cost) || 0), 0);

  return (
    <div className="page">
      <PageHead eyebrow="التأسيس" title="تكاليف التأسيس والبراند" desc="شعار، تصميم، ترخيص، اسم تجاري... تكاليف مرة وحدة منفصلة تمامًا عن تكلفة المنتج، تُسترد تدريجيًا من الأرباح" />
      <div className="kpi-row">
        <div className="kpi-card" style={{ "--accent": "#6B4C8C" }}><Building2 size={16} className="kpi-icon" /><div className="kpi-label">إجمالي استثمار التأسيس</div><div className="kpi-value">{fmt(total)} <span className="unit">ر.ع</span></div></div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>إضافة مصروف تأسيسي</h3></div>
        <div className="form-row four">
          <Field label="البند"><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="مثال: تصميم الشعار" /></Field>
          <Field label="التكلفة (ر.ع)"><input type="number" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></Field>
          <Field label="التاريخ"><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
          <Field label="ملاحظات"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
        </div>
        <button className="btn-primary" onClick={add} disabled={!form.title.trim() || !form.cost}><Plus size={16} /> إضافة</button>
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
                  <td><button className="icon-btn danger" onClick={() => remove(b.id)}><Trash2 size={14} /></button></td>
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

function SettingsTab({ data, persist }) {
  const s = data.settings;
  const fileInputRef = useRef(null);
  const [importMsg, setImportMsg] = useState("");
  const [confirmState, setConfirmState] = useState(null);
  function setSettings(next) { persist({ ...data, settings: next }); }

  function addMethod() { setSettings({ ...s, paymentMethods: [...s.paymentMethods, "طريقة جديدة"] }); }
  function editMethod(i, val) { const arr = [...s.paymentMethods]; arr[i] = val; setSettings({ ...s, paymentMethods: arr }); }
  function removeMethod(i) { setSettings({ ...s, paymentMethods: s.paymentMethods.filter((_, idx) => idx !== i) }); }

  function addPartner() { setSettings({ ...s, partners: [...s.partners, { id: uid("partner"), name: "شريك جديد", percent: 0, pin: "1234" }] }); }
  function editPartner(id, field, val) { setSettings({ ...s, partners: s.partners.map((p) => (p.id === id ? { ...p, [field]: val } : p)) }); }
  function removePartner(id) { setSettings({ ...s, partners: s.partners.filter((p) => p.id !== id) }); }

  const partnersSum = s.partners.reduce((sum, p) => sum + (Number(p.percent) || 0), 0);

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
        <div className="panel-head"><h3>الشركاء وتسجيل الدخول</h3><span className="panel-sub">توزيع الباقي بعد نسبة التطوير — المجموع الحالي: {partnersSum}% — نفس الأسماء تظهر بشاشة الدخول</span></div>
        <div className="settings-list">
          {s.partners.map((p) => (
            <div className="partner-row" key={p.id}>
              <input value={p.name} onChange={(e) => editPartner(p.id, "name", e.target.value)} placeholder="الاسم" />
              <input type="number" style={{ maxWidth: 90 }} value={p.percent} onChange={(e) => editPartner(p.id, "percent", e.target.value)} />
              <span className="field-hint">%</span>
              <input value={p.pin || ""} onChange={(e) => editPartner(p.id, "pin", e.target.value)} placeholder="رمز الدخول" style={{ maxWidth: 110 }} />
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
      @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap');
      * { box-sizing: border-box; }
      :root{
        --bg:#F6F2EA; --surface:#FFFFFF; --surface-2:#FBF8F2; --border:#E3DCCB;
        --ink:#22302B; --ink-soft:#6B7770; --teal:#0E6E5B; --teal-dark:#0A4F42;
        --copper:#B9702E; --danger:#B3452F; --success:#1F7A4D;
      }
      .app-shell{ display:flex; min-height:100vh; width:100%; background:var(--bg); color:var(--ink); font-family:'Cairo',sans-serif; direction:rtl; }
      .boot-screen{ display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; height:100vh; background:var(--bg); color:var(--ink-soft); font-family:'Cairo',sans-serif; }
      .spin{ animation: spin 1s linear infinite; color:var(--teal); }
      @keyframes spin{ to{ transform:rotate(360deg); } }

      .sidebar{ width:230px; flex-shrink:0; background:#14231F; color:#E7E2D3; display:flex; flex-direction:column; padding:20px 16px; gap:22px; }
      .brand{ display:flex; align-items:center; gap:10px; }
      .brand-mark{ width:34px; height:34px; border-radius:9px; background:var(--teal); display:flex; align-items:center; justify-content:center; font-weight:800; color:#fff; font-size:16px; }
      .brand-title{ font-weight:700; font-size:14px; }
      .brand-sub{ font-size:11px; color:#9CA89F; }
      .nav{ display:flex; flex-direction:column; gap:4px; overflow-y:auto; }
      .nav-item{ display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:8px; background:transparent; border:none; color:#C9D0C6; font-family:'Cairo'; font-size:13px; cursor:pointer; text-align:right; transition:background .15s; }
      .nav-item:hover{ background:rgba(255,255,255,.06); }
      .nav-item.active{ background:var(--teal); color:#fff; font-weight:600; }
      .sidebar-foot{ margin-top:auto; display:flex; align-items:flex-start; gap:6px; font-size:10.5px; color:#7D8A80; line-height:1.5; padding-top:12px; border-top:1px dashed #2C3B36; }
      .sidebar-user{ margin-top:auto; display:flex; align-items:center; justify-content:space-between; gap:8px; padding-top:12px; border-top:1px solid #2C3B36; }
      .sidebar-user-name{ font-size:12.5px; font-weight:700; color:#E7E2D3; }
      .logout-btn{ background:none; border:1px solid #3A4A44; color:#B8C2BC; font-family:'Cairo'; font-size:10.5px; border-radius:7px; padding:4px 9px; cursor:pointer; }
      .logout-btn:hover{ background:rgba(255,255,255,.06); }

      .login-screen{ min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg); font-family:'Cairo',sans-serif; padding:20px; }
      .login-card{ background:var(--surface); border:1px solid var(--border); border-radius:18px; padding:32px 28px; width:100%; max-width:340px; text-align:center; }
      .login-card h2{ margin:0 0 2px; font-size:19px; font-weight:800; letter-spacing:.5px; }
      .login-brand-sub{ font-size:11px; color:var(--teal); font-weight:600; margin:0 0 14px; }
      .login-sub{ font-size:12.5px; color:var(--ink-soft); margin:0 0 18px; }
      .login-users{ display:flex; flex-direction:column; gap:8px; }
      .login-user-btn{ padding:11px; border-radius:10px; border:1px solid var(--border); background:var(--surface-2); font-family:'Cairo'; font-size:14px; font-weight:600; cursor:pointer; color:var(--ink); }
      .login-user-btn.active{ background:var(--teal); color:#fff; border-color:var(--teal); }
      .login-pin-row{ display:flex; gap:8px; margin-top:14px; }
      .login-pin-row input{ text-align:center; letter-spacing:3px; font-size:16px; }
      .login-error{ color:var(--danger); font-size:12px; margin:10px 0 0; }

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
      .field-hint{ font-size:10px; color:#A3ADA0; }
      input, select, textarea{ font-family:'Cairo'; font-size:13px; padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface-2); color:var(--ink); width:100%; }
      input:focus, select:focus, textarea:focus{ outline:2px solid var(--teal); outline-offset:0; background:#fff; }
      .form-row{ display:flex; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
      .form-row.four > *{ min-width:150px; }
      .sub-head{ font-size:12.5px; font-weight:700; color:var(--ink); margin:16px 0 8px; }

      .materials-list{ display:flex; flex-direction:column; gap:8px; margin-bottom:6px; }
      .material-row{ display:grid; grid-template-columns:1fr 140px 34px; gap:8px; align-items:center; }
      .purchase-line-row{ display:grid; grid-template-columns:1fr 110px 110px 80px 34px; gap:8px; align-items:center; }
      .purchase-extra-row{ display:grid; grid-template-columns:1fr 110px 80px 34px; gap:8px; align-items:center; margin-bottom:6px; }
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

      .print-area{ display:none; }
      @media print{
        .app-shell{ display:none; }
        .print-area{ display:block; direction:rtl; font-family:'Cairo',sans-serif; padding:30px; color:#111; }
        .print-head{ display:flex; justify-content:space-between; border-bottom:2px solid #111; padding-bottom:12px; margin-bottom:16px; }
        .print-brand{ font-weight:800; font-size:20px; }
        .print-sub{ font-size:12px; color:#555; }
        .print-meta{ font-size:12px; text-align:left; }
        .print-customer{ margin-bottom:14px; font-size:13px; }
        .print-table{ width:100%; border-collapse:collapse; margin-bottom:16px; }
        .print-table th, .print-table td{ border:1px solid #999; padding:8px 10px; font-size:12.5px; text-align:right; }
        .print-total{ font-weight:800; font-size:15px; text-align:left; }
        .print-note{ margin-top:10px; font-size:12px; color:#444; }
        .print-foot{ margin-top:30px; text-align:center; font-size:11px; color:#777; }
      }

      @media (max-width:820px){
        .app-shell{ flex-direction:column; }
        .sidebar{ width:100%; flex-direction:row; align-items:center; padding:12px 16px; gap:14px; }
        .nav{ flex-direction:row; overflow-x:auto; }
        .sidebar-foot{ display:none; }
        .content{ padding:18px; }
        .material-row{ grid-template-columns:1fr 100px 30px; }
        .purchase-line-row, .purchase-extra-row{ grid-template-columns:1fr; }
        .invoice-item-row{ grid-template-columns:1fr; }
      }
    `}</style>
  );
}
