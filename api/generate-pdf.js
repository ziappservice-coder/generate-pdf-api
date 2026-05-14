// ============================================================
//  母堂申請表 PDF 產生 API  ─  Vercel Serverless Function
//  直接使用 Google Service Account 呼叫 Docs / Drive API
//  完全不依賴 Google Apps Script
// ============================================================

import { google } from 'googleapis';
import { Readable } from 'stream';

export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // ── API Key 驗證 ───────────────────────────────────────────
  const body       = req.body || {};
  const requestKey = req.headers['x-api-key'] || body.apiKey || '';

  if (process.env.API_KEY && requestKey !== process.env.API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  if (!body.rowID) {
    return res.status(400).json({ success: false, error: 'rowID is required' });
  }

  try {
    // ── Google Auth（Service Account）─────────────────────────
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/documents',
      ],
    });

    const authClient = await auth.getClient();
    const drive      = google.drive({ version: 'v3', auth: authClient });
    const docs       = google.docs({ version: 'v1', auth: authClient });

    const TEMPLATE_DOC_ID  = process.env.TEMPLATE_DOC_ID
                             || '1DNW4JDp5oDw1tPwAr1Z9oMHWrKNyL3p66fxWyWWtSmk';
    const OUTPUT_FOLDER_ID = process.env.OUTPUT_FOLDER_ID || null;

    // ── Step 1：複製範本文件 ───────────────────────────────────
    const masterName = body.Master_Name || 'unknown';
    const timestamp  = new Date()
                       .toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
                       .replace(/[\/:]/g, '-').replace(/\s/g, '_');
    const copyName   = `母堂申請表_${masterName}_${timestamp}`;

    console.log('[1] 複製範本:', TEMPLATE_DOC_ID);
    const copyRes = await drive.files.copy({
      fileId:      TEMPLATE_DOC_ID,
      requestBody: {
        name:    copyName,
        parents: OUTPUT_FOLDER_ID ? [OUTPUT_FOLDER_ID] : undefined,
      },
    });
    const copyId = copyRes.data.id;
    console.log('[1] 副本 ID:', copyId);

    // ── Step 2：批次替換所有 {{佔位符}} ───────────────────────
    const fields = [
      'Paper_Send_Date', 'Unit',    'Temple_NO',
      'Master_Name',     'Master_Male', 'Master_BD', 'Master_TD', 'Master_CD',
      'Sub_Name',        'Sub_Male',    'Sub_BD',    'Sub_TD',    'Sub_CD',
      'Address', 'TEL1', 'TEL2',
      'JOB', 'EDU', 'SKI',
      'Open_Date', 'Open_LY', 'Open_LD',
      'Temple_Area', 'Temple_Name', 'Temple_Name2',
      'ApplyMan', 'TaoMaster', 'TaoMasterLeader', 'Approve_Sign',
      'Vitae', 'Check1', 'Check2',
    ];

    const requests = fields.map(key => ({
      replaceAllText: {
        containsText: { text: `{{${key}}}`, matchCase: true },
        replaceText:  (body[key] !== undefined && body[key] !== null)
                      ? String(body[key]) : '',
      },
    }));

    console.log('[2] 替換', requests.length, '個欄位...');
    await docs.documents.batchUpdate({
      documentId:  copyId,
      requestBody: { requests },
    });

    // ── Step 3：匯出為 PDF（arraybuffer）──────────────────────
    console.log('[3] 匯出 PDF...');
    const pdfRes = await drive.files.export(
      { fileId: copyId, mimeType: 'application/pdf' },
      { responseType: 'arraybuffer' }
    );
    const pdfBuffer = Buffer.from(pdfRes.data);

    // ── Step 4：上傳 PDF 到 Drive ─────────────────────────────
    const pdfName = `${copyName}.pdf`;
    console.log('[4] 上傳 PDF:', pdfName);

    const uploadRes = await drive.files.create({
      requestBody: {
        name:     pdfName,
        mimeType: 'application/pdf',
        parents:  OUTPUT_FOLDER_ID ? [OUTPUT_FOLDER_ID] : undefined,
      },
      media: {
        mimeType: 'application/pdf',
        body:     Readable.from(pdfBuffer),
      },
    });
    const pdfId = uploadRes.data.id;

    // ── Step 5：設定任何人可檢視 ──────────────────────────────
    await drive.permissions.create({
      fileId:      pdfId,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    // ── Step 6：刪除暫存 Google Doc 副本 ──────────────────────
    await drive.files.delete({ fileId: copyId });
    console.log('[5] 暫存文件已刪除');

    // ── 組合回傳結果 ───────────────────────────────────────────
    const result = {
      success:     true,
      fileId:      pdfId,
      fileName:    pdfName,
      downloadUrl: `https://drive.google.com/uc?export=download&id=${pdfId}`,
      viewUrl:     `https://drive.google.com/file/d/${pdfId}/view`,
      directUrl:   `https://drive.google.com/uc?id=${pdfId}`,
    };

    // ── Step 7：回寫 Glide ────────────────────────────────────
    console.log('[6] 回寫 Glide, rowID:', body.rowID);
    const glideRes = await fetch(
      'https://api.glideapp.io/api/function/mutateTables',
      {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${process.env.GLIDE_API_TOKEN}`,
        },
        body: JSON.stringify({
          appID: process.env.GLIDE_APP_ID,
          mutations: [{
            kind:      'set-columns-in-row',
            tableName: process.env.GLIDE_TABLE_NAME,
            rowID:     body.rowID,
            columnValues: {
              genApplyPDF: result.downloadUrl,
              APIResponse: JSON.stringify(result),
            },
          }],
        }),
      }
    );

    console.log('[6] Glide 回應:', glideRes.status, await glideRes.text());

    return res.status(200).json({ ...result, glideWritten: glideRes.ok });

  } catch (err) {
    console.error('[致命錯誤]', err.message);
    console.error(err.stack);
    return res.status(500).json({ success: false, error: err.message });
  }
}
