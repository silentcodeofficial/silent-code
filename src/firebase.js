import { initializeApp } from "firebase/app";
import { initializeFirestore, doc, getDoc, setDoc, collection, getDocs, runTransaction } from "firebase/firestore";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  onAuthStateChanged,
} from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCSQ5xxXI5xl2HJ8C2GSRqB0OhHBKR0plo",
  authDomain: "silent-code-oman.firebaseapp.com",
  projectId: "silent-code-oman",
  storageBucket: "silent-code-oman.firebasestorage.app",
  messagingSenderId: "814923526759",
  appId: "1:814923526759:web:6190c334cc037859abdac2",
};

const app = initializeApp(firebaseConfig);
// ignoreUndefinedProperties: أي حقل فاضي (undefined) ما يفشّل الحفظ بصمت
export const db = initializeFirestore(app, { ignoreUndefinedProperties: true });
export const auth = getAuth(app);

export function watchAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function signIn(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
  return cred.user;
}

export async function signOutUser() {
  await signOut(auth);
}

export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email.trim());
}

// Each top-level data category lives in its own Firestore document,
// so no single document ever approaches Firestore's 1MB-per-document limit.
const LIST_KEYS = [
  "materials",
  "products",
  "invoices",
  "purchases",
  "batches",
  "marketing",
  "losses",
  "branding",
  "equipment",
  "bankTxns",
  "expenses",
  "auditLog",
];

export function defaultAppData() {
  return {
    materials: [],
    products: [],
    invoices: [],
    purchases: [],
    batches: [],
    marketing: [],
    losses: [],
    branding: [],
    equipment: [],
    bankTxns: [],
    expenses: [],
    auditLog: [],
    settings: {
      paymentMethods: [
        "نقدًا (كاش)",
        "تحويل - حساب الشركة",
        "تحويل - حسابي (سعيد)",
        "تحويل - حساب عبدالله",
        "بوابة دفع إلكتروني",
        "ثواني - POS",
        "ثواني - رابط دفع",
        "تحويل بنكي - صحار",
      ],
      partners: [
        { id: "partner_1", name: "سعيد", percent: 50, email: "" },
        { id: "partner_2", name: "عبدالله", percent: 50, email: "" },
      ],
      devPercent: 50,
      businessInfo: { phone: "", address: "", instagram: "", note: "" },
    },
    nextInvoiceNo: 1001,
    nextPurchaseNo: 1001,
  };
}

export async function loadAppData() {
  const result = defaultAppData();
  for (const key of LIST_KEYS) {
    const snap = await getDoc(doc(db, "app", key));
    if (snap.exists() && Array.isArray(snap.data().list)) {
      result[key] = snap.data().list;
    }
  }
  const metaSnap = await getDoc(doc(db, "app", "meta"));
  if (metaSnap.exists()) {
    const meta = metaSnap.data();
    if (meta.settings) result.settings = meta.settings;
    if (meta.nextInvoiceNo) result.nextInvoiceNo = meta.nextInvoiceNo;
    if (meta.nextPurchaseNo) result.nextPurchaseNo = meta.nextPurchaseNo;
  }
  return result;
}

// دمج آمن: نطبّق فقط "تغييراتي أنا" (إضافة / تعديل / حذف حسب رقم السجل) فوق أحدث نسخة موجودة في السيرفر،
// بدل ما نكتب القائمة كاملة ونمسح تعديلات الشريك الثاني. يتم داخل Transaction عشان ما يضيع شي لو حفظ الاثنين بنفس اللحظة.
function hasIds(l) { return Array.isArray(l) && l.every((x) => x && typeof x === "object" && x.id != null); }

export function mergeList(remote, prev, next) {
  const pm = new Map((prev || []).map((x) => [x.id, JSON.stringify(x)]));
  const nm = new Map(next.map((x) => [x.id, x]));
  const removed = new Set();
  (prev || []).forEach((x) => { if (!nm.has(x.id)) removed.add(x.id); });
  const changed = new Map();
  next.forEach((x) => { if (pm.get(x.id) !== JSON.stringify(x)) changed.set(x.id, x); });
  const out = [];
  const seen = new Set();
  (remote || []).forEach((x) => {
    if (removed.has(x.id)) return;
    out.push(changed.has(x.id) ? changed.get(x.id) : x);
    seen.add(x.id);
  });
  changed.forEach((x, id) => { if (!seen.has(id)) out.push(x); });
  return out;
}

export function mergeSettings(remote, prev, next) {
  const out = { ...(remote || {}) };
  const keys = new Set([...Object.keys(next || {}), ...Object.keys(prev || {})]);
  keys.forEach((k) => {
    if (JSON.stringify((prev || {})[k]) !== JSON.stringify((next || {})[k])) {
      if ((next || {})[k] === undefined) delete out[k]; else out[k] = next[k];
    }
  });
  return out;
}

// replace=true: استبدال كامل (للاستعادة من نسخة احتياطية فقط)
export async function saveAppData(prev, next, opts = {}) {
  const merged = { ...next };
  const replace = !!opts.replace;
  for (const key of LIST_KEYS) {
    const prevVal = prev ? prev[key] : undefined;
    if (JSON.stringify(prevVal) === JSON.stringify(next[key])) continue;
    const ref = doc(db, "app", key);
    if (replace || !hasIds(next[key]) || (prev && !hasIds(prev[key] || []))) {
      await setDoc(ref, { list: next[key] });
      continue;
    }
    merged[key] = await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const remote = snap.exists() && Array.isArray(snap.data().list) ? snap.data().list : [];
      const list = hasIds(remote) ? mergeList(remote, prevVal || [], next[key]) : next[key];
      tx.set(ref, { list });
      return list;
    });
  }
  const prevMeta = prev ? { settings: prev.settings, nextInvoiceNo: prev.nextInvoiceNo, nextPurchaseNo: prev.nextPurchaseNo } : undefined;
  const nextMeta = { settings: next.settings, nextInvoiceNo: next.nextInvoiceNo, nextPurchaseNo: next.nextPurchaseNo };
  if (JSON.stringify(prevMeta) !== JSON.stringify(nextMeta)) {
    const ref = doc(db, "app", "meta");
    if (replace || !prevMeta) {
      await setDoc(ref, nextMeta);
    } else {
      const m = await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const r = snap.exists() ? snap.data() : {};
        const out = {
          settings: mergeSettings(r.settings, prevMeta.settings, nextMeta.settings),
          nextInvoiceNo: Math.max(Number(r.nextInvoiceNo) || 0, Number(nextMeta.nextInvoiceNo) || 0),
          nextPurchaseNo: Math.max(Number(r.nextPurchaseNo) || 0, Number(nextMeta.nextPurchaseNo) || 0),
        };
        tx.set(ref, out);
        return out;
      });
      merged.settings = m.settings;
      merged.nextInvoiceNo = m.nextInvoiceNo;
      merged.nextPurchaseNo = m.nextPurchaseNo;
    }
  }
  return merged;
}

/* ---- automatic daily backups: stored in their own "backups" collection,
   one document per category per day (same split-by-category approach as the
   live data, so a backup can never approach Firestore's 1MB document limit).
   Backups are pure snapshots that are only ever ADDED, never modified or
   auto-deleted — your live data is never touched by this. ---- */

function todayDateStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export async function ensureDailyBackup(data) {
  try {
    const today = todayDateStr();
    const markerId = `${today}_meta`;
    const markerSnap = await getDoc(doc(db, "backups", markerId));
    if (markerSnap.exists()) return; // already backed up today, nothing to do

    const writes = LIST_KEYS.map((key) =>
      setDoc(doc(db, "backups", `${today}_${key}`), { list: data[key] || [] })
    );
    writes.push(
      setDoc(doc(db, "backups", markerId), {
        createdAt: today,
        settings: data.settings,
        nextInvoiceNo: data.nextInvoiceNo,
        nextPurchaseNo: data.nextPurchaseNo,
      })
    );
    await Promise.all(writes);
  } catch (e) {
    console.error("backup error", e);
  }
}

export async function listBackupDates() {
  const snap = await getDocs(collection(db, "backups"));
  const dates = new Set();
  snap.forEach((d) => {
    if (d.id.endsWith("_meta")) dates.add(d.id.replace("_meta", ""));
  });
  return [...dates].sort().reverse(); // newest first
}

export async function loadBackup(dateStr) {
  const result = defaultAppData();
  for (const key of LIST_KEYS) {
    const snap = await getDoc(doc(db, "backups", `${dateStr}_${key}`));
    if (snap.exists() && Array.isArray(snap.data().list)) {
      result[key] = snap.data().list;
    }
  }
  const metaSnap = await getDoc(doc(db, "backups", `${dateStr}_meta`));
  if (metaSnap.exists()) {
    const meta = metaSnap.data();
    if (meta.settings) result.settings = meta.settings;
    if (meta.nextInvoiceNo) result.nextInvoiceNo = meta.nextInvoiceNo;
    if (meta.nextPurchaseNo) result.nextPurchaseNo = meta.nextPurchaseNo;
  }
  return result;
}
