/* ---- Google Drive integration for purchase invoice attachments.
   Uses Google Identity Services (GIS) for OAuth in the browser (no backend
   needed) and the Drive v3 REST API to upload files with the narrow
   "drive.file" scope, which only ever grants access to files this app
   itself creates - never the rest of your Drive. ---- */

const GOOGLE_CLIENT_ID = "413008960937-7s9v68r3f9oabe73289c74cgpup2173d.apps.googleusercontent.com";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const INVOICE_FOLDER_NAME = "فواتير الشراء - SILENT CODE";

let cachedAccessToken = null;
let tokenExpiryMs = 0;
let gisLoadPromise = null;
let cachedFolderId = null;

function loadGoogleIdentityScript() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoadPromise) return gisLoadPromise;
  gisLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("تعذّر تحميل مكتبة تسجيل دخول Google"));
    document.head.appendChild(script);
  });
  return gisLoadPromise;
}

export async function getGoogleAccessToken() {
  await loadGoogleIdentityScript();
  if (cachedAccessToken && Date.now() < tokenExpiryMs) return cachedAccessToken;
  return new Promise((resolve, reject) => {
    try {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: DRIVE_SCOPE,
        callback: (resp) => {
          if (resp.error) {
            reject(new Error(resp.error));
            return;
          }
          cachedAccessToken = resp.access_token;
          tokenExpiryMs = Date.now() + (Number(resp.expires_in) - 60) * 1000;
          resolve(cachedAccessToken);
        },
      });
      client.requestAccessToken();
    } catch (e) {
      reject(e);
    }
  });
}

async function getOrCreateInvoiceFolder(token) {
  if (cachedFolderId) return cachedFolderId;

  const query = encodeURIComponent(
    `name='${INVOICE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (searchRes.ok) {
    const found = await searchRes.json();
    if (found.files && found.files.length > 0) {
      cachedFolderId = found.files[0].id;
      return cachedFolderId;
    }
  }

  const createRes = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: INVOICE_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  if (!createRes.ok) throw new Error("تعذّر إنشاء مجلد الفواتير بـ Google Drive");
  const created = await createRes.json();
  cachedFolderId = created.id;
  return cachedFolderId;
}

export async function uploadToGoogleDrive(fileName, blob) {
  const token = await getGoogleAccessToken();
  const folderId = await getOrCreateInvoiceFolder(token);
  const metadata = { name: fileName, mimeType: blob.type || "application/pdf", parents: [folderId] };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", blob);

  const uploadRes = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form }
  );
  if (!uploadRes.ok) throw new Error("فشل رفع الملف لـ Google Drive");
  const uploaded = await uploadRes.json();
  const fileId = uploaded.id;

  // Make the file viewable by anyone who has the link (not searchable/public listing).
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });

  return { fileId, url: `https://drive.google.com/file/d/${fileId}/view` };
}

export async function deleteFromGoogleDrive(fileId) {
  try {
    const token = await getGoogleAccessToken();
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    console.error("google drive delete error", e);
  }
}
