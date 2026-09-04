import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, collection, getDocs } from "firebase/firestore";
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
export const db = getFirestore(app);
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
  "notifications",
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
    notifications: [],
    settings: {
      paymentMethods: [
        "نقدًا (كاش)",
        "تحويل - حساب الشركة",
        "تحويل - حسابي (سعيد)",
        "تحويل - حساب عبدالله",
        "بوابة دفع إلكتروني",
      ],
      partners: [
        { id: "partner_1", name: "سعيد", percent: 50, email: "" },
        { id: "partner_2", name: "عبدالله", percent: 50, email: "" },
      ],
      devPercent: 50,
      businessInfo: { phone: "", address: "", instagram: "", note: "" },
      // running bank-balance baseline: once set, the dashboard adds every
      // invoice dated after `setAt` and subtracts every expense dated after
      // `setAt`, so the displayed balance always stays live without anyone
      // having to touch this number by hand.
      bankBalance: { amount: null, setAt: "", setBy: "" },
      // a change request waiting on the *other* partner's approval; null
      // when there is nothing pending.
      pendingBalanceRequest: null,
    },
    nextInvoiceNo: 1001,
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
  }
  return result;
}

export async function saveAppData(prev, next) {
  const writes = [];
  for (const key of LIST_KEYS) {
    const prevVal = prev ? prev[key] : undefined;
    if (JSON.stringify(prevVal) !== JSON.stringify(next[key])) {
      writes.push(setDoc(doc(db, "app", key), { list: next[key] }));
    }
  }
  const prevMeta = prev ? { settings: prev.settings, nextInvoiceNo: prev.nextInvoiceNo } : undefined;
  const nextMeta = { settings: next.settings, nextInvoiceNo: next.nextInvoiceNo };
  if (JSON.stringify(prevMeta) !== JSON.stringify(nextMeta)) {
    writes.push(setDoc(doc(db, "app", "meta"), nextMeta));
  }
  await Promise.all(writes);
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
  }
  return result;
}
