import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc } from "firebase/firestore";

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
    settings: {
      paymentMethods: [
        "نقدًا (كاش)",
        "تحويل - حساب الشركة",
        "تحويل - حسابي (سعيد)",
        "تحويل - حساب عبدالله",
        "بوابة دفع إلكتروني",
      ],
      partners: [
        { id: "partner_1", name: "سعيد", percent: 50, pin: "1990" },
        { id: "partner_2", name: "عبدالله", percent: 50, pin: "2525" },
      ],
      devPercent: 50,
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
