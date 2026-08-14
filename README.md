# SILENT CODE - محاسبة المصنع

برنامج محاسبة التصنيع والتغليف، مبني بـ React ومتصل بـ Firebase Firestore
لتخزين دائم لا يتأثر أبدًا بتحديثات الكود.

## رفع المشروع على GitHub

1. سوّي مستودع (Repository) جديد فاضي على github.com (زر "New").
2. اضغط "Add file" → "Upload files"، واسحب كل محتويات هذا المجلد (بما فيها مجلد `src`).
3. اضغط "Commit changes".

## ربطه بـ Vercel

1. من لوحة Vercel، اضغط "Add New" → "Project".
2. اختر نفس المستودع اللي رفعته على GitHub.
3. Vercel يكتشف تلقائيًا إنه مشروع Vite + React، ما تحتاج تغيّر أي إعداد.
4. اضغط "Deploy" وانتظر دقيقة، بيعطيك رابط ثابت.

## قواعد أمان Firestore

من Firebase Console → Firestore Database → Rules، الصق محتوى ملف
`firestore.rules` الموجود بهذا المجلد، واضغط "Publish".

## أي تحديث مستقبلي

عدّل الملف المطلوب مباشرة من واجهة GitHub (زر القلم Edit)، اضغط
"Commit changes"، و Vercel ينشر النسخة الجديدة تلقائيًا خلال دقيقة
تقريبًا - بدون ما يتأثر الرابط ولا البيانات المخزنة بـ Firestore.
